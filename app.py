import os
from datetime import datetime
from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret_key_reset_mode'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chat.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*")
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# --- MODELS (С ОГРАНИЧЕНИЯМИ) ---
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    # Login (48)
    username = db.Column(db.String(48), unique=True, nullable=False) 
    # Password hash (128 обычно хватает для хеша, но сам ввод пароля мы ограничим на фронте)
    password_hash = db.Column(db.String(200), nullable=False) 
    # Имя/Никнейм (20)
    nickname = db.Column(db.String(20), nullable=False)
    # Юзерка/Handle (20)
    handle = db.Column(db.String(20), unique=True, nullable=True)
    # О себе (300)
    bio = db.Column(db.String(300), nullable=True)
    
    avatar_color = db.Column(db.String(20), default='#007aff')
    avatar_emoji = db.Column(db.String(10), default='😀')
    current_activity = db.Column(db.String(100), default='Online')
    last_seen = db.Column(db.Float, default=0.0)

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    room = db.Column(db.String(50), nullable=False)
    sender_username = db.Column(db.String(48), nullable=False)
    # Сообщение (500)
    content = db.Column(db.String(500), nullable=False)
    timestamp = db.Column(db.Float, default=datetime.now().timestamp)
    reply_content = db.Column(db.String(200), nullable=True)
    reply_nickname = db.Column(db.String(20), nullable=True)

class Game(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(100), nullable=False)
    slug = db.Column(db.String(50), unique=True, nullable=False)
    description = db.Column(db.String(200))
    iframe_src = db.Column(db.String(200), nullable=False)

