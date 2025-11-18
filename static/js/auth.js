document.addEventListener('DOMContentLoaded', () => {
    // 1. Анимация текста
    const title = document.querySelector('.fly-text');
    if (title) {
        const text = title.textContent.trim();
        title.textContent = '';
        [...text].forEach((char, i) => {
            const span = document.createElement('span');
            span.textContent = char === ' ' ? '\u00A0' : char;
            span.style.animationDelay = `${i * 0.05}s`;
            title.appendChild(span);
        });
    }

    // 2. Функция защиты от дурака (Копия той же функции)
    function setupInputLimit(input, maxLength) {
        if (!input) return;
        
        const existing = input.parentElement.querySelector('.char-limit-counter');
        if(existing) existing.remove();

        const counter = document.createElement('span');
        counter.className = 'char-limit-counter';
        input.parentElement.appendChild(counter);

        const check = () => {
            const current = input.value.length;
            const left = maxLength - current;
            const threshold = Math.ceil(maxLength * 0.05); 

            if (current > maxLength) {
                input.value = input.value.slice(0, maxLength);
                counter.textContent = '0';
                counter.classList.remove('shake-anim');
                void counter.offsetWidth; 
                counter.classList.add('shake-anim');
            } else {
                if (left <= threshold) {
                    counter.textContent = left;
                    counter.style.display = 'block';
                } else {
                    counter.style.display = 'none';
                }
            }
        };

        input.addEventListener('input', check);
        input.addEventListener('keydown', (e) => {
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

    // Применяем лимиты
    // Логин: 48
    const loginInput = document.querySelector('input[name="username"]');
    setupInputLimit(loginInput, 48);

    // Пароль: 128
    const passInput = document.querySelector('input[name="password"]');
    setupInputLimit(passInput, 128);


    // 3. Обработка форм
    const handleForm = async (e, url) => {
        e.preventDefault();
        const btn = e.target.querySelector('button');
        const oldText = btn.textContent;
        btn.textContent = '...'; btn.disabled = true;
        
        const data = Object.fromEntries(new FormData(e.target));
        try {
            const res = await fetch(url, {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)
            });
            const json = await res.json();
            if (json.success) window.location.href = json.redirect;
            else alert(json.message);
        } catch (err) { alert('Ошибка сети'); }
        btn.textContent = oldText; btn.disabled = false;
    };

    const loginForm = document.getElementById('login-form');
    if (loginForm) loginForm.onsubmit = (e) => handleForm(e, '/api/login');

    const regForm = document.getElementById('reg-form');
    if (regForm) regForm.onsubmit = (e) => handleForm(e, '/api/register');

    const setupForm = document.getElementById('setup-form');
    if (setupForm) {
        // Применяем лимиты для сетапа
        setupInputLimit(document.querySelector('input[name="nickname"]'), 20);
        setupInputLimit(document.querySelector('input[name="handle"]'), 20);

        let color = '#007aff', emoji = '😀';
        document.querySelectorAll('.color-option').forEach(c => c.onclick = () => {
            color = c.style.backgroundColor;
            document.getElementById('preview-ava').style.backgroundColor = color;
        });
        document.querySelectorAll('.emoji-option').forEach(e => e.onclick = () => {
            emoji = e.textContent;
            document.getElementById('preview-ava').textContent = emoji;
        });
        
        setupForm.onsubmit = async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.target));
            data.color = color; data.emoji = emoji;
            
            const res = await fetch('/api/profile', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)
            });
            const json = await res.json();
            if(json.success) window.location.href = json.redirect;
            else alert(json.message);
        };
    }
});