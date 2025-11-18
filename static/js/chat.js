document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    
    const userData = {
        username: document.getElementById('my-username').textContent,
        nickname: document.getElementById('my-nickname').textContent,
        handle: document.getElementById('my-handle').textContent,
        color: document.getElementById('my-color').textContent,
        emoji: document.getElementById('my-emoji').textContent,
        bio: document.getElementById('my-bio').textContent,
    };
    
    const THEME_COLORS = ['#007aff', '#34c759', '#ff3b30', '#af52de', '#ff9500', '#5856d6'];
    let currentRoom = null;
    let currentRoomData = {};
    let replyData = null; 
    let typingTimer = null;
    let pauseTimer = null;
    let isTyping = false;
    let userStatusCache = {}; 
    const processedMsgIds = new Set();
    let viewedProfileData = null; 

    // --- ФУНКЦИЯ ЗАЩИТЫ ОТ ДУРАКА ---
    function setupInputLimit(input, maxLength) {
        if (!input) return;
        
        // Удаляем старый счетчик если есть (на случай реинита)
        const existing = input.parentElement.querySelector('.char-limit-counter');
        if(existing) existing.remove();

        const counter = document.createElement('span');
        counter.className = 'char-limit-counter';
        // Если это textarea (bio), поднимем чуть выше
        if (input.tagName === 'TEXTAREA') counter.style.bottom = '10px';
        input.parentElement.appendChild(counter);

        const check = () => {
            const current = input.value.length;
            const left = maxLength - current;
            const threshold = Math.ceil(maxLength * 0.05); // 5%

            if (current > maxLength) {
                input.value = input.value.slice(0, maxLength); // Режем
                counter.textContent = '0';
                // Тряска
                counter.classList.remove('shake-anim');
                void counter.offsetWidth; 
                counter.classList.add('shake-anim');
            } else {
                // Логика отображения
                if (left <= threshold) {
                    counter.textContent = left;
                    counter.style.display = 'block';
                } else {
                    counter.style.display = 'none';
                }
            }
        };

        input.addEventListener('input', check);
        // Дополнительная проверка при попытке ввода
        input.addEventListener('keydown', (e) => {
            // Если лимит исчерпан и нажат печатный символ
            if (input.value.length >= maxLength && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                 const counter = input.parentElement.querySelector('.char-limit-counter');
                 if(counter) {
                     counter.textContent = '0';
                     counter.style.display = 'block';
                     counter.classList.remove('shake-anim');
                     void counter.offsetWidth;
                     counter.classList.add('shake-anim');
                 }
            }
        });
    }

    // Применяем лимиты к полям чата
    setupInputLimit(document.getElementById('msg-input'), 500);

    // --- 0. ТЕМА ---
    function applyTheme(color) {
        if (!color) return;
        document.documentElement.style.setProperty('--primary', color);
        localStorage.setItem('chat_app_theme', color);
    }
    const savedTheme = localStorage.getItem('chat_app_theme');
    if(savedTheme) applyTheme(savedTheme);

    // --- 1. НАВИГАЦИЯ ---
    document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.app-tab').forEach(l => l.style.display = 'none');
            const target = document.getElementById(`tab-${btn.dataset.tab}`);
            if(target) target.style.display = 'flex';
        };
    });

    // --- 2. ЧАТ ---
    window.closeChat = () => {
        document.getElementById('chat-window').classList.remove('open');
        currentRoom = null;
        socket.emit('typing_event', {room: currentRoom, state: 'stop'});
    };
    
    window.openChat = (room, data) => {
        currentRoom = room;
        currentRoomData = data;
        document.getElementById('chat-title').textContent = data.nickname;
        document.getElementById('msgs').innerHTML = '';
        document.getElementById('chat-window').classList.add('open');
        
        const avaEl = document.getElementById('header-avatar');
        const statusEl = document.getElementById('chat-status');
        const listItem = document.querySelector(`.item[data-room="${room}"]`);
        if(listItem) listItem.classList.remove('unread');

        if (room !== '#Global') {
            avaEl.style.display = 'flex';
            avaEl.style.backgroundColor = data.avatar_color;
            avaEl.querySelector('span').textContent = data.avatar_emoji;
            socket.emit('join_dm', {username: data.username});
            updateUserStatusUI(data.username); 
        } else {
            avaEl.style.display = 'none';
            statusEl.textContent = 'Общий чат сервера';
            statusEl.style.color = '#888';
        }

        document.querySelectorAll('.item').forEach(i => i.classList.remove('active'));
        if(listItem) listItem.classList.add('active');
        socket.emit('request_history', {room: room});
    };

    function handleIncomingMessage(d) {
        if (processedMsgIds.has(d.message_id)) return;
        processedMsgIds.add(d.message_id);
        if (processedMsgIds.size > 500) processedMsgIds.clear();

        if (d.room === currentRoom) {
            if (d.sender_username !== userData.username) addMsg(d);
        } else {
            updateChatListPreview(d);
        }
    }

    function updateChatListPreview(d) {
        let listItem = document.querySelector(`.item[data-room="${d.room}"]`);
        if (listItem) {
            const previewBox = listItem.querySelector('.chat-info small');
            if (previewBox) previewBox.textContent = d.sender_username === userData.username ? `Вы: ${d.content}` : d.content;
            if (d.sender_username !== userData.username) listItem.classList.add('unread');
            document.getElementById('global-chat').after(listItem);
        }
    }

    function addMsg(d) {
        const typingBubble = document.getElementById('typing-bubble-row');
        if (typingBubble) typingBubble.remove();

        const list = document.getElementById('msgs');
        const isSelf = d.sender_username === userData.username;
        const row = document.createElement('div');
        row.className = `msg-row ${isSelf ? 'self' : 'other'}`;
        
        if (!isSelf) {
            const ava = document.createElement('div');
            ava.className = 'msg-ava';
            ava.style.backgroundColor = d.sender_avatar_color || '#555';
            ava.textContent = d.sender_avatar_emoji || '?';
            ava.style.cursor = 'pointer';
            ava.onclick = () => showUserProfile(d.sender_username);
            row.appendChild(ava);
        }

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';

        let replyHtml = d.reply_content ? `<div class="reply-ref"><b>${d.reply_nickname}</b>: ${d.reply_content}</div>` : '';
        let nameHtml = (!isSelf && d.room === '#Global') ? `<div style="font-size:0.7rem;font-weight:bold;margin-bottom:3px;color:#bbb">${d.sender_nickname}</div>` : '';

        bubble.innerHTML = `
            ${replyHtml}
            ${nameHtml}
            <div>${d.content.replace(/</g, "&lt;")}</div>
            <div class="msg-meta">
                <span>${new Date(d.timestamp*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
                <button class="reply-btn"><i class="fas fa-reply"></i></button>
            </div>
        `;
        bubble.querySelector('.reply-btn').onclick = () => {
            replyData = { content: d.content.substring(0, 50) + '...', nickname: d.sender_nickname, id: d.message_id };
            document.getElementById('reply-nick').textContent = d.sender_nickname;
            document.getElementById('reply-content').textContent = replyData.content;
            document.getElementById('reply-bar').style.display = 'flex';
            document.getElementById('msg-input').focus();
        };
        row.appendChild(bubble);
        list.appendChild(row);
        list.scrollTop = list.scrollHeight;
    }

    function getOrCreateTypingBubble() {
        let row = document.getElementById('typing-bubble-row');
        if (!row) {
            row = document.createElement('div');
            row.id = 'typing-bubble-row';
            row.className = 'typing-row';
            
            const ava = document.createElement('div');
            ava.className = 'msg-ava';
            ava.style.backgroundColor = currentRoomData.avatar_color || '#555';
            ava.textContent = currentRoomData.avatar_emoji || '...';
            row.appendChild(ava);

            const bubble = document.createElement('div');
            bubble.className = 'typing-bubble';
            bubble.innerHTML = `<div class="dot"></div><div class="dot"></div><div class="dot"></div>`;
            row.appendChild(bubble);
            document.getElementById('msgs').appendChild(row);
            document.getElementById('msgs').scrollTop = document.getElementById('msgs').scrollHeight;
        }
        return row.querySelector('.typing-bubble');
    }
    function removeTypingBubble() {
        const row = document.getElementById('typing-bubble-row');
        if (row) row.remove();
    }

    const msgInput = document.getElementById('msg-input');
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

    function sendMessage() {
        const content = msgInput.value.trim();
        if(!content || !currentRoom) return;
        
        const payload = {room: currentRoom, content: content};
        if(replyData) {
            payload.reply_content = replyData.content;
            payload.reply_nickname = replyData.nickname;
            payload.reply_to_id = replyData.id;
        }

        socket.emit('send_message', payload);
        
        addMsg({
            content: content, room: currentRoom, sender_username: userData.username,
            sender_nickname: userData.nickname, timestamp: Date.now() / 1000,
            reply_content: replyData ? replyData.content : null,
            reply_nickname: replyData ? replyData.nickname : null,
            sender_avatar_color: userData.color,
            sender_avatar_emoji: userData.emoji
        });
        updateChatListPreview({ room: currentRoom, content: content, sender_username: userData.username });

        msgInput.value = '';
        isTyping = false;
        clearTimeout(pauseTimer);
        socket.emit('typing_event', {room: currentRoom, state: 'stop'});
        document.getElementById('cancel-reply-btn').click(); 
    }
    document.getElementById('send-btn').onclick = sendMessage;
    msgInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); } });

    socket.on('connect', () => fetch('/api/users').then(r=>r.json()).then(d => renderUserList(d.users)));
    socket.on('message_history', d => { if(d.room === currentRoom) d.messages.forEach(addMsg); });
    socket.on('new_message', handleIncomingMessage);
    
    socket.on('display_typing', (data) => {
        if (currentRoomData.username !== data.username) return;
        if (data.state === 'stop') removeTypingBubble();
        else {
            const bubble = getOrCreateTypingBubble();
            bubble.classList.remove('fast', 'slow');
            bubble.classList.add(data.state === 'typing' ? 'fast' : 'slow');
        }
    });

    socket.on('activity_update', (data) => {
        userStatusCache[data.username] = { activity: data.activity, last_seen: data.last_seen };
        updateUserStatusUI(data.username);
        updateUserListStatus(data.username, data.activity);
    });

    function updateUserStatusUI(username) {
        if (currentRoomData.username === username) {
            const data = userStatusCache[username];
            const isOnline = data && data.activity === 'Online';
            const statusEl = document.getElementById('chat-status');
            const headerAva = document.getElementById('header-avatar');
            if (isOnline) {
                statusEl.textContent = "В сети"; statusEl.style.color = '#34c759'; headerAva.classList.add('online');
            } else {
                statusEl.textContent = "Не в сети"; statusEl.style.color = '#888'; headerAva.classList.remove('online');
            }
        }
    }

    function updateUserListStatus(username, activity) {
        document.querySelectorAll(`.item[data-username="${username}"] .ava`).forEach(ava => {
            if(activity === 'Online') ava.classList.add('online'); else ava.classList.remove('online');
        });
    }

    function renderUserList(users) {
        const chatListContainer = document.getElementById('chat-list'); 
        while (chatListContainer.children.length > 1) chatListContainer.removeChild(chatListContainer.lastChild);
        const userListContainer = document.getElementById('user-list');
        userListContainer.innerHTML = '';

        users.forEach(u => {
            userStatusCache[u.username] = { activity: u.current_activity, last_seen: u.last_seen };
            const li = document.createElement('div');
            li.className = 'item';
            li.dataset.room = `${[userData.username, u.username].sort().join('_')}`;
            li.dataset.username = u.username;
            
            const lastMsg = u.last_msg_preview ? u.last_msg_preview : `@${u.handle}`;
            const onlineClass = u.current_activity === 'Online' ? 'online' : '';
            
            li.innerHTML = `<div class="ava ${onlineClass}" style="background:${u.avatar_color}">${u.avatar_emoji}</div><div class="chat-info"><span>${u.nickname}</span><small>${lastMsg}</small></div>`;
            li.onclick = () => window.openChat(li.dataset.room, u);
            
            if (u.last_msg_preview) chatListContainer.appendChild(li);
            else userListContainer.appendChild(li);
        });
    }

    document.getElementById('global-chat').onclick = () => window.openChat('#Global', {nickname: 'Общий', username: '#Global', handle: 'Global', color: '#555', emoji: '🌍'});

    // --- ПРОФИЛЬ ---
    const profileModal = document.getElementById('profile-modal');
    const viewMode = document.getElementById('profile-view');
    const editForm = document.getElementById('profile-edit-form');
    const editBtn = document.getElementById('edit-icon-btn');

    document.getElementById('profile-btn').onclick = () => {
        document.getElementById('self-avatar-preview').style.backgroundColor = userData.color;
        document.getElementById('self-avatar-preview').textContent = userData.emoji;
        document.getElementById('view-nickname').textContent = userData.nickname;
        document.getElementById('view-handle').textContent = `@${userData.handle}`;
        document.getElementById('view-bio').textContent = userData.bio || 'Нет информации';
        viewMode.style.display = 'block';
        editForm.style.display = 'none';
        editBtn.style.display = 'block';
        profileModal.classList.add('open');
    };
    
    window.showUserProfile = async (username) => {
        const res = await fetch(`/api/profile/${username}`);
        const d = await res.json();
        if (d.success) {
            const p = d.profile;
            viewedProfileData = { ...p, username: username };
            document.getElementById('user-view-nickname').textContent = p.nickname;
            document.getElementById('user-view-handle').textContent = `@${p.handle}`;
            document.getElementById('user-view-bio').textContent = p.bio || 'Нет информации';
            const ava = document.getElementById('user-view-avatar');
            ava.style.backgroundColor = p.avatar_color;
            ava.textContent = p.avatar_emoji;
            document.getElementById('view-user-modal').classList.add('open');
        }
    };

    document.getElementById('view-dm-btn').onclick = () => {
        if (!viewedProfileData) return;
        document.getElementById('view-user-modal').classList.remove('open');
        const room = `${[userData.username, viewedProfileData.username].sort().join('_')}`;
        const chatsTabBtn = document.querySelector('.nav-btn[data-tab="chats"]');
        if (chatsTabBtn) chatsTabBtn.click();
        window.openChat(room, viewedProfileData);
    };

    editBtn.onclick = () => {
        viewMode.style.display = 'none';
        editForm.style.display = 'block';
        editBtn.style.display = 'none';
        document.getElementById('edit-nickname').value = userData.nickname;
        document.getElementById('edit-handle').value = userData.handle;
        document.getElementById('edit-bio').value = userData.bio;
        
        // Применяем лимиты к полям профиля
        setupInputLimit(document.getElementById('edit-nickname'), 20);
        setupInputLimit(document.getElementById('edit-handle'), 20);
        setupInputLimit(document.getElementById('edit-bio'), 300);

        initPickers();
    };

    document.getElementById('profile-edit-form').onsubmit = async (e) => {
        e.preventDefault();
        const payload = {
            nickname: document.getElementById('edit-nickname').value, 
            handle: document.getElementById('edit-handle').value, 
            bio: document.getElementById('edit-bio').value,
            color: userData.tempColor || userData.color,
            emoji: userData.tempEmoji || userData.emoji
        };
        const res = await fetch('/api/profile', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        if(res.ok) location.reload();
    };

    document.getElementById('chat-header').onclick = () => {
        if (currentRoom !== '#Global' && currentRoomData.username) showUserProfile(currentRoomData.username);
    };

    function initPickers() {
        const cc = document.getElementById('edit-color-picker');
        const ec = document.getElementById('edit-emoji-picker');
        const themePicker = document.getElementById('theme-picker');
        if(cc.children.length === 0) {
            THEME_COLORS.forEach(c => {
                const d = document.createElement('div'); d.style.backgroundColor = c;
                d.onclick = () => { userData.tempColor = c; document.getElementById('self-avatar-preview').style.backgroundColor = c; };
                cc.appendChild(d);
                const dt = document.createElement('div'); dt.style.backgroundColor = c;
                dt.onclick = () => applyTheme(c);
                themePicker.appendChild(dt);
            });
            ['😀','😎','👽','🤖','👻','🐱'].forEach(e => {
                const d = document.createElement('div'); d.textContent = e;
                d.onclick = () => { userData.tempEmoji = e; document.getElementById('self-avatar-preview').textContent = e; };
                ec.appendChild(d);
            });
        }
    }

    document.getElementById('settings-btn').onclick = () => { document.getElementById('settings-modal').classList.add('open'); initPickers(); };
    document.getElementById('cancel-reply-btn').onclick = () => { replyData = null; document.getElementById('reply-bar').style.display = 'none'; };
    document.querySelectorAll('.close-btn').forEach(b => b.onclick = function(){ this.closest('.modal').classList.remove('open'); });
    document.getElementById('logout-btn').onclick = () => fetch('/api/logout',{method:'POST'}).then(()=>window.location='/login');
});