class GameScore(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    game_slug = db.Column(db.String(50), nullable=False)
    user_username = db.Column(db.String(48), nullable=False)
    score = db.Column(db.Integer, default=0)

@login_manager.user_loader
def load_user(id): return User.query.get(int(id))

# --- ROUTES ---
@app.route('/')
@login_required
def chat():
    if not current_user.handle: return redirect(url_for('setup_page'))
    return render_template('chat.html', user=current_user)

@app.route('/games')
@login_required
def games():
    if not current_user.handle: return redirect(url_for('setup_page'))
    return render_template('games.html', user=current_user)

@app.route('/setup')
@login_required
def setup_page():
    return render_template('setup.html', user=current_user)

@app.route('/login')
def login():
    if current_user.is_authenticated: return redirect(url_for('chat'))
    return render_template('login.html')

@app.route('/register')
def register():
    if current_user.is_authenticated: return redirect(url_for('chat'))
    return render_template('register.html')

# --- API ---
@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.json
    user = User.query.filter_by(username=data.get('username')).first()
    if user and check_password_hash(user.password_hash, data.get('password')):
        login_user(user)
        return jsonify({'success': True, 'redirect': url_for('setup_page') if not user.handle else url_for('chat')})
    return jsonify({'success': False, 'message': 'Неверный логин или пароль'}), 401

@app.route('/api/register', methods=['POST'])
def api_register():
    data = request.json
    # Валидация на бэкенде (на всякий случай)
    if len(data.get('username')) > 48: return jsonify({'success': False, 'message': 'Логин слишком длинный'}), 400
    if len(data.get('password')) > 128: return jsonify({'success': False, 'message': 'Пароль слишком длинный'}), 400

    if User.query.filter_by(username=data.get('username')).first():
        return jsonify({'success': False, 'message': 'Логин занят'}), 400
    
    new_user = User(
        username=data.get('username'),
        password_hash=generate_password_hash(data.get('password')),
        nickname=data.get('username')[:20], # Обрезаем ник если что
        last_seen=datetime.now().timestamp()
    )
    db.session.add(new_user)
    db.session.commit()
    login_user(new_user)
    return jsonify({'success': True, 'redirect': url_for('setup_page')})

@app.route('/api/profile', methods=['POST'])
@login_required
def api_profile():
    data = request.json
    # Валидация
    if len(data.get('nickname', '')) > 20: return jsonify({'success': False, 'message': 'Имя слишком длинное'}), 400
    if len(data.get('handle', '')) > 20: return jsonify({'success': False, 'message': 'Handle слишком длинный'}), 400
    if len(data.get('bio', '')) > 300: return jsonify({'success': False, 'message': 'О себе слишком длинное'}), 400

    if data.get('handle'):
        exists = User.query.filter_by(handle=data['handle']).first()
        if exists and exists.id != current_user.id: return jsonify({'success': False, 'message': 'Handle занят'}), 400
    
    current_user.nickname = data.get('nickname', current_user.nickname)
    current_user.handle = data.get('handle', current_user.handle)
    current_user.bio = data.get('bio', current_user.bio)
    current_user.avatar_color = data.get('color', current_user.avatar_color)
    current_user.avatar_emoji = data.get('emoji', current_user.avatar_emoji)
    db.session.commit()
    return jsonify({'success': True, 'redirect': url_for('chat')})

@app.route('/api/users')
@login_required
def api_users():
    users = User.query.filter(User.id != current_user.id).all()
    users_data = []
    for u in users:
        room = f"{sorted([current_user.username, u.username])[0]}_{sorted([current_user.username, u.username])[1]}"
        last_msg = Message.query.filter_by(room=room).order_by(Message.timestamp.desc()).first()
        users_data.append({
            'username': u.username, 'nickname': u.nickname, 'avatar_color': u.avatar_color, 'avatar_emoji': u.avatar_emoji,
            'current_activity': u.current_activity, 'last_seen': u.last_seen,
            'last_msg_time': last_msg.timestamp if last_msg else 0,
            'last_msg_preview': last_msg.content[:30] if last_msg else None
        })
    users_data.sort(key=lambda x: x['last_msg_time'], reverse=True)
    return jsonify({'users': users_data})

@app.route('/api/profile/<username>')
@login_required
def get_profile(username):
    u = User.query.filter_by(username=username).first()
    if not u: return jsonify({'success': False}), 404
    return jsonify({'success': True, 'profile': {'nickname': u.nickname, 'handle': u.handle, 'bio': u.bio, 'avatar_color': u.avatar_color, 'avatar_emoji': u.avatar_emoji}})

@app.route('/api/games')
@login_required
def api_games():
    games = Game.query.all()
    res = []
    for g in games:
        score = GameScore.query.filter_by(game_slug=g.slug, user_username=current_user.username).first()
        res.append({'title': g.title, 'slug': g.slug, 'description': g.description, 'iframe_src': g.iframe_src, 'user_high_score': score.score if score else 0})
    return jsonify({'games': res})

@app.route('/api/logout', methods=['POST'])
@login_required
def logout_api():
    logout_user()
    return jsonify({'success': True})

# --- SOCKETS ---
@socketio.on('connect')
def on_connect():
    if current_user.is_authenticated:
        current_user.current_activity = 'Online'
        current_user.last_seen = datetime.now().timestamp()
        db.session.commit()
        join_room(current_user.username)
        emit('activity_update', {'username': current_user.username, 'activity': 'Online', 'last_seen': current_user.last_seen}, broadcast=True)

@socketio.on('join_dm')
def on_join(data):
    target = data.get('username')
    if target:
        room = f"{sorted([current_user.username, target])[0]}_{sorted([current_user.username, target])[1]}"
        join_room(room)

@socketio.on('request_history')
def on_history(data):
    room = data.get('room')
    if room:
        join_room(room)
        msgs = Message.query.filter_by(room=room).order_by(Message.timestamp.asc()).limit(100).all()
        res = []
        for m in msgs:
            s = User.query.filter_by(username=m.sender_username).first()
            res.append({
                'message_id': m.id, 
                'room': m.room, 
                'content': m.content, 
                'sender_username': m.sender_username, 
                'sender_nickname': s.nickname if s else m.sender_username, 
                'sender_avatar_color': s.avatar_color if s else '#555',
                'sender_avatar_emoji': s.avatar_emoji if s else '?',
                'timestamp': m.timestamp, 
                'reply_content': m.reply_content, 
                'reply_nickname': m.reply_nickname
            })
        emit('message_history', {'room': room, 'messages': res})

@socketio.on('send_message')
def on_send(data):
    # Бэкенд валидация сообщения
    content = data['content']
    if len(content) > 500: content = content[:500]

    msg = Message(room=data['room'], sender_username=current_user.username, content=content, reply_content=data.get('reply_content'), reply_nickname=data.get('reply_nickname'))
    db.session.add(msg)
    db.session.commit()
    
    msg_data = {
        'message_id': msg.id, 
        'room': msg.room, 
        'content': msg.content, 
        'sender_username': current_user.username, 
        'sender_nickname': current_user.nickname, 
        'sender_avatar_color': current_user.avatar_color,
        'sender_avatar_emoji': current_user.avatar_emoji,
        'timestamp': msg.timestamp, 
        'reply_content': msg.reply_content, 
        'reply_nickname': msg.reply_nickname
    }
    
    emit('new_message', msg_data, room=msg.room)
    if data['room'] != '#Global':
        users = data['room'].split('_')
        recipient = users[0] if users[1] == current_user.username else users[1]
        emit('new_message', msg_data, room=recipient)

@socketio.on('update_activity')
def on_act(data):
    current_user.current_activity = data.get('activity')
    current_user.last_seen = datetime.now().timestamp()
    db.session.commit()
    emit('activity_update', {'username': current_user.username, 'activity': current_user.current_activity, 'last_seen': current_user.last_seen}, broadcast=True)

@socketio.on('typing_event')
def on_typing(data):
    emit('display_typing', {'room': data['room'], 'username': current_user.username, 'state': data['state']}, room=data['room'])

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
        if Game.query.count() == 0:
            db.session.add(Game(title="Змейка", slug="snake", description="Classic", iframe_src="/static/games/snake.html"))
            db.session.commit()
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)