document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    const processedMsgIds = new Set(); 

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button, .nav-btn, .nav-avatar, .item, .send-btn, .color-opt, .icon-btn, .fa-plus');
        if (btn) {
            btn.classList.remove('pop-anim');
            void btn.offsetWidth;
            btn.classList.add('pop-anim');
        }
    });

    const userData = {
        username: document.getElementById('my-username').textContent,
        nickname: document.getElementById('my-nickname').textContent,
        handle: document.getElementById('my-handle').textContent,
        color: document.getElementById('my-color').textContent,
        emoji: document.getElementById('my-emoji').textContent,
        bio: document.getElementById('my-bio').textContent,
    };

    let currentRoom = null;
    let currentRoomData = {};
    let activeTab = 'home';
    let unreadCounts = {};
    let allUsersCache = [];
    let replyData = null; // Храним данные реплая
    
    // --- UTILS ---
    function updateTitle() {
        let totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
        let prefix = totalUnread > 0 ? `(${totalUnread}) ` : '';
        if (activeTab === 'home') { document.title = `${prefix}Pramien | Главная`; } 
        else if (activeTab === 'chats') {
            if (currentRoom && currentRoom !== '#Global') document.title = `${prefix}${currentRoomData.nickname || 'Чат'} • Pramien`;
            else document.title = `${prefix}Чаты • Pramien`;
        }
        const navBadge = document.getElementById('total-unread');
        if (totalUnread > 0) { navBadge.textContent = totalUnread > 99 ? '99+' : totalUnread; navBadge.style.display = 'block'; } 
        else { navBadge.style.display = 'none'; }
    }
    
    function playIntroAnimations() {
        const nav = document.querySelector('.nav'); if (nav) nav.classList.add('anim-nav');
        document.querySelectorAll('.anim-nav-btn').forEach((btn, i) => {
            btn.style.opacity = '0'; btn.style.animation = `slideInIcon 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards ${0.7 + i*0.1}s`;
        });
        const wt = document.getElementById('welcome-text');
        if (wt) {
             const t = wt.textContent.trim(); wt.textContent = '';
             [...t].forEach((c, i) => {
                 const s = document.createElement('span'); s.textContent = c === ' ' ? '\u00A0' : c; s.className = 'anim-letter';
                 s.style.animation = `flyLetter 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) forwards ${0.8 + i*0.03}s`;
                 wt.appendChild(s);
             });
        }
        const st = document.getElementById('subtitle-text'); if (st) { st.classList.add('anim-block-fly'); st.style.animationDelay = '1.1s'; }
    }
    if (document.getElementById('tab-home').style.display !== 'none') playIntroAnimations();

    document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.app-tab').forEach(l => l.style.display = 'none');
            const target = document.getElementById(`tab-${btn.dataset.tab}`);
            if(target) target.style.display = 'flex';
            activeTab = btn.dataset.tab;
            updateTitle();
            if (activeTab === 'chats') loadChats(); 
        };
    });

    window.closeChat = () => {
        document.getElementById('chat-window').classList.remove('open');
        currentRoom = null;
        socket.emit('typing_event', {room: currentRoom, state: 'stop'});
        updateTitle();
    };
    
    window.openChat = (room, data) => {
        currentRoom = room;
        socket.emit('join', {room: room}); 

        if (room === '#Global') {
            currentRoomData = { nickname: 'Общий чат', username: '#Global', handle: 'Global', avatar_color: '#555', avatar_emoji: '🌍' };
        } else {
            currentRoomData = data;
        }

        document.getElementById('chat-title').textContent = currentRoomData.name || currentRoomData.nickname;
        document.getElementById('msgs').innerHTML = '';
        document.getElementById('chat-window').classList.add('open');
        const avaEl = document.getElementById('header-avatar');
        const statusEl = document.getElementById('chat-status');
        
        unreadCounts[room] = 0;
        const listItem = document.querySelector(`.item[data-room="${room}"]`);
        if(listItem) {
            const badge = listItem.querySelector('.item-badge');
            if(badge) { badge.textContent = ''; badge.style.display = 'none'; }
            listItem.classList.remove('unread');
        }
        updateTitle();

        if (room !== '#Global') {
            avaEl.style.display = 'flex'; 
            avaEl.style.backgroundColor = currentRoomData.avatar_color; 
            avaEl.querySelector('span').textContent = currentRoomData.avatar_emoji;
            
            if (currentRoomData.type !== 'group') {
                socket.emit('join_dm', {username: currentRoomData.username});
                statusEl.textContent = ' • Cloud Chat';
            } else {
                statusEl.textContent = ' • Группа';
            }
        } else {
            avaEl.style.display = 'none'; statusEl.textContent = 'Общий чат сервера';
        }
        
        document.querySelectorAll('.item').forEach(i => i.classList.remove('active'));
        if(listItem) listItem.classList.add('active');
        socket.emit('request_history', {room: room});
    };

    // --- MESSAGING ---
    async function handleIncomingMessage(d) {
        if (processedMsgIds.has(d.message_id)) return; 
        processedMsgIds.add(d.message_id);

        if (d.room !== currentRoom) {
            if (!unreadCounts[d.room]) unreadCounts[d.room] = 0;
            unreadCounts[d.room]++;
            updateTitle();
            
            let listItem = document.querySelector(`.item[data-room="${d.room}"]`);
            
            // ДИНАМИЧЕСКОЕ СОЗДАНИЕ ЧАТА, ЕСЛИ ЕГО НЕТ (ДЛЯ ЛС)
            if (!listItem && d.sender_username !== userData.username) {
                // Если это не группа, создаем слот ЛС
                // Проверяем, не начинается ли комната с 'group_' (хотя сервер пришлет type=group, но тут у нас только d)
                // Для простоты, если это ЛС, то имя комнаты содержит '_'.
                const container = document.getElementById('chat-list-container');
                
                // Данные отправителя есть в сообщении d
                const newChatData = {
                    room: d.room,
                    username: d.sender_username,
                    nickname: d.sender_nickname,
                    avatar_color: d.sender_avatar_color,
                    avatar_emoji: d.sender_avatar_emoji,
                    last_msg: d.content,
                    type: 'dm' // Предполагаем DM
                };
                
                listItem = createChatItem(newChatData);
                container.insertBefore(listItem, container.firstChild); // В начало
            }

            if (listItem) {
                let badge = listItem.querySelector('.item-badge');
                if (!badge) { badge = document.createElement('span'); badge.className = 'item-badge'; listItem.appendChild(badge); }
                badge.textContent = unreadCounts[d.room]; badge.style.display = 'block';
                const previewBox = listItem.querySelector('.chat-info small');
                if(previewBox) previewBox.textContent = `${d.sender_nickname}: ${d.content}`;
                // Поднимаем наверх
                if(listItem.parentElement) listItem.parentElement.prepend(listItem);
            }
        } else {
            addMsg(d);
        }
    }

    function addMsg(d) {
        let contentToShow = d.content;
        const list = document.getElementById('msgs');
        const isSelf = d.sender_username === userData.username;
        const row = document.createElement('div');
        row.className = `msg-row ${isSelf ? 'self' : 'other'}`;
        
        if (!isSelf) {
            const ava = document.createElement('div');
            ava.className = 'msg-ava';
            ava.style.backgroundColor = d.sender_avatar_color || '#555';
            ava.textContent = d.sender_avatar_emoji || '?';
            ava.onclick = () => showUserProfile(d.sender_username);
            ava.style.cursor = 'pointer';
            row.appendChild(ava);
        }
        
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        
        // Рендер реплая
        let replyHtml = '';
        if (d.reply_content) {
             replyHtml = `<div class="reply-ref"><b>${d.reply_nickname}</b>: ${d.reply_content}</div>`;
        }

        let nameHtml = (!isSelf && (d.room === '#Global' || currentRoomData.type === 'group')) ? `<div style="font-size:0.7rem;font-weight:bold;margin-bottom:3px;color:#bbb">${d.sender_nickname}</div>` : '';
        
        bubble.innerHTML = `${replyHtml}${nameHtml}<div>${contentToShow.replace(/</g, "&lt;")}</div><div class="msg-meta"><span>${new Date(d.timestamp*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div>`;
        
        // Кнопка ответа внутри пузыря (для удобства можно добавить)
        const replyBtn = document.createElement('button');
        replyBtn.className = 'reply-btn';
        replyBtn.innerHTML = '<i class="fas fa-reply"></i>';
        replyBtn.onclick = () => {
            replyData = { content: contentToShow.substring(0, 50) + '...', nickname: d.sender_nickname, id: d.message_id };
            document.getElementById('reply-nick').textContent = d.sender_nickname;
            document.getElementById('reply-content').textContent = replyData.content;
            document.getElementById('reply-bar').style.display = 'flex';
            document.getElementById('msg-input').focus();
        };
        // Вставляем кнопку в мету
        // Но в прошлом коде она была внутри bubble. Вернем ее.
        bubble.querySelector('.msg-meta').appendChild(replyBtn);

        row.appendChild(bubble);
        list.appendChild(row);
        list.scrollTop = list.scrollHeight;
    }

    function loadChats() {
        fetch('/api/chats').then(r=>r.json()).then(data => {
            const chatContainer = document.getElementById('chat-list-container');
            const userContainer = document.getElementById('user-list');
            chatContainer.innerHTML = '';
            userContainer.innerHTML = '';
            
            allUsersCache = data.users; 

            data.chats.forEach(chat => {
                const el = createChatItem(chat);
                chatContainer.appendChild(el);
            });

            data.users.forEach(u => {
                const exists = data.chats.find(c => c.room === u.room);
                if (!exists) {
                    const el = createChatItem({
                        room: u.room, name: u.nickname, avatar_color: u.avatar_color,
                        avatar_emoji: u.avatar_emoji, last_msg: `@${u.handle}`,
                        username: u.username, nickname: u.nickname, handle: u.handle, type: 'dm'
                    });
                    userContainer.appendChild(el);
                }
            });
        });
    }

    function createChatItem(data) {
        const div = document.createElement('div');
        div.className = 'item';
        div.dataset.room = data.room;
        const fullData = {
            username: data.username || data.room, 
            nickname: data.name || data.nickname,
            handle: data.handle || '',
            avatar_color: data.avatar_color,
            avatar_emoji: data.avatar_emoji,
            type: data.type
        };
        const badge = document.createElement('span'); badge.className = 'item-badge';
        div.innerHTML = `<div class="ava" style="background:${data.avatar_color}">${data.avatar_emoji}</div><div class="chat-info"><span>${data.name || data.nickname}</span><small>${data.last_msg || ''}</small></div>`;
        div.appendChild(badge);
        div.onclick = () => window.openChat(data.room, fullData);
        return div;
    }

    document.getElementById('create-group-btn').onclick = () => {
        document.getElementById('create-group-modal').classList.add('open');
        const list = document.getElementById('group-user-select');
        list.innerHTML = '';
        allUsersCache.forEach(u => {
            const div = document.createElement('label');
            div.className = 'user-select-item';
            div.innerHTML = `<input type="checkbox" value="${u.username}"><div class="ava" style="width:30px;height:30px;font-size:1rem;background:${u.avatar_color}">${u.avatar_emoji}</div><span>${u.nickname}</span>`;
            list.appendChild(div);
        });
    };

    document.getElementById('submit-group-btn').onclick = async () => {
        const name = document.getElementById('group-name-input').value;
        const checks = document.querySelectorAll('#group-user-select input:checked');
        const members = Array.from(checks).map(c => c.value);
        if(!name || members.length === 0) return;
        const res = await fetch('/api/groups/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, members}) });
        const d = await res.json();
        if(d.success) { document.getElementById('create-group-modal').classList.remove('open'); loadChats(); }
    };

    const msgInput = document.getElementById('msg-input');
    let isTyping = false; let pauseTimer = null;
    msgInput.addEventListener('input', () => {
        if (currentRoom === '#Global') return;
        if (msgInput.value.length > 0) {
            if (!isTyping) { isTyping = true; socket.emit('typing_event', {room: currentRoom, state: 'typing'}); }
            if (pauseTimer) clearTimeout(pauseTimer);
            pauseTimer = setTimeout(() => socket.emit('typing_event', {room: currentRoom, state: 'paused'}), 800);
        } else {
            isTyping = false;
            if (pauseTimer) clearTimeout(pauseTimer);
            socket.emit('typing_event', {room: currentRoom, state: 'stop'});
        }
    });
    
    // TYPING BUBBLE БЕЗ АВАТАРКИ
    socket.on('display_typing', (data) => {
        if (data.room !== currentRoom || data.username === userData.username) return;
        const existing = document.getElementById('typing-row');
        if (data.state === 'stop' || data.state === 'paused') {
            if(existing) existing.remove();
        } else {
            if (!existing) {
                const row = document.createElement('div');
                row.id = 'typing-row';
                row.className = 'msg-row other';
                // Убрали div.msg-ava
                row.innerHTML = `<div class="typing-bubble"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
                document.getElementById('msgs').appendChild(row);
                document.getElementById('msgs').scrollTop = document.getElementById('msgs').scrollHeight;
            }
        }
    });

    async function sendMessage() {
        const content = msgInput.value.trim();
        if(!content || !currentRoom) return;
        
        const payload = { room: currentRoom, content: content, is_encrypted: false };
        
        // ДОБАВЛЯЕМ РЕПЛАЙ
        if(replyData) {
            payload.reply_content = replyData.content;
            payload.reply_nickname = replyData.nickname;
            payload.reply_to_id = replyData.id;
        }

        socket.emit('send_message', payload);
        
        // СБРОС РЕПЛАЯ ПОСЛЕ ОТПРАВКИ
        replyData = null; 
        document.getElementById('reply-bar').style.display = 'none';
        msgInput.value = '';
    }
    document.getElementById('send-btn').onclick = sendMessage;
    document.getElementById('msg-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); } });
    
    // Кнопка отмены реплая
    document.getElementById('cancel-reply-btn').onclick = () => {
        replyData = null;
        document.getElementById('reply-bar').style.display = 'none';
    };

    socket.on('connect', () => loadChats());
    socket.on('message_history', d => { if(d.room === currentRoom) d.messages.forEach(msg => addMsg(msg)); });
    socket.on('new_message', handleIncomingMessage);
    
    const popover = document.getElementById('profile-popover');
    const myAvatarBtn = document.getElementById('my-avatar-btn');
    myAvatarBtn.onclick = (e) => {
        e.stopPropagation();
        if (popover.style.display === 'block') { popover.style.display = 'none'; } 
        else {
            popover.classList.add('open'); popover.style.display = 'block';
            document.getElementById('popover-view').style.display = 'block';
            document.getElementById('popover-edit').style.display = 'none';
        }
    };
    document.addEventListener('click', (e) => { if (!popover.contains(e.target) && !myAvatarBtn.contains(e.target)) popover.style.display = 'none'; });
    document.getElementById('pop-edit-btn').onclick = () => {
        document.getElementById('popover-view').style.display = 'none';
        document.getElementById('popover-edit').style.display = 'block';
        document.getElementById('edit-nick-in').value = userData.nickname;
        document.getElementById('edit-handle-in').value = userData.handle;
        document.getElementById('edit-bio-in').value = userData.bio;
        initPopPickers();
    };
    document.getElementById('pop-cancel-btn').onclick = () => { document.getElementById('popover-view').style.display = 'block'; document.getElementById('popover-edit').style.display = 'none'; };
    document.getElementById('pop-logout-btn').onclick = () => { fetch('/api/auth/logout',{method:'POST'}).then(()=>window.location='/login'); };
    
    document.getElementById('pop-save-btn').onclick = async () => {
        const payload = {
            nickname: document.getElementById('edit-nick-in').value, 
            handle: document.getElementById('edit-handle-in').value, 
            bio: document.getElementById('edit-bio-in').value,
            color: userData.tempColor || userData.color,
            emoji: userData.tempEmoji || userData.emoji
        };
        const res = await fetch('/api/user/profile', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        if(res.ok) location.reload();
    };

    function initPopPickers() {
        const cc = document.getElementById('pop-color-picker');
        const ec = document.getElementById('pop-emoji-picker');
        
        // Расширенная палитра для теста карусели
        const THEME_COLORS = ['#007aff', '#34c759', '#ff3b30', '#af52de', '#ff9500', '#5856d6', '#FF1493', '#00CED1', '#FFD700', '#8B4513', '#808080', '#FFFFFF'];
        const EMOJIS = ['😀','😎','👽','🤖','👻','🐱','🦊','🐸','🚀','🔥','💀','💩','🎉','💎','🎈','🚗'];

        if(cc.children.length === 0) {
            THEME_COLORS.forEach(c => {
                const d = document.createElement('div'); d.style.backgroundColor = c;
                d.onclick = () => { userData.tempColor = c; document.getElementById('edit-preview-ava').style.backgroundColor = c; };
                cc.appendChild(d);
            });
            EMOJIS.forEach(e => {
                const d = document.createElement('div'); d.textContent = e;
                d.onclick = () => { userData.tempEmoji = e; document.getElementById('edit-preview-ava').textContent = e; };
                ec.appendChild(d);
            });
        }
    }
    const THEME_COLORS = ['#007aff', '#34c759', '#ff3b30', '#af52de', '#ff9500', '#5856d6'];
    function applyTheme(color) { if (!color) return; document.documentElement.style.setProperty('--primary', color); localStorage.setItem('chat_app_theme', color); }
    const savedTheme = localStorage.getItem('chat_app_theme'); if(savedTheme) applyTheme(savedTheme);
    document.getElementById('settings-btn').onclick = () => {
        document.getElementById('settings-modal').classList.add('open');
        const tp = document.getElementById('theme-picker');
        if (tp.children.length === 0) {
            THEME_COLORS.forEach(c => { const d = document.createElement('div'); d.style.backgroundColor = c; d.onclick = () => applyTheme(c); tp.appendChild(d); });
        }
    };
    document.querySelectorAll('.close-btn').forEach(b => b.onclick = function(){ this.closest('.modal').classList.remove('open'); });
    
    window.showUserProfile = async (username) => {
        const res = await fetch(`/api/profile/${username}`); const d = await res.json();
        if (d.success) {
            const p = d.profile; 
            document.getElementById('user-view-nickname').textContent = p.nickname;
            document.getElementById('user-view-handle').textContent = `@${p.handle}`;
            document.getElementById('user-view-bio').textContent = p.bio || 'Нет информации';
            const ava = document.getElementById('user-view-avatar'); ava.style.backgroundColor = p.avatar_color; ava.textContent = p.avatar_emoji;
            document.getElementById('view-user-modal').classList.add('open');
        }
    };
});