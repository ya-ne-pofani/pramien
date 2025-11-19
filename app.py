import os
from datetime import datetime
from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from flask_socketio import SocketIO, emit, join_room
from werkzeug.security import generate_password_hash, check_password_hash
from flasgger import Swagger

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret_key_reset_mode'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chat.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# --- SWAGGER CONFIG ---
app.config['SWAGGER'] = {
    'title': 'Pramien Chat API',
    'uiversion': 3,
    'version': '1.0.0',
    'description': 'API для мессенджера с поддержкой E2EE и игр',
    'termsOfService': '/tos'
}
swagger = Swagger(app)

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*")
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# --- MODELS ---
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(48), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    nickname = db.Column(db.String(20), nullable=False)
    handle = db.Column(db.String(20), unique=True, nullable=True)
    bio = db.Column(db.String(300), nullable=True)
    avatar_color = db.Column(db.String(20), default='#007aff')
    avatar_emoji = db.Column(db.String(10), default='😀')
    public_key = db.Column(db.Text, nullable=True) # E2EE Key
    current_activity = db.Column(db.String(100), default='Online')
    last_seen = db.Column(db.Float, default=0.0)

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    room = db.Column(db.String(50), nullable=False)
    sender_username = db.Column(db.String(48), nullable=False)
    content = db.Column(db.String(5000), nullable=False)
    is_encrypted = db.Column(db.Boolean, default=False)
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

# --- HELPERS ---
def get_room_name(user1, user2):
    return f"{sorted([user1, user2])[0]}_{sorted([user1, user2])[1]}"

# --- WEB ROUTES ---
@app.route('/')
@login_required
def chat():
    if not current_user.handle: return redirect(url_for('setup_page'))
    return render_template('chat.html', user=current_user)

@app.route('/games')
@login_required
def games(): return render_template('games.html', user=current_user)

@app.route('/setup')
@login_required
def setup_page(): return render_template('setup.html', user=current_user)

@app.route('/login')
def login(): return render_template('login.html')

@app.route('/register')
def register(): return render_template('register.html')

# ==========================================
#                 REST API
# ==========================================

@app.route('/api/auth/login', methods=['POST'])
def api_login():
    """
    Вход пользователя
    Получение сессии для доступа к защищенным методам.
    ---
    tags:
      - Auth
    parameters:
      - name: body
        in: body
        required: true
        schema:
          type: object
          required:
            - username
            - password
          properties:
            username:
              type: string
              example: user1
            password:
              type: string
              example: password123
    responses:
      200:
        description: Успешный вход
        schema:
          type: object
          properties:
            success:
              type: boolean
            redirect:
              type: string
      401:
        description: Ошибка авторизации
    """
    data = request.json
    user = User.query.filter_by(username=data.get('username')).first()
    if user and check_password_hash(user.password_hash, data.get('password')):
        login_user(user)
        return jsonify({'success': True, 'redirect': url_for('setup_page') if not user.handle else url_for('chat')})
    return jsonify({'success': False, 'message': 'Неверный логин или пароль'}), 401

@app.route('/api/auth/register', methods=['POST'])
def api_register():
    """
    Регистрация нового пользователя
    Создает новый аккаунт в системе.
    ---
    tags:
      - Auth
    parameters:
      - name: body
        in: body
        required: true
        schema:
          type: object
          required:
            - username
            - password
          properties:
            username:
              type: string
            password:
              type: string
    responses:
      200:
        description: Аккаунт создан
      400:
        description: Ошибка валидации или логин занят
    """
    data = request.json
    if len(data.get('username')) > 48: return jsonify({'success': False, 'message': 'Логин слишком длинный'}), 400
    if User.query.filter_by(username=data.get('username')).first():
        return jsonify({'success': False, 'message': 'Логин занят'}), 400
    
    new_user = User(
        username=data.get('username'),
        password_hash=generate_password_hash(data.get('password')),
        nickname=data.get('username')[:20],
        last_seen=datetime.now().timestamp()
    )
    db.session.add(new_user)
    db.session.commit()
    login_user(new_user)
    return jsonify({'success': True, 'redirect': url_for('setup_page')})

@app.route('/api/auth/logout', methods=['POST'])
@login_required
def api_logout():
    """
    Выход из системы
    Завершает текущую сессию.
    ---
    tags:
      - Auth
    responses:
      200:
        description: Успешный выход
    """
    logout_user()
    return jsonify({'success': True})

