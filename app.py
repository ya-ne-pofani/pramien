import os
import json
import sqlite3
import time
import datetime
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import generate_password_hash, check_password_hash
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
    if not os.path.exists('instance'): os.makedirs('instance')
    conn = get_db_connection()
    c = conn.cursor()
    
    # Users, Messages, Groups, Admins, Bans, Tags...
    c.execute('''CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, nickname TEXT NOT NULL, handle TEXT UNIQUE NOT NULL, bio TEXT, avatar_color TEXT DEFAULT '#555', avatar_emoji TEXT DEFAULT '👤', public_key TEXT, last_seen REAL DEFAULT 0, created_at REAL DEFAULT 0)''')
    c.execute('''CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, sender_username TEXT NOT NULL, content TEXT NOT NULL, timestamp REAL NOT NULL, reply_to_id INTEGER, is_encrypted BOOLEAN DEFAULT 0)''')
    c.execute('''CREATE TABLE IF NOT EXISTS groups (group_id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_username TEXT NOT NULL, avatar_color TEXT, avatar_emoji TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL, username TEXT NOT NULL, PRIMARY KEY (group_id, username))''')
    c.execute('''CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS bans (user_id INTEGER, username TEXT NOT NULL, reason TEXT, banned_at REAL, expires_at REAL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, emoji TEXT, is_special BOOLEAN DEFAULT 0, priority INTEGER DEFAULT 0)''')
    c.execute('''CREATE TABLE IF NOT EXISTS user_tags (user_id INTEGER, tag_id INTEGER, PRIMARY KEY (user_id, tag_id))''')
    
    # Default Tags
    c.execute("INSERT OR IGNORE INTO tags (name, emoji, is_special, priority) VALUES ('Verified', 'check-circle', 1, 10)")
    c.execute("INSERT OR IGNORE INTO tags (name, emoji, is_special, priority) VALUES ('Developer', 'hammer', 1, 5)")
    
    conn.commit()
    conn.close()

init_db()

# --- HELPERS ---
def get_user_tags(username):
    conn = get_db_connection()
    user = conn.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone()
    if not user: 
        conn.close()
        return []
    tags = conn.execute('SELECT t.* FROM tags t JOIN user_tags ut ON t.id = ut.tag_id WHERE ut.user_id = ? ORDER BY t.priority DESC', (user['id'],)).fetchall()
    conn.close()
    return [dict(t) for t in tags]

# --- BAN CHECK ---
@app.before_request
def check_ban():
    if request.endpoint in ['static', 'banned_page', 'logout', 'api_login', 'api_register', 'login', 'register']: return
    if 'user' in session:
        conn = get_db_connection()
        ban = conn.execute('SELECT * FROM bans WHERE username = ? AND expires_at > ?', (session['user'], time.time())).fetchone()
        conn.close()
        if ban:
            if request.path.startswith('/api/'): return jsonify({'error': 'banned', 'reason': ban['reason']}), 403
            return redirect(url_for('banned_page'))

@app.route('/banned')
def banned_page():
    conn = get_db_connection()
    ban = conn.execute('SELECT * FROM bans WHERE username = ? AND expires_at > ?', (session.get('user'), time.time())).fetchone()
    conn.close()
    if not ban: return redirect('/')
    expires = datetime.datetime.fromtimestamp(ban['expires_at']).strftime('%d.%m.%Y %H:%M')
    return render_template('banned.html', ban=ban, expires=expires)

# --- ROUTES ---
@app.route('/')
def index():
    if 'user' not in session: return redirect(url_for('login'))
    conn = get_db_connection()
    user = conn.execute('SELECT * FROM users WHERE username = ?', (session['user'],)).fetchone()
    conn.close()
    if not user: session.pop('user', None); return redirect('/login')
    user_dict = dict(user)
    user_dict['tags'] = get_user_tags(user['username'])
    return render_template('chat.html', user=user_dict)

@app.route('/login')
def login(): return render_template('login.html')

@app.route('/register')
def register(): return render_template('register.html')

# --- ADMIN ---
@app.route('/admin')
def admin_index():
    if 'admin_user' in session: return render_template('admin.html')
    conn = get_db_connection()
    cnt = conn.execute('SELECT COUNT(*) FROM admins').fetchone()[0]
    conn.close()
    return render_template('admin_login.html', allow_register=(cnt == 0))

@app.route('/api/admin/login', methods=['POST'])
def admin_login_api():
    d = request.json
    conn = get_db_connection()
    if d.get('is_register'):
        if conn.execute('SELECT COUNT(*) FROM admins').fetchone()[0] > 0: return jsonify({'success': False}), 403
        conn.execute('INSERT INTO admins (username, password) VALUES (?, ?)', (d['username'], generate_password_hash(d['password'])))
        conn.commit(); session['admin_user'] = d['username']; return jsonify({'success': True})
    else:
        a = conn.execute('SELECT * FROM admins WHERE username=?', (d['username'],)).fetchone()
        if a and check_password_hash(a['password'], d['password']): session['admin_user'] = d['username']; return jsonify({'success': True})
        return jsonify({'success': False, 'error': 'Invalid'}), 401

