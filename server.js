require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const catalog = require('./catalog.json');
const { Readable } = require('stream');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

if (!process.env.BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN not set in environment');
    process.exit(1);
}

// Telegram bot: polling by default, webhook if TELEGRAM_WEBHOOK_URL provided
let bot;
if (process.env.TELEGRAM_WEBHOOK_URL) {
    bot = new TelegramBot(process.env.BOT_TOKEN);
    bot.setWebHook(process.env.TELEGRAM_WEBHOOK_URL)
        .then(() => console.log('Telegram webhook set:', process.env.TELEGRAM_WEBHOOK_URL))
        .catch(err => {
            console.error('setWebHook error:', err.message);
            process.exit(1);
        });
} else {
    bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
    console.log('Telegram bot running in polling mode');
}

const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3';
const YOO_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
const YOO_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
const DOWNLOAD_SECRET = process.env.YOOKASSA_SECRET;

if (!DOWNLOAD_SECRET) {
    console.error('ERROR: YOOKASSA_SECRET not set');
    process.exit(1);
}

// Создание платежа через YooKassa API
app.post('/create-payment', async (req, res) => {
    const { fileId, chatId } = req.body;
    const item = catalog[fileId];
    if (!item) return res.status(404).json({ error: 'Товар не найден' });

    // Если файл бесплатный — генерируем временный токен так же как для платных
    if (item.type === 'free') {
        const expiresSec = parseInt(process.env.DOWNLOAD_TOKEN_TTL || '900', 10);
        const expiresAt = Math.floor(Date.now() / 1000) + expiresSec;
        const payload = `${fileId}|${chatId || 'free'}|${expiresAt}`;
        const hmac = crypto.createHmac('sha256', DOWNLOAD_SECRET).update(payload).digest('hex');
        const token = Buffer.from(payload).toString('base64') + '.' + hmac;
        const appUrl = process.env.APP_URL || '';
        const downloadLink = `${appUrl}/download/${encodeURIComponent(token)}`;
        return res.json({ freeUrl: downloadLink });
    }

    if (!YOO_SHOP_ID || !YOO_SECRET_KEY) {
        return res.status(500).json({ error: 'YOO_SHOP_ID и YOO_SECRET_KEY должны быть настроены в окружении' });
    }

    try {
        const response = await fetch(`${YOOKASSA_API_URL}/payments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotence-Key': crypto.randomUUID(),
                'Authorization': 'Basic ' + Buffer.from(`${YOO_SHOP_ID}:${YOO_SECRET_KEY}`).toString('base64')
            },
            body: JSON.stringify({
                amount: {
                    value: String(item.price),
                    currency: 'RUB'
                },
                capture: true,
                description: `Оплата файла: ${item.name}`,
                confirmation: {
                    type: 'redirect',
                    return_url: process.env.APP_URL || 'https://education-helper.onrender.com/'
                },
                metadata: {
                    fileId,
                    chatId
                }
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('YooKassa payment creation failed:', data);
            return res.status(502).json({ error: 'Ошибка создания платежа', details: data });
        }

        if (!data || !data.confirmation || !data.confirmation.confirmation_url) {
            return res.status(500).json({ error: 'Не получена ссылка для оплаты' });
        }

        res.json({ paymentUrl: data.confirmation.confirmation_url, paymentId: data.id });
    } catch (err) {
        console.error('Error creating YooKassa payment:', err);
        res.status(500).json({ error: 'Ошибка создания платежа' });
    }
});

// Отдать статическую страницу (index.html) для Telegram Web App / браузера
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Простая хранилка оплат
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');
function loadPayments() {
    try {
        if (!fs.existsSync(PAYMENTS_FILE)) return [];
        const raw = fs.readFileSync(PAYMENTS_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (err) {
        console.error('loadPayments error', err);
        return [];
    }
}

function savePayment(record) {
    try {
        const payments = loadPayments();
        payments.push(record);
        fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2), 'utf8');
    } catch (err) {
        console.error('savePayment error', err);
    }
}

// Одноразовые токены для скачивания
const USED_TOKENS_FILE = path.join(__dirname, 'used_tokens.json');
function loadUsedTokens() {
    try {
        if (!fs.existsSync(USED_TOKENS_FILE)) return [];
        const raw = fs.readFileSync(USED_TOKENS_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (err) {
        console.error('loadUsedTokens error', err);
        return [];
    }
}

function saveUsedToken(token) {
    try {
        const used = loadUsedTokens();
        used.push(token);
        fs.writeFileSync(USED_TOKENS_FILE, JSON.stringify(used, null, 2), 'utf8');
    } catch (err) {
        console.error('saveUsedToken error', err);
    }
}

function isTokenUsed(token) {
    const used = loadUsedTokens();
    return used.includes(token);
}

// Вебхук от YooKassa при успешной оплате
app.post('/webhook', (req, res) => {
    const event = req.body;

    if (!event || event.type !== 'notification' || event.event !== 'payment.succeeded') {
        return res.status(200).send('OK');
    }

    const payment = event.object;
    if (!payment || !payment.metadata) {
        return res.status(400).send('Missing payment metadata');
    }

    const { fileId, chatId } = payment.metadata;
    const item = catalog[fileId];

    if (!item || !chatId) {
        return res.status(400).send('Invalid payment metadata');
    }

    // Создаём временную защищённую ссылку (действительна N минут)
    const expiresSec = parseInt(process.env.DOWNLOAD_TOKEN_TTL || '900', 10);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresSec;
    const payload = `${fileId}|${chatId}|${expiresAt}`;
    const hmac = crypto.createHmac('sha256', DOWNLOAD_SECRET).update(payload).digest('hex');
    const token = Buffer.from(payload).toString('base64') + '.' + hmac;

    const appUrl = process.env.APP_URL || '';
    const downloadLink = appUrl ? `${appUrl}/download/${encodeURIComponent(token)}` : `/download/${encodeURIComponent(token)}`;

    bot.sendMessage(chatId, `✅ Оплата прошла успешно! Ваш файл: ${item.name}\nСсылка для скачивания (временно): ${downloadLink}`)
        .catch(err => console.error('bot.sendMessage error', err));

    savePayment({
        event: event.event,
        paymentId: payment.id,
        fileId,
        chatId,
        amount: payment.amount,
        datetime: new Date().toISOString(),
        downloadLink,
        receivedAt: new Date().toISOString()
    });

    res.status(200).send('OK');
});

// Маршрут для проверки и выдачи временных ссылок
app.get('/download/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const [b64, hmac] = token.split('.');
        if (!b64 || !hmac) return res.status(400).send('Bad token');

        const payload = Buffer.from(b64, 'base64').toString('utf8');
        const expected = crypto.createHmac('sha256', DOWNLOAD_SECRET).update(payload).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))) return res.status(403).send('Invalid token');

        const [fileId, chatId, expiresAtStr] = payload.split('|');
        const expiresAt = parseInt(expiresAtStr, 10);
        if (Math.floor(Date.now() / 1000) > expiresAt) return res.status(410).send('Link expired');

        if (isTokenUsed(token)) return res.status(410).send('Token already used');

        const item = catalog[fileId];
        if (!item) return res.status(404).send('File not found');

        saveUsedToken(token);

        const fileUrl = item.fileUrl;
        if (!fileUrl) return res.status(404).send('File not found');

        const response = await fetch(fileUrl);
        if (!response.ok || !response.body) {
            return res.status(502).send('Failed to fetch file from storage');
        }

        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        // Берём имя файла из Google Drive если есть, иначе из каталога
        const driveDisposition = response.headers.get('content-disposition');
        const contentDisposition = driveDisposition || `attachment; filename="${encodeURIComponent(item.name || 'file')}"`;

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', contentDisposition);
        res.setHeader('Cache-Control', 'no-store');

        const stream = Readable.fromWeb(response.body);
        stream.pipe(res);
    } catch (err) {
        console.error('download error', err);
        return res.status(400).send('Bad token');
    }
});

// Endpoint для приёма обновлений от Telegram, если используется webhook режим
app.post('/telegram-webhook', (req, res) => {
    try {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (err) {
        console.error('telegram webhook error', err);
        res.sendStatus(500);
    }
});

// API endpoint для получения каталога (для фронтенда)
app.get('/api/catalog', (req, res) => {
    res.json(catalog);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));