@app.route('/api/user/profile', methods=['GET', 'POST'])
@login_required
def api_profile():
    """
    Получить или обновить профиль текущего пользователя
    GET - возвращает данные, POST - обновляет.
    ---
    tags:
      - User
    parameters:
      - name: body
        in: body
        required: false
        schema:
          type: object
          properties:
            nickname:
              type: string
            handle:
              type: string
            bio:
              type: string
            color:
              type: string
            emoji:
              type: string
    responses:
      200:
        description: Успех
    """
    if request.method == 'GET':
        return jsonify({
            'success': True,
            'profile': {
                'username': current_user.username,
                'nickname': current_user.nickname,
                'handle': current_user.handle,
                'bio': current_user.bio,
                'color': current_user.avatar_color,
                'emoji': current_user.avatar_emoji
            }
        })

    data = request.json
    if len(data.get('nickname', '')) > 20: return jsonify({'success': False, 'message': 'Имя слишком длинное'}), 400
    
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

@app.route('/api/users', methods=['GET'])
@login_required
def api_users_list():
    """
    Список пользователей
    Возвращает список всех пользователей для списка чатов с последними сообщениями.
    ---
    tags:
      - Chat
    responses:
      200:
        description: Список пользователей
    """
    users = User.query.filter(User.id != current_user.id).all()
    users_data = []
    for u in users:
        room = get_room_name(current_user.username, u.username)
        last_msg = Message.query.filter_by(room=room).order_by(Message.timestamp.desc()).first()
        users_data.append({
            'username': u.username, 
            'nickname': u.nickname, 
            'avatar_color': u.avatar_color, 
            'avatar_emoji': u.avatar_emoji,
            'public_key': u.public_key,
            'current_activity': u.current_activity,
            'last_seen': u.last_seen,
            'last_msg_time': last_msg.timestamp if last_msg else 0,
            'last_msg_preview': last_msg.content[:30] if last_msg and not last_msg.is_encrypted else "🔒 Message" if last_msg else None
        })
    users_data.sort(key=lambda x: x['last_msg_time'], reverse=True)
    return jsonify({'users': users_data})

@app.route('/api/keys', methods=['GET', 'POST'])
@login_required
def api_keys():
    """
    Управление E2EE ключами
    GET - получить публичный ключ другого юзера.
    POST - обновить свой публичный ключ.
    ---
    tags:
      - Security
    parameters:
      - name: username
        in: query
        type: string
        description: (Для GET) Логин пользователя, чей ключ нужен.
      - name: body
        in: body
        description: (Для POST) JSON с публичным ключом
        schema:
          type: object
          properties:
            public_key:
              type: string
    responses:
      200:
        description: Успех
    """
    if request.method == 'POST':
        data = request.json
        current_user.public_key = data.get('public_key')
        db.session.commit()
        return jsonify({'success': True})
    
    # GET
    target_username = request.args.get('username')
    if not target_username:
        return jsonify({'success': False, 'message': 'Username required'}), 400
    
    user = User.query.filter_by(username=target_username).first()
    if not user or not user.public_key:
        return jsonify({'success': False, 'message': 'Key not found'}), 404
        
    return jsonify({'success': True, 'public_key': user.public_key})

@app.route('/api/chat/history', methods=['GET'])
@login_required
def api_chat_history():
    """
    История сообщений
    Получить историю переписки с пользователем или в общей комнате.
    ---
    tags:
      - Chat
    parameters:
      - name: partner
        in: query
        type: string
        description: Логин собеседника (или пустой для общего чата если room=#Global)
      - name: room
        in: query
        type: string
        description: Явное указание комнаты (например #Global)
      - name: limit
        in: query
        type: integer
        default: 100
    responses:
      200:
        description: Список сообщений
    """
    room = request.args.get('room')
    partner = request.args.get('partner')
    limit = int(request.args.get('limit', 100))

    if not room and partner:
        room = get_room_name(current_user.username, partner)
    elif not room:
        room = '#Global'

    msgs = Message.query.filter_by(room=room).order_by(Message.timestamp.asc()).limit(limit).all()
    res = []
    for m in msgs:
        s = User.query.filter_by(username=m.sender_username).first()
        res.append({
            'message_id': m.id, 
            'room': m.room, 
            'content': m.content,
            'is_encrypted': m.is_encrypted,
            'sender_username': m.sender_username, 
            'sender_nickname': s.nickname if s else m.sender_username, 
            'sender_avatar_color': s.avatar_color if s else '#555',
            'sender_avatar_emoji': s.avatar_emoji if s else '?',
            'timestamp': m.timestamp, 
            'reply_content': m.reply_content, 
            'reply_nickname': m.reply_nickname
        })
    return jsonify({'messages': res})

