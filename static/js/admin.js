let selectedUserId = null;

function showTab(tab) {
    document.querySelectorAll('.tab-content').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(e => e.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    // Highlight button
    const btn = document.querySelector(`button[onclick="showTab('${tab}')"]`);
    if(btn) btn.classList.add('active');

    if(tab === 'stats') loadStats();
    if(tab === 'users') searchUsers();
    if(tab === 'bans') loadBans();
}

async function loadStats() {
    const res = await fetch('/api/admin/stats');
    const data = await res.json();
    document.getElementById('stat-users').textContent = data.users;
    document.getElementById('stat-msgs').textContent = data.messages;
    document.getElementById('stat-bans').textContent = data.bans;
}

async function searchUsers() {
    const q = document.getElementById('user-search').value;
    const res = await fetch(`/api/admin/users?q=${q}`);
    const users = await res.json();
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = '';
    users.forEach(u => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${u.id}</td>
            <td>${u.nickname} <span style="color:#666">@${u.username}</span></td>
            <td>
                ${u.is_banned ? '<span style="color:red">Banned</span>' : 
                  `<button class="action-btn btn-ban" onclick="openBanModal(${u.id})">Ban</button>`}
                <button class="action-btn btn-tag" onclick="openTagModal(${u.id})">Tags</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function loadBans() {
    const res = await fetch('/api/admin/banned_users');
    const bans = await res.json();
    const tbody = document.getElementById('bans-table-body');
    tbody.innerHTML = '';
    bans.forEach(b => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${b.nickname} <br><small>@${b.username}</small></td>
            <td>${b.reason}</td>
            <td>${b.expires_str}</td>
            <td><button class="action-btn" onclick="unbanUser(${b.user_id})">Unban</button></td>
        `;
        tbody.appendChild(tr);
    });
}

// MODALS
function openBanModal(id) { selectedUserId = id; document.getElementById('ban-modal').classList.add('open'); }
function openTagModal(id) { selectedUserId = id; document.getElementById('tag-modal').classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ACTIONS
async function submitBan() {
    const reason = document.getElementById('ban-reason').value;
    const duration = document.getElementById('ban-time').value;
    await fetch('/api/admin/ban', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({user_id: selectedUserId, reason, duration})
    });
    closeModal('ban-modal');
    searchUsers();
}

async function unbanUser(id) {
    if(!confirm('Разбанить?')) return;
    await fetch('/api/admin/unban', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({user_id: id})
    });
    loadBans();
}

function fillTag(name, emoji, special) {
    document.getElementById('new-tag-name').value = name;
    document.getElementById('new-tag-emoji').value = emoji;
    document.getElementById('new-tag-special').checked = special;
}

async function submitTag() {
    const name = document.getElementById('new-tag-name').value;
    const emoji = document.getElementById('new-tag-emoji').value;
    const is_special = document.getElementById('new-tag-special').checked;
    
    await fetch('/api/admin/tags/assign', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({user_id: selectedUserId, name, emoji, is_special})
    });
    closeModal('tag-modal');
    alert('Тег выдан');
}

showTab('stats');