@app.route('/api/admin/stats')
def admin_stats():
    if 'admin_user' not in session: return jsonify({'error':401}), 401
    conn = get_db_connection()
    u = conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]
    m = conn.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
    b = conn.execute('SELECT COUNT(*) FROM bans WHERE expires_at > ?', (time.time(),)).fetchone()[0]
    return jsonify({'users': u, 'messages': m, 'bans': b})

@app.route('/api/admin/users')
def admin_users():
    if 'admin_user' not in session: return jsonify({'error':401}), 401
    q = request.args.get('q', '')
    conn = get_db_connection()
    users = conn.execute("SELECT id, username, nickname FROM users WHERE username LIKE ? OR nickname LIKE ?", (f'%{q}%', f'%{q}%')).fetchall()
    res = []
    for u in users:
        ud = dict(u)
        ban = conn.execute('SELECT * FROM bans WHERE user_id=? AND expires_at > ?', (u['id'], time.time())).fetchone()
        ud['is_banned'] = bool(ban)
        res.append(ud)
    conn.close()
    return jsonify(res)

@app.route('/api/admin/banned_users')
def admin_banned_list():
    if 'admin_user' not in session: return jsonify({'error':401}), 401
    conn = get_db_connection()
    bans = conn.execute('SELECT b.*, u.nickname FROM bans b JOIN users u ON b.user_id = u.id WHERE b.expires_at > ?', (time.time(),)).fetchall()
    res = []
    for b in bans:
        bd = dict(b)
        bd['expires_str'] = datetime.datetime.fromtimestamp(b['expires_at']).strftime('%d.%m %H:%M')
        res.append(bd)
    conn.close()
    return jsonify(res)

@app.route('/api/admin/ban', methods=['POST'])
def admin_ban():
    if 'admin_user' not in session: return jsonify({'error':401}), 401
    d = request.json
    expires = time.time() + (int(d['duration']) * 60)
    conn = get_db_connection()
    u = conn.execute('SELECT username FROM users WHERE id=?', (d['user_id'],)).fetchone()
    conn.execute('INSERT INTO bans (user_id, username, reason, banned_at, expires_at) VALUES (?, ?, ?, ?, ?)', (d['user_id'], u['username'], d['reason'], time.time(), expires))
    conn.commit(); conn.close()
    socketio.emit('force_disconnect', {'username': u['username']})
    return jsonify({'success': True})

@app.route('/api/admin/unban', methods=['POST'])
def admin_unban():
    if 'admin_user' not in session: return jsonify({'error':401}), 401
    d = request.json
    conn = get_db_connection()
    conn.execute('DELETE FROM bans WHERE user_id = ?', (d['user_id'],))
    conn.commit(); conn.close()
    return jsonify({'success': True})

@app.route('/api/admin/tags/list')
def admin_get_tags_list():
    conn = get_db_connection()
    tags = conn.execute('SELECT * FROM tags').fetchall()
    conn.close()
    return jsonify([dict(t) for t in tags])

@app.route('/api/admin/tags/assign', methods=['POST'])
def admin_assign_tag():
    if 'admin_user' not in session: return jsonify({'error':401}), 401
    d = request.json
    conn = get_db_connection()
    tag_id = d.get('tag_id')
    if not tag_id and d.get('name'):
        cur = conn.execute('INSERT INTO tags (name, emoji, is_special) VALUES (?, ?, ?)', (d['name'], d['emoji'], d.get('is_special', False)))
        tag_id = cur.lastrowid
    
    try:
        conn.execute('INSERT INTO user_tags (user_id, tag_id) VALUES (?, ?)', (d['user_id'], tag_id))
        conn.commit()
    except: pass
    conn.close()
    return jsonify({'success': True})

# --- USER API ---
@app.route('/api/chats')
def get_chats():
    if 'user' not in session: return jsonify({'error': 'Unauthorized'}), 401
    my_username = session['user']
    conn = get_db_connection()
    all_users = conn.execute('SELECT id, username, nickname, handle, avatar_color, avatar_emoji, last_seen FROM users WHERE username != ?', (my_username,)).fetchall()
    my_groups = conn.execute('SELECT g.group_id, g.name, g.avatar_color, g.avatar_emoji FROM groups g JOIN group_members gm ON g.group_id = gm.group_id WHERE gm.username = ?', (my_username,)).fetchall()
    chats_data = [{'room': '#Global', 'type': 'global', 'name': 'Общий чат', 'avatar_emoji': '🌍', 'avatar_color': '#555', 'last_msg': ''}]
    for g in my_groups:
        last = conn.execute('SELECT content, sender_username, timestamp FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT 1', (g['group_id'],)).fetchone()
        chats_data.append({'room': g['group_id'], 'type': 'group', 'name': g['name'], 'avatar_emoji': g['avatar_emoji'] or '👥', 'avatar_color': g['avatar_color'] or '#007aff', 'last_msg': (f"{last['sender_username']}: {last['content']}" if last else "Нет сообщений"), 'timestamp': last['timestamp'] if last else 0})
    users_list = []
    for u in all_users:
        room_id = '_'.join(sorted([my_username, u['username']]))
        last = conn.execute('SELECT content, timestamp FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT 1', (room_id,)).fetchone()
        tags = get_user_tags(u['username'])
        users_list.append({'username': u['username'], 'nickname': u['nickname'], 'handle': u['handle'], 'avatar_color': u['avatar_color'], 'avatar_emoji': u['avatar_emoji'], 'room': room_id, 'last_msg': last['content'] if last else None, 'status': 'Online', 'tags': tags})
    conn.close()
    return jsonify({'chats': chats_data, 'users': users_list})

