# Помощник — Telegram Web App + Bot с оплатой через YooKassa

Коротко: готовый минимальный проект, который служит Telegram Web App (frontend `index.html`) и бэкендом на Node.js (`server.js`). Функции:

- показывать каталог (файлы в `catalog.json`)
- формировать платёж через YooKassa API (/create-payment)
- принимать вебхук от YooKassa (/webhook) и отправлять оплаченный файл через Telegram-бота

Быстрый старт локально

1. Скопируйте `.env.example` в `.env` и заполните значения.
2. Установите зависимости:

```bash
npm install
```

3. Запустите сервер:

```bash
npm start
```

Развёртывание на Render

1. Создайте новый Web Service в Render, выберите GitHub-репозиторий.
2. В настройках сервиса укажите команду `npm start` и порт `PORT` (по умолчанию Render выставляет переменную окружения PORT автоматически).
3. В разделе Environment -> Environment Variables добавьте:
   - `BOT_TOKEN`
   - `APP_URL` (пример `https://your-app.onrender.com`)
   - `TELEGRAM_WEBHOOK_URL` (пример `https://your-app.onrender.com/telegram-webhook`)
   - `YOO_SHOP_ID`
   - `YOO_SECRET_KEY`
   - `YOO_SECRET` (секрет для подписи временных download-ссылок внутри проекта)
   - `DOWNLOAD_TOKEN_TTL` (например `900`)
4. В личном кабинете YooKassa настройте webhook URL на `https://<ваш-домен>/webhook`.
5. Проверьте, что webhook подписан на событие `payment.succeeded`.

Интеграция с Telegram

- `index.html` — это Telegram Web App интерфейс. `BACKEND_URL` по умолчанию использует `window.location.origin`.
- Бот использует `node-telegram-bot-api`. По умолчанию приложение запускает бота в polling режиме. Чтобы переключиться на webhook, укажите `TELEGRAM_WEBHOOK_URL` в переменных окружения и пропишите этот URL у Telegram.

Платежи

- Создание платежа происходит через YooKassa API: `POST https://api.yookassa.ru/v3/payments`
- Для запросов используется Basic Auth: `Shop ID` как логин, `Secret Key` как пароль.
- В `metadata` передаются `fileId` и `chatId`.
- После успешной оплаты YooKassa отправляет webhook на `/webhook`.

Безопасность

- Не храните секреты в репозитории — используйте переменные окружения в Render/GitHub Secrets.
- `YOO_SECRET_KEY` — это ключ YooKassa, он не равен `YOO_SECRET` внутри вашего приложения.

Дальнейшие улучшения (рекомендуется)

- хранить файлы в приватном хранилище и выдавать временные защищённые ссылки
- добавить админ-панель для загрузки/модерации материалов
- перевести Telegram на webhook в продакшене
