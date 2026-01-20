// ГЛОБАЛЬНЫЕ ФУНКЦИИ (Для работы из HTML-атрибутов onclick)
window.closeChat = function() {
    const cw = document.getElementById('chat-window');
    if(cw) cw.classList.add('empty');
    if(window.socket && window.currentRoom) window.socket.emit('typing_event', {room: window.currentRoom, state: 'stop'});
    window.currentRoom = null;
    window.currentRoomData = {};
};

window.showUserProfile = null;
window.openChat = null; 

// HELPER: Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', () => {
    
    // 1. НАДЕЖНОЕ ЧТЕНИЕ ДАННЫХ
    const appData = document.getElementById('app-data');
    const userData = {
        username: appData?.dataset.username || '',
        nickname: appData?.dataset.nickname || '',
        handle: appData?.dataset.handle || '',
        color: appData?.dataset.color || '#555',
        emoji: appData?.dataset.emoji || '👤',
        bio: appData?.dataset.bio || '',
        tags: [],
        tempColor: null,
        tempEmoji: null
    };
    try {
        const tagsStr = appData?.dataset.tags;
        if(tagsStr && tagsStr !== 'None') userData.tags = JSON.parse(tagsStr);
    } catch(e) { console.error("Tags parse error:", e); }

    console.log("USER DATA LOADED:", userData);

    // 2. ИНИЦИАЛИЗАЦИЯ
    const socket = io();
    window.socket = socket; 
    const processedMsgIds = new Set();
    let unreadCounts = {};
    window.currentRoom = null; 
    let currentRoomData = {};
    window.currentRoomData = currentRoomData; 
    let replyData = null;
    let allUsersCache = []; 

    // 3. АНИМАЦИИ
    try {
        document.querySelector('.nav')?.classList.add('anim-nav');
        document.querySelectorAll('.anim-nav-btn').forEach((btn, i) => {
            btn.style.opacity = '0'; btn.style.animation = `slideInIcon 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards ${0.5 + (i * 0.1)}s`;
        });
        const wt = document.getElementById('welcome-text');
        if (wt && wt.textContent.trim()) {
             const t = wt.textContent.trim(); wt.textContent = '';
             [...t].forEach((c, i) => {
                 const s = document.createElement('span'); s.textContent = c === ' ' ? '\u00A0' : c; s.className = 'anim-letter';
                 s.style.animation = `flyLetter 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) forwards ${0.6 + i*0.03}s`;
                 wt.appendChild(s);
             });
        }
        const st = document.getElementById('subtitle-text');
        if(st) { st.classList.add('anim-block-fly'); st.style.animationDelay = '1.0s'; }
    } catch(e) { console.warn("Animation failed", e); }

    // 4. ХЕЛПЕРЫ (Теги, Счетчик)
    function getTagsHtml(tags) {
        if (!tags || !Array.isArray(tags)) return '';
        tags.sort((a,b) => (b.is_special ? 1 : 0) - (a.is_special ? 1 : 0));
        let html = '';
        tags.forEach(t => {
            if (t.is_special) {
                let icon = 'fa-star'; let cls = '';
                if (t.name === 'Verified') { icon = 'fa-check-circle'; cls = 'verified'; }
                else if (t.name === 'Developer') { icon = 'fa-hammer'; cls = 'dev'; }
                else if (t.emoji) icon = `fa-${t.emoji}`;
                html += `<span class="badge ${cls}" title="${t.name}"><i class="fas ${icon}"></i></span>`;
            }
        });
        return html;
    }
    function getPillsHtml(tags) {
        if (!tags || !Array.isArray(tags)) return '';
        let html = '';
        tags.forEach(t => { if (!t.is_special) html += `<div class="tag-pill"><span>${t.emoji || ''}</span> ${t.name}</div>`; });
        return html;
    }
    function updateUnread() {
        const total = Object.values(unreadCounts).reduce((a,b)=>a+b,0);
        const b = document.getElementById('total-unread');
        if(total > 0) { b.textContent = total > 99 ? '99+' : total; b.style.display = 'block'; }
        else b.style.display = 'none';
    }

    // 5. РЕАЛИЗАЦИЯ ГЛОБАЛЬНЫХ ФУНКЦИЙ
    window.showUserProfile = async (username) => {
        if(!username) return;
        try {
            const res = await fetch(`/api/profile/${username}`); 
            const d = await res.json();
            if (d.success) {
                const p = d.profile; const tags = d.tags;
                document.getElementById('user-view-nickname').innerHTML = `${p.nickname} ${getTagsHtml(tags)}`;
                document.getElementById('user-view-tags').innerHTML = getPillsHtml(tags);
                document.getElementById('user-view-handle').textContent = `@${p.handle}`;
                document.getElementById('user-view-bio').textContent = p.bio || 'Нет информации';
                const ava = document.getElementById('user-view-avatar'); 
                ava.style.backgroundColor = p.avatar_color; 
                ava.textContent = p.avatar_emoji;
                document.getElementById('view-user-modal').classList.add('open');
                window.viewedProfileData = { ...p, username, tags };
            }
        } catch(e) { console.error("Profile load error", e); }
    };

    window.openChat = (room, data) => {
        console.log("OPENING CHAT:", room, data);
        document.getElementById('chat-window').classList.remove('empty');
        window.currentRoom = room;
        socket.emit('join', {room: room}); 
        
        if (room === '#Global') currentRoomData = { nickname: 'Общий чат', type: 'global', tags:[] };
        else currentRoomData = data;
        window.currentRoomData = currentRoomData; 

        document.getElementById('chat-title').innerHTML = `${currentRoomData.nickname || currentRoomData.name} ${getTagsHtml(currentRoomData.tags)}`;
        document.getElementById('msgs').innerHTML = '';
        
        const actualAva = document.getElementById('header-avatar');
        const actualInfo = document.getElementById('header-info-box');
        
        actualAva.removeEventListener('click', actualAva.boundClickHandler);
        actualInfo.removeEventListener('click', actualInfo.boundClickHandler);
        
        if (room !== '#Global') {
            actualAva.style.display = 'flex'; 
            actualAva.style.backgroundColor = currentRoomData.avatar_color; 
            actualAva.querySelector('span').textContent = currentRoomData.avatar_emoji;
            
            if (currentRoomData.type !== 'group') {
                socket.emit('join_dm', {username: currentRoomData.username});
                document.getElementById('chat-status').textContent = ' • Cloud Chat';
                
                actualAva.boundClickHandler = (e) => { e.stopPropagation(); window.showUserProfile(currentRoomData.username); };
                actualInfo.boundClickHandler = (e) => { e.stopPropagation(); window.showUserProfile(currentRoomData.username); };
                actualAva.addEventListener('click', actualAva.boundClickHandler);
                actualInfo.addEventListener('click', actualInfo.boundClickHandler);
                
                actualAva.style.cursor = 'pointer'; actualInfo.style.cursor = 'pointer';
            } else {
                document.getElementById('chat-status').textContent = ' • Группа';
                actualAva.onclick = null; actualInfo.onclick = null;
                actualAva.style.cursor = 'default'; actualInfo.style.cursor = 'default';
            }
        } else { 
            actualAva.style.display = 'none'; 
            document.getElementById('chat-status').textContent = 'Общий чат'; 
            actualAva.onclick = null; 
            actualInfo.onclick = null; 
        }

        unreadCounts[room] = 0; updateUnread();
        socket.emit('request_history', {room: room});
    };

    // 6. ОСНОВНАЯ ЛОГИКА
    const navIndicator = document.getElementById('nav-indicator');
    function moveIndicator(targetBtn) {
        if(!targetBtn || !navIndicator) return;
        const navRect = document.querySelector('.nav').getBoundingClientRect();
        const btnRect = targetBtn.getBoundingClientRect();
        const top = (btnRect.top - navRect.top) + (btnRect.height / 2) - 15; 
        navIndicator.style.top = `${top}px`;
    }
    const initialActive = document.querySelector('.nav-btn.active');
    if(initialActive) setTimeout(() => moveIndicator(initialActive), 100);

    document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            moveIndicator(btn);
            document.querySelectorAll('.app-tab').forEach(l => l.style.display = 'none');
            const target = document.getElementById(`tab-${btn.dataset.tab}`);
            if(target) target.style.display = 'flex';
            if(btn.dataset.tab === 'chats') loadChats(); 
        };
    });
    
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button, .nav-btn, .nav-avatar, .item, .send-btn, .color-opt, .icon-btn, .fa-plus');
        if (btn) { btn.classList.remove('pop-anim'); void btn.offsetWidth; btn.classList.add('pop-anim'); }
    });

    function loadChats() {
        fetch('/api/chats').then(r=>r.json()).then(data => {
            const cc = document.getElementById('chat-list-container'); cc.innerHTML = '';
            const uc = document.getElementById('user-list'); uc.innerHTML = '';
            allUsersCache = data.users;
            data.chats.forEach(c => cc.appendChild(createItem(c)));
            data.users.forEach(u => { if (!data.chats.find(c => c.room === u.room)) uc.appendChild(createItem({...u, type: 'dm'})); });
        });
    }

    function createItem(d) {
        const el = document.createElement('div'); el.className = 'item'; el.dataset.room = d.room;
        const tagsH = getTagsHtml(d.tags);
        el.innerHTML = `<div class="ava" style="background:${d.avatar_color}">${d.avatar_emoji}</div><div class="chat-info"><span>${d.name||d.nickname} ${tagsH}</span><small>${d.last_msg||''}</small></div><span class="item-badge"></span>`;
        el.onclick = () => window.openChat(d.room, d);
        return el;
    }

    // ФУНКЦИЯ addMsg
    function addMsg(d) {
        if (!d || !d.content) { 
            console.warn("Skipping empty message:", d); 
            return; 
        }
        
        const list = document.getElementById('msgs');
        if (!list) {
            console.error("msgs container not found!");
            return;
        }

        const row = document.createElement('div'); 
        const isSelf = d.sender_username === userData.username;
        row.className = `msg-row ${isSelf ? 'self' : 'other'}`;
        
        let nameHtml = '';
        if (!isSelf && (window.currentRoom === '#Global' || currentRoomData.type === 'group')) {
            const senderTags = d.sender_tags || [];
            const escapedUsername = escapeHtml(d.sender_username);
            const escapedNickname = escapeHtml(d.sender_nickname || 'User');
            nameHtml = `<div style="font-size:0.7rem;font-weight:bold;margin-bottom:3px;color:#bbb;display:flex;align-items:center; cursor:pointer;" 
                onclick="window.showUserProfile('${escapedUsername}')">
                ${escapedNickname} ${getTagsHtml(senderTags)}
            </div>`;
        }
        
        let replyHtml = '';
        if (d.reply_content) {
            const escapedReplyNickname = escapeHtml(d.reply_nickname || 'Unknown');
            const escapedReplyContent = escapeHtml(d.reply_content);
            replyHtml = `<div class="reply-ref"><b>${escapedReplyNickname}</b>: ${escapedReplyContent}</div>`;
        }
        
        if(!isSelf) {
            const ava = document.createElement('div'); 
            ava.className = 'msg-ava';
            ava.style.backgroundColor = d.sender_avatar_color || '#444'; 
            ava.textContent = d.sender_avatar_emoji || '👤';
            ava.onclick = () => window.showUserProfile(d.sender_username);
            ava.style.cursor = 'pointer';
            row.appendChild(ava);
        }
        
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        
        const timestamp = d.timestamp || Date.now() / 1000;
        const time = new Date(timestamp * 1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        
        // Create elements safely without innerHTML for user content
        if (replyHtml) {
            const replyDiv = document.createElement('div');
            replyDiv.innerHTML = replyHtml;
            bubble.appendChild(replyDiv);
        }
        
        if (nameHtml) {
            const nameDiv = document.createElement('div');
            nameDiv.innerHTML = nameHtml;
            bubble.appendChild(nameDiv);
        }
        
        const contentDiv = document.createElement('div');
        contentDiv.textContent = d.content; // Use textContent to prevent XSS
        bubble.appendChild(contentDiv);
        
        const metaDiv = document.createElement('div');
        metaDiv.className = 'msg-meta';
        const timeSpan = document.createElement('span');
        timeSpan.textContent = time;
        metaDiv.appendChild(timeSpan);
        bubble.appendChild(metaDiv);
        
        const replyBtn = document.createElement('button'); 
        replyBtn.className = 'reply-btn'; 
        replyBtn.innerHTML = '<i class="fas fa-reply"></i>';
        replyBtn.onclick = () => {
            replyData = {
                content: d.content.substring(0,50) + '...', 
                nickname: d.sender_nickname, 
                id: d.message_id
            };
            document.getElementById('reply-bar').style.display = 'flex';
            document.getElementById('reply-nick').textContent = d.sender_nickname;
            document.getElementById('reply-content').textContent = replyData.content;
        };
        bubble.querySelector('.msg-meta').appendChild(replyBtn);

        row.appendChild(bubble);
        list.appendChild(row);
        list.scrollTop = list.scrollHeight;
    }

    // SEND & TYPING
    async function sendMessage() {
        const inp = document.getElementById('msg-input');
        const content = inp.value.trim();
        if(!content || !window.currentRoom) return;
        
        const p = {room: window.currentRoom, content};
        if(replyData) { 
            p.reply_content = replyData.content; 
            p.reply_nickname = replyData.nickname; 
            p.reply_to_id = replyData.id; 
        }
        socket.emit('send_message', p);
        inp.value = ''; 
        replyData = null; 
        document.getElementById('reply-bar').style.display = 'none';
    }
    
    document.getElementById('send-btn').onclick = sendMessage;
    document.getElementById('msg-input').addEventListener('keypress', e => { 
        if(e.key === 'Enter') sendMessage(); 
    });
    
    // TYPING
    const msgInput = document.getElementById('msg-input');
    let isTyping = false; 
    let pauseTimer = null;
    msgInput.addEventListener('input', () => {
        if (window.currentRoom === '#Global' || !window.currentRoom) return;
        if (msgInput.value.length > 0) {
            if (!isTyping) { 
                isTyping = true; 
                socket.emit('typing_event', {room: window.currentRoom, state: 'typing'}); 
            }
            if (pauseTimer) clearTimeout(pauseTimer);
            pauseTimer = setTimeout(() => socket.emit('typing_event', {room: window.currentRoom, state: 'paused'}), 800);
        } else {
            isTyping = false;
            if (pauseTimer) clearTimeout(pauseTimer);
            socket.emit('typing_event', {room: window.currentRoom, state: 'stop'});
        }
    });
    
    socket.on('display_typing', (data) => {
        if (data.room !== window.currentRoom || data.username === userData.username) return;
        const existing = document.getElementById('typing-row');
        if (data.state === 'stop' || data.state === 'paused') { 
            if(existing) existing.remove(); 
        } else {
            if (!existing) {
                const row = document.createElement('div'); 
                row.id = 'typing-row'; 
                row.className = 'msg-row other';
                row.innerHTML = `<div class="typing-bubble"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
                document.getElementById('msgs').appendChild(row);
                document.getElementById('msgs').scrollTop = document.getElementById('msgs').scrollHeight;
            }
        }
    });

    // SOCKET LISTENERS
    socket.on('connect', () => {
        console.log("Socket connected!");
    });

    socket.on('new_message', d => {
        if(processedMsgIds.has(d.message_id)) return;
        processedMsgIds.add(d.message_id);
        
        if(d.room !== window.currentRoom) {
            unreadCounts[d.room] = (unreadCounts[d.room] || 0) + 1;
            updateUnread();
        } else {
            addMsg(d);
        }
    });
    
    socket.on('message_history', d => { 
        if(d.room === window.currentRoom && d.messages) {
            d.messages.forEach(addMsg);
        }
    });
    
    socket.on('force_disconnect', d => { 
        if(d.username === userData.username) location.reload(); 
    });

    // ===== ИСПРАВЛЕННЫЙ РАЗДЕЛ ПРОФИЛЯ =====
    
    // Функция инициализации пикеров
    function initPopPickers() {
        const cc = document.getElementById('pop-color-picker'); 
        const ec = document.getElementById('pop-emoji-picker');
        const THEME_COLORS = ['#007aff', '#34c759', '#ff3b30', '#af52de', '#ff9500', '#5856d6'];
        const EMOJIS = ['😀','😎','👽','🤖','👻','🐱','🦊','🐸','🚀','🔥'];
        
        if(cc && cc.children.length === 0) {
            THEME_COLORS.forEach(c => { 
                const d = document.createElement('div'); 
                d.style.backgroundColor = c; 
                d.onclick = () => { 
                    userData.tempColor = c; 
                    const previewAva = document.getElementById('edit-preview-ava');
                    if(previewAva) previewAva.style.backgroundColor = c;
                    console.log("Color selected:", c);
                }; 
                cc.appendChild(d); 
            });
            
            EMOJIS.forEach(e => { 
                const d = document.createElement('div'); 
                d.textContent = e; 
                d.onclick = () => { 
                    userData.tempEmoji = e; 
                    const previewAva = document.getElementById('edit-preview-ava');
                    if(previewAva) previewAva.textContent = e;
                    console.log("Emoji selected:", e);
                }; 
                ec.appendChild(d); 
            });
            
            const tp = document.getElementById('theme-picker');
            if(tp) {
                THEME_COLORS.forEach(c => { 
                    const d = document.createElement('div'); 
                    d.style.backgroundColor = c; 
                    d.onclick = () => document.documentElement.style.setProperty('--primary', c); 
                    tp.appendChild(d); 
                });
            }
        }
    }

    // Открытие попапа профиля
    document.getElementById('my-avatar-btn').onclick = (e) => {
        e.stopPropagation();
        const pop = document.getElementById('profile-popover');
        if(pop.style.display === 'block') {
            pop.style.display = 'none';
        } else {
            pop.classList.add('open'); 
            pop.style.display = 'block';
            
            // Показываем режим просмотра
            document.getElementById('popover-view').style.display = 'block';
            document.getElementById('popover-edit').style.display = 'none';
            
            // Заполняем данные
            document.getElementById('pop-tags').innerHTML = getPillsHtml(userData.tags);
            document.getElementById('pop-nick').innerHTML = `${userData.nickname} ${getTagsHtml(userData.tags)}`;
            document.getElementById('pop-bio').textContent = userData.bio || 'Нет статуса';
            document.getElementById('pop-handle').textContent = `@${userData.handle}`;
            document.getElementById('pop-ava').style.backgroundColor = userData.color;
            document.getElementById('pop-ava').textContent = userData.emoji;
        }
    };
    
    // Кнопка "Редактировать"
    document.getElementById('pop-edit-btn').onclick = () => {
        console.log("Opening edit mode");
        
        document.getElementById('popover-view').style.display = 'none';
        document.getElementById('popover-edit').style.display = 'block';
        
        // Заполняем форму текущими данными
        document.getElementById('edit-nick-in').value = userData.nickname;
        document.getElementById('edit-handle-in').value = userData.handle;
        document.getElementById('edit-bio-in').value = userData.bio || '';
        
        // Устанавливаем превью аватара
        const previewAva = document.getElementById('edit-preview-ava');
        previewAva.style.backgroundColor = userData.color;
        previewAva.textContent = userData.emoji;
        
        // Сбрасываем временные значения
        userData.tempColor = userData.color;
        userData.tempEmoji = userData.emoji;
        
        // Инициализируем пикеры
        initPopPickers();
    };
    
    // Кнопка "Отмена"
    document.getElementById('pop-cancel-btn').onclick = () => {
        console.log("Canceling edit");
        document.getElementById('popover-edit').style.display = 'none';
        document.getElementById('popover-view').style.display = 'block';
    };
    
    // Кнопка "Сохранить"
    document.getElementById('pop-save-btn').onclick = async () => {
        console.log("Saving profile...");
        
        const payload = { 
            nickname: document.getElementById('edit-nick-in').value.trim(), 
            handle: document.getElementById('edit-handle-in').value.trim(), 
            bio: document.getElementById('edit-bio-in').value.trim(), 
            color: userData.tempColor || userData.color, 
            emoji: userData.tempEmoji || userData.emoji 
        };
        
        console.log("Payload:", payload);
        
        try {
            const response = await fetch('/api/user/profile', { 
                method: 'POST', 
                headers: {'Content-Type': 'application/json'}, 
                body: JSON.stringify(payload) 
            });
            
            const result = await response.json();
            console.log("Server response:", result);
            
            if (result.success) {
                // Обновляем локальные данные
                userData.nickname = payload.nickname;
                userData.handle = payload.handle;
                userData.bio = payload.bio;
                userData.color = payload.color;
                userData.emoji = payload.emoji;
                
                alert('Профиль обновлён!');
                location.reload(); // Перезагружаем страницу
            } else {
                alert('Ошибка: ' + result.message);
            }
        } catch (err) {
            console.error("Save error:", err);
            alert('Ошибка сохранения: ' + err.message);
        }
    };
    
    // Кнопка "Выход"
    document.getElementById('pop-logout-btn').onclick = async () => {
        if(!confirm('Выйти из аккаунта?')) return;
        await fetch('/api/auth/logout', {method: 'POST'});
        window.location.href = '/login';
    };

    // Настройки
    document.getElementById('settings-btn').onclick = () => { 
        document.getElementById('settings-modal').classList.add('open'); 
        initPopPickers(); 
    };
    
    // Отмена ответа
    document.getElementById('cancel-reply-btn').onclick = () => { 
        replyData = null; 
        document.getElementById('reply-bar').style.display = 'none'; 
    };

    // КРЕСТИКИ ЗАКРЫТИЯ
    document.querySelectorAll('.close-btn').forEach(b => {
        b.onclick = function() { 
            this.closest('.modal').classList.remove('open'); 
        };
    });
    
    // Закрытие попапа при клике вне его
    document.addEventListener('click', e => { 
        const pop = document.getElementById('profile-popover');
        const myAvatarBtn = document.getElementById('my-avatar-btn');
        if(pop && !pop.contains(e.target) && myAvatarBtn && !myAvatarBtn.contains(e.target)) {
            pop.style.display = 'none'; 
        }
    });
    
    // Кнопка DM в чужом профиле
    document.getElementById('view-dm-btn').onclick = () => {
        if (!window.viewedProfileData) return;
        document.getElementById('view-user-modal').classList.remove('open');
        const room = [userData.username, window.viewedProfileData.username].sort().join('_');
        const chatsTabBtn = document.querySelector('.nav-btn[data-tab="chats"]');
        if (chatsTabBtn) chatsTabBtn.click();
        window.openChat(room, window.viewedProfileData);
    };

    loadChats();
});