@app.route('/api/profile/<username>')
def get_profile_api(username):
    conn = get_db_connection()
    u = conn.execute('SELECT nickname, handle, bio, avatar_color, avatar_emoji FROM users WHERE username=?', (username,)).fetchone()
    if u:
        tags = get_user_tags(username)
        conn.close()
        return jsonify({'success':True, 'profile': dict(u), 'tags': tags})
    conn.close()
    return jsonify({'success':False})

# НОВЫЙ ЭНДПОИНТ ДЛЯ ОБНОВЛЕНИЯ ПРОФИЛЯ
@app.route('/api/user/profile', methods=['POST'])
def update_profile():
    if 'user' not in session:
        return jsonify({'success': False, 'message': 'Unauthorized'}), 401
    
    data = request.json
    username = session['user']
    
    try:
        conn = get_db_connection()
        
        # Обновляем профиль пользователя
        conn.execute('''
            UPDATE users 
            SET nickname = ?, handle = ?, bio = ?, avatar_color = ?, avatar_emoji = ?
            WHERE username = ?
        ''', (
            data.get('nickname'),
            data.get('handle'),
            data.get('bio', ''),
            data.get('color'),
            data.get('emoji'),
            username
        ))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'message': 'Profile updated'})
    
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'message': 'Handle уже занят'}), 409
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

# --- AUTH API ---
@app.route('/api/auth/login', methods=['POST'])
def api_login():
    data = request.json
    conn = get_db_connection()
    user = conn.execute('SELECT * FROM users WHERE username = ?', (data['username'],)).fetchone()
    conn.close()
    if user and check_password_hash(user['password'], data['password']): 
        session['user'] = data['username']
        return jsonify({'success': True, 'redirect': '/'})
    return jsonify({'success': False, 'error': 'Неверный логин или пароль'}), 401

@app.route('/api/auth/logout', methods=['POST'])
def logout(): 
    session.pop('user', None)
    return jsonify({'success': True, 'redirect': '/login'})

@app.route('/api/auth/register', methods=['POST'])
def api_register():
    d = request.json
    conn = get_db_connection()
    try:
        conn.execute('INSERT INTO users (username, password, nickname, handle, avatar_color, avatar_emoji, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 
                     (d['username'], generate_password_hash(d['password']), d['nickname'], d['handle'], '#007aff', '👤', time.time()))
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'redirect': '/login'})
    except:
        return jsonify({'success': False, 'error': 'Логин или handle уже занят'}), 409

# --- SOCKET.IO ---
@socketio.on('join')
def on_join(data): 
    join_room(data['room'])

@socketio.on('send_message')
def handle_message(data):
    if 'user' not in session: return
    room, content = data['room'], data['content']
    sender = session['user']
    conn = get_db_connection()
    cursor = conn.execute('INSERT INTO messages (room, sender_username, content, timestamp) VALUES (?, ?, ?, ?)', 
                         (room, sender, content, time.time()))
    conn.commit()
    u = conn.execute('SELECT nickname, avatar_color, avatar_emoji FROM users WHERE username=?', (sender,)).fetchone()
    tags = get_user_tags(sender)
    conn.close()
    emit('new_message', {
        'message_id': cursor.lastrowid, 
        'room': room, 
        'content': content, 
        'sender_username': sender, 
        'sender_nickname': u['nickname'], 
        'sender_avatar_color': u['avatar_color'], 
        'sender_avatar_emoji': u['avatar_emoji'], 
        'timestamp': time.time(), 
        'reply_content': data.get('reply_content'), 
        'sender_tags': tags
    }, room=room)

@socketio.on('request_history')
def handle_history(data):
    conn = get_db_connection()
    msgs = conn.execute('SELECT m.*, u.nickname as sender_nickname, u.avatar_color as sender_avatar_color, u.avatar_emoji as sender_avatar_emoji, u.username as u_real FROM messages m LEFT JOIN users u ON m.sender_username = u.username WHERE room = ? ORDER BY timestamp ASC LIMIT 100', (data['room'],)).fetchall()
    res = []
    for m in msgs:
        d = dict(m)
        d['sender_tags'] = get_user_tags(m['u_real'])
        res.append(d)
    conn.close()
    emit('message_history', {'room': data['room'], 'messages': res})

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)