@app.route('/api/chat/send', methods=['POST'])
@login_required
def api_chat_send():
    """
    Отправка сообщения
    Отправляет сообщение и уведомляет клиентов через WebSocket.
    ---
    tags:
      - Chat
    parameters:
      - name: body
        in: body
        required: true
        schema:
          type: object
          required:
            - content
          properties:
            content:
              type: string
              description: Текст или зашифрованная строка (base64)
            partner:
              type: string
              description: Логин получателя (для ЛС)
            room:
              type: string
              description: Комната (для #Global)
            is_encrypted:
              type: boolean
            reply_content:
              type: string
            reply_nickname:
              type: string
    responses:
      200:
        description: Сообщение отправлено
    """
    data = request.json
    content = data.get('content', '')
    room = data.get('room')
    partner = data.get('partner')

    if not room and partner:
        room = get_room_name(current_user.username, partner)
    elif not room:
        room = '#Global'

    if len(content) > 5000: content = content[:5000]

    msg = Message(
        room=room, 
        sender_username=current_user.username, 
        content=content, 
        is_encrypted=data.get('is_encrypted', False),
        reply_content=data.get('reply_content'), 
        reply_nickname=data.get('reply_nickname')
    )
    db.session.add(msg)
    db.session.commit()
    
    # Подготовка данных для сокетов и ответа
    msg_data = {
        'message_id': msg.id, 
        'room': msg.room, 
        'content': msg.content,
        'is_encrypted': msg.is_encrypted,
        'sender_username': current_user.username, 
        'sender_nickname': current_user.nickname, 
        'sender_avatar_color': current_user.avatar_color,
        'sender_avatar_emoji': current_user.avatar_emoji,
        'timestamp': msg.timestamp, 
        'reply_content': msg.reply_content, 
        'reply_nickname': msg.reply_nickname
    }
    
    # Real-time уведомление для тех, кто сейчас онлайн в вебе
    socketio.emit('new_message', msg_data, room=room)
    
    # Также отправляем уведомление получателю в личный канал сокетов, чтобы обновился список чатов
    if room != '#Global':
        users = room.split('_')
        recipient = users[0] if users[1] == current_user.username else users[1]
        socketio.emit('new_message', msg_data, room=recipient)

    return jsonify({'success': True, 'message': msg_data})

@app.route('/api/games', methods=['GET'])
@login_required
def api_games_list():
    """
    Список игр и рекордов
    ---
    tags:
      - Games
    responses:
      200:
        description: Список доступных игр
    """
    games = Game.query.all()
    res = []
    for g in games:
        score = GameScore.query.filter_by(game_slug=g.slug, user_username=current_user.username).first()
        res.append({'title': g.title, 'slug': g.slug, 'description': g.description, 'iframe_src': g.iframe_src, 'user_high_score': score.score if score else 0})
    return jsonify({'games': res})

# --- SOCKET EVENTS (Legacy & Realtime) ---
@socketio.on('connect')
def on_connect():
    if current_user.is_authenticated:
        current_user.current_activity = 'Online'
        current_user.last_seen = datetime.now().timestamp()
        db.session.commit()
        join_room(current_user.username) # Личная комната для уведомлений
        emit('activity_update', {'username': current_user.username, 'activity': 'Online', 'last_seen': current_user.last_seen}, broadcast=True)

@socketio.on('join_dm')
def on_join(data):
    target = data.get('username')
    if target:
        room = get_room_name(current_user.username, target)
        join_room(room)

@socketio.on('request_history')
def on_history(data):
    # Socket-версия получения истории (дублирует REST API, но быстрее для веба)
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
                'is_encrypted': m.is_encrypted,
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
def on_send_socket(data):
    # Socket-версия отправки (для веб-клиента)
    content = data['content']
    if len(content) > 5000: content = content[:5000]

    msg = Message(
        room=data['room'], 
        sender_username=current_user.username, 
        content=content, 
        is_encrypted=data.get('is_encrypted', False),
        reply_content=data.get('reply_content'), 
        reply_nickname=data.get('reply_nickname')
    )
    db.session.add(msg)
    db.session.commit()
    
    msg_data = {
        'message_id': msg.id, 
        'room': msg.room, 
        'content': msg.content,
        'is_encrypted': msg.is_encrypted,
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