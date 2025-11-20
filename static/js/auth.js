// static/js/auth.js
document.addEventListener('DOMContentLoaded', () => {
    
    // LOGIN
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = loginForm.querySelector('button');
            const errorBox = document.getElementById('error-box');
            
            btn.disabled = true;
            btn.textContent = 'Вход...';
            errorBox.style.display = 'none';

            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;

            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                
                if (data.success) {
                    window.location.href = data.redirect;
                } else {
                    errorBox.textContent = data.error;
                    errorBox.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Войти';
                }
            } catch (err) {
                errorBox.textContent = 'Ошибка сети';
                errorBox.style.display = 'block';
                btn.disabled = false;
            }
        });
    }

    // REGISTER
    const regForm = document.getElementById('register-form');
    if (regForm) {
        regForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = regForm.querySelector('button');
            const errorBox = document.getElementById('error-box');

            btn.disabled = true;
            btn.textContent = 'Создание...';
            errorBox.style.display = 'none';

            const payload = {
                username: document.getElementById('username').value,
                password: document.getElementById('password').value,
                nickname: document.getElementById('nickname').value,
                handle: document.getElementById('handle').value
            };

            try {
                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();

                if (data.success) {
                    window.location.href = data.redirect;
                } else {
                    errorBox.textContent = data.error;
                    errorBox.style.display = 'block';
                    btn.disabled = false;
                    btn.textContent = 'Создать аккаунт';
                }
            } catch (err) {
                errorBox.textContent = 'Ошибка сети';
                errorBox.style.display = 'block';
                btn.disabled = false;
            }
        });
    }
});