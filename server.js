require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const catalog = require('./catalog.json');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (!process.env.BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN not set in environment');
    process.exit(1);
}

// Telegram bot: polling by default, webhook if TELEGRAM_WEBHOOK_URL provided
let bot;
if (process.env.TELEGRAM_WEBHOOK_URL) {
    bot = new TelegramBot(process.env.BOT_TOKEN);
    bot.setWebHook(process.env.TELEGRAM_WEBHOOK_URL).catch(err => console.error('setWebHook error', err));
    console.log('Telegram bot configured in webhook mode');
} else {
    bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
    console.log('Telegram bot running in polling mode');
}

// Создание ссылки на оплату
app.post('/create-payment', (req, res) => {
    const { fileId, chatId } = req.body;
    const item = catalog[fileId];
    if (!item) return res.status(404).json({ error: 'Товар не найден' });

    // Если файл бесплатный, сразу отдаем ссылку на скачивание
    if (item.type === 'free') {
        return res.json({ freeUrl: item.fileUrl });
    }

    const label = `${fileId}_${chatId}_${Date.now()}`;
    const paymentUrl = `https://yoomoney.ru/quickpay/confirm?receiver=${process.env.YOO_WALLET}&quickpay-form=shop&sum=${item.price}&label=${label}&targets=Оплата файла: ${item.name}`;
    
    res.json({ paymentUrl });
});

// Отдать каталог в JSON (публично доступно)
app.get('/catalog', (req, res) => {
    res.json(catalog);
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

// Вебхук от ЮMoney при успешной оплате
app.post('/webhook', (req, res) => {
    const { notification_type, operation_id, amount, currency, datetime, sender, codepro, label, sha1_hash } = req.body;
    
    const hashString = `${notification_type}&${operation_id}&${amount}&${currency}&${datetime}&${sender}&${codepro}&${process.env.YOO_SECRET}&${label}`;
    const hash = crypto.createHash('sha1').update(hashString).digest('hex');

    if (hash !== sha1_hash) return res.status(400).send('Hash error');

    const [fileId, chatId] = label.split('_');
    const item = catalog[fileId];

    if (item && chatId) {
        // Создаём временную защищённую ссылку (действительна N минут)
        const expiresSec = parseInt(process.env.DOWNLOAD_TOKEN_TTL || '900', 10); // 15 минут по умолчанию
        const expiresAt = Math.floor(Date.now() / 1000) + expiresSec;
        const payload = `${fileId}|${chatId}|${expiresAt}`;
        const hmac = crypto.createHmac('sha256', process.env.YOO_SECRET || 'secret').update(payload).digest('hex');
        const token = Buffer.from(payload).toString('base64') + '.' + hmac;

        const appUrl = process.env.APP_URL || '';
        const downloadLink = appUrl ? `${appUrl}/download/${encodeURIComponent(token)}` : `/download/${encodeURIComponent(token)}`;

        bot.sendMessage(chatId, `✅ Оплата прошла успешно! Ваш файл: ${item.name}\nСсылка для скачивания (временно): ${downloadLink}`)
            .catch(err => console.error('bot.sendMessage error', err));

        // Сохраняем запись об оплате
        savePayment({ operation_id, fileId, chatId, amount, datetime, downloadLink, receivedAt: new Date().toISOString() });
    }
    res.status(200).send('OK');
});

// Маршрут для проверки и выдачи временных ссылок
app.get('/download/:token', (req, res) => {
    try {
        const token = req.params.token;
        const [b64, hmac] = token.split('.');
        const payload = Buffer.from(b64, 'base64').toString('utf8');
        const expected = crypto.createHmac('sha256', process.env.YOO_SECRET || 'secret').update(payload).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))) return res.status(403).send('Invalid token');

        const [fileId, chatId, expiresAtStr] = payload.split('|');
        const expiresAt = parseInt(expiresAtStr, 10);
        if (Math.floor(Date.now() / 1000) > expiresAt) return res.status(410).send('Link expired');

        const item = catalog[fileId];
        if (!item) return res.status(404).send('File not found');

        // Перенаправляем на фактический URL файла (можно заменить на проксирование/стриминг)
        return res.redirect(item.fileUrl);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));