import os
import json
import sqlite3
import time
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime
import uuid

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret_key_pramien_v2'
socketio = SocketIO(app, cors_allowed_origins="*")

# --- DATABASE ---
def get_db_connection():
    conn = sqlite3.connect('instance/chat.db')
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    if not os.path.exists('instance'):
        os.makedirs('instance')
    conn = get_db_connection()
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        nickname TEXT NOT NULL,
        handle TEXT UNIQUE NOT NULL,
        bio TEXT,
        avatar_color TEXT DEFAULT '#555',
        avatar_emoji TEXT DEFAULT '👤',
        public_key TEXT,
        last_seen REAL DEFAULT 0
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        sender_username TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp REAL NOT NULL,
        reply_to_id INTEGER,
        is_encrypted BOOLEAN DEFAULT 0
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_username TEXT NOT NULL,
        avatar_color TEXT,
        avatar_emoji TEXT
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        username TEXT NOT NULL,
        PRIMARY KEY (group_id, username)
    )''')
    conn.commit()
    conn.close()

init_db()

# --- ROUTES ---

@app.route('/')
def index():
    if 'user' not in session:
        return redirect(url_for('login'))
    return render_template('chat.html', user=get_current_user())

def get_current_user():
    if 'user' not in session: return None
    conn = get_db_connection()
    user = conn.execute('SELECT * FROM users WHERE username = ?', (session['user'],)).fetchone()
    conn.close()
    return user

# --- AUTH PAGES ---
@app.route('/login')
def login():
    return render_template('login.html')

@app.route('/register')
def register():
    return render_template('register.html')

# --- AUTH API (FIXED FOR LOGS) ---
@app.route('/api/auth/login', methods=['POST'])
def api_login():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    conn = get_db_connection()
    user = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    conn.close()
    
    if user and check_password_hash(user['password'], password):
        session['user'] = username
        return jsonify({'success': True, 'redirect': '/'})
    
    return jsonify({'success': False, 'error': 'Неверный логин или пароль'}), 401

@app.route('/api/auth/register', methods=['POST'])
def api_register():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    nickname = data.get('nickname')
    handle = data.get('handle', '').replace('@', '')
    
    if not username or not password or not nickname or not handle:
        return jsonify({'success': False, 'error': 'Заполните все поля'}), 400

    hashed_pw = generate_password_hash(password)
    
    import random
    colors = ['#007aff', '#34c759', '#ff3b30', '#af52de', '#ff9500', '#5856d6']
    emojis = ['🐶', '🐱', '🦊', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸']
    
    try:
        conn = get_db_connection()
        conn.execute('INSERT INTO users (username, password, nickname, handle, avatar_color, avatar_emoji) VALUES (?, ?, ?, ?, ?, ?)',
                     (username, hashed_pw, nickname, handle, random.choice(colors), random.choice(emojis)))
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'redirect': '/login'})
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': 'Пользователь с таким логином или handle уже существует'}), 409

@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.pop('user', None)
    return jsonify({'success': True, 'redirect': '/login'})

# --- API: CHATS & USERS ---
@app.route('/api/chats')
def get_chats():
    if 'user' not in session: return jsonify({'error': 'Unauthorized'}), 401
    my_username = session['user']
    conn = get_db_connection()
    
    all_users = conn.execute('SELECT username, nickname, handle, avatar_color, avatar_emoji, last_seen FROM users WHERE username != ?', (my_username,)).fetchall()
    
    my_groups = conn.execute('''
        SELECT g.group_id, g.name, g.avatar_color, g.avatar_emoji 
        FROM groups g
        JOIN group_members gm ON g.group_id = gm.group_id
        WHERE gm.username = ?
    ''', (my_username,)).fetchall()

    chats_data = []
    chats_data.append({'room': '#Global', 'type': 'global', 'name': 'Общий чат', 'avatar_emoji': '🌍', 'avatar_color': '#555', 'last_msg': ''})

    for g in my_groups:
        last = conn.execute('SELECT content, sender_username, timestamp FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT 1', (g['group_id'],)).fetchone()
        preview = f"{last['sender_username']}: {last['content']}" if last else "Нет сообщений"
        chats_data.append({
            'room': g['group_id'], 'type': 'group', 'name': g['name'],
            'avatar_emoji': g['avatar_emoji'] or '👥', 'avatar_color': g['avatar_color'] or '#007aff',
            'last_msg': preview, 'timestamp': last['timestamp'] if last else 0
        })

    users_list = []
    for u in all_users:
        room_id = '_'.join(sorted([my_username, u['username']]))
        last = conn.execute('SELECT content, timestamp FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT 1', (room_id,)).fetchone()
        status = 'Online' if (time.time() - (u['last_seen'] or 0)) < 300 else 'Offline'
        users_list.append({
            'username': u['username'], 'nickname': u['nickname'], 'handle': u['handle'],
            'avatar_color': u['avatar_color'], 'avatar_emoji': u['avatar_emoji'],
            'room': room_id, 'last_msg': last['content'] if last else None, 'status': status
        })

    conn.close()
    return jsonify({'chats': chats_data, 'users': users_list})

# FIX: Добавляем старый маршрут /api/users для совместимости, если кэш браузера долбит его
@app.route('/api/users')
def get_users_legacy():
    return get_chats()

# --- API: GROUPS & PROFILE ---
@app.route('/api/groups/create', methods=['POST'])
def create_group():
    if 'user' not in session: return jsonify({'error': 'Unauthorized'}), 401
    data = request.json
    group_name = data.get('name')
    members = data.get('members', [])
    if not group_name: return jsonify({'error': 'Empty name'}), 400
    
    group_id = f"group_{uuid.uuid4().hex[:8]}"
    my_username = session['user']
    members.append(my_username)
    members = list(set(members))
    
    import random
    colors = ['#007aff', '#34c759', '#ff3b30', '#af52de', '#ff9500']
    emojis = ['📢', '💬', '👥', '🔥', '✨', '🚀']
    
    conn = get_db_connection()
    conn.execute('INSERT INTO groups (group_id, name, owner_username, avatar_color, avatar_emoji) VALUES (?, ?, ?, ?, ?)',
                 (group_id, group_name, my_username, random.choice(colors), random.choice(emojis)))
    for m in members:
        conn.execute('INSERT INTO group_members (group_id, username) VALUES (?, ?)', (group_id, m))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'group_id': group_id})

@app.route('/api/user/profile', methods=['POST'])
def update_profile():
    if 'user' not in session: return jsonify({'error': 401}), 401
    d = request.json
    conn = get_db_connection()
    conn.execute('UPDATE users SET nickname=?, handle=?, bio=?, avatar_color=?, avatar_emoji=? WHERE username=?',
                 (d['nickname'], d['handle'], d['bio'], d['color'], d['emoji'], session['user']))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/profile/<username>')
def get_profile(username):
    conn = get_db_connection()
    u = conn.execute('SELECT nickname, handle, bio, avatar_color, avatar_emoji, public_key FROM users WHERE username=?', (username,)).fetchone()
    conn.close()
    if u: return jsonify({'success':True, 'profile': dict(u), 'has_key': bool(u['public_key'])})
    return jsonify({'success':False})

# --- SOCKETS ---
@socketio.on('join')
def on_join(data):
    join_room(data['room'])

@socketio.on('join_dm')
def on_join_dm(data):
    pass 

@socketio.on('request_history')
def handle_history(data):
    room = data['room']
    conn = get_db_connection()
    msgs_db = conn.execute('''
        SELECT m.*, u.nickname as sender_nickname, u.avatar_color as sender_avatar_color, u.avatar_emoji as sender_avatar_emoji
        FROM messages m
        LEFT JOIN users u ON m.sender_username = u.username
        WHERE room = ? ORDER BY timestamp ASC LIMIT 100
    ''', (room,)).fetchall()
    messages = [dict(m) for m in msgs_db]
    emit('message_history', {'room': room, 'messages': messages})
    conn.close()

@socketio.on('send_message')
def handle_message(data):
    if 'user' not in session: return
    room, content = data['room'], data['content']
    sender = session['user']
    conn = get_db_connection()
    cursor = conn.execute('INSERT INTO messages (room, sender_username, content, timestamp) VALUES (?, ?, ?, ?)', 
                          (room, sender, content, time.time()))
    msg_id = cursor.lastrowid
    conn.commit()
    u = conn.execute('SELECT nickname, avatar_color, avatar_emoji FROM users WHERE username=?', (sender,)).fetchone()
    conn.close()
    msg_data = {
        'message_id': msg_id, 'room': room, 'content': content,
        'sender_username': sender, 'sender_nickname': u['nickname'],
        'sender_avatar_color': u['avatar_color'], 'sender_avatar_emoji': u['avatar_emoji'],
        'timestamp': time.time(), 'reply_content': data.get('reply_content'), 'reply_nickname': data.get('reply_nickname')
    }
    emit('new_message', msg_data, room=room)

@socketio.on('typing_event')
def handle_typing(data):
    emit('display_typing', {'room': data['room'], 'username': session['user'], 'state': data['state']}, room=data['room'])

@socketio.on('connect')
def handle_connect():
    if 'user' in session:
        conn = get_db_connection()
        conn.execute('UPDATE users SET last_seen=? WHERE username=?', (time.time(), session['user']))
        conn.commit()
        conn.close()
        emit('activity_update', {'username': session['user'], 'activity': 'Online', 'last_seen': time.time()}, broadcast=True)

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)