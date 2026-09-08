'use strict';
const express = require('express');
const path = require('node:path');
const { sameSecret, verifyInitData, validFile, publicCatalog, paymentMatches } = require('./security');
const wrap = fn => (req,res,next) => Promise.resolve().then(() => fn(req,res,next)).catch(next);
function createApp({ store, telegram, env, catalog, onWork = () => {} }) {
    const app = express();
    app.disable('x-powered-by');
    app.use((req,res,next) => {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Referrer-Policy', 'no-referrer');
        res.set('Cache-Control', 'no-store');
        res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org");
        next();
    });
    app.use(express.json({ limit: '32kb' }));
    const sendText = (chat_id, text, extra = {}) => telegram('sendMessage', { chat_id, text, ...extra });
    async function admin(user) {
        const owner = await store.owner();
        if (owner) return String(user.id) === String(owner);
        if (env.ADMIN_CHAT_ID) return String(user.id) === env.ADMIN_CHAT_ID && store.enroll(user.id);
        if (user.username?.toLowerCase() === (env.ADMIN_USERNAME || 'AxmIldan').toLowerCase()) return store.enroll(user.id);
        return false;
    }
    app.get('/api/catalog', wrap(async (req,res) => res.json(publicCatalog(await store.catalog(catalog)))));
    app.get('/health', (req,res) => res.json({ ok: true }));
    app.use('/api', wrap(async (req,res,next) => {
        try { req.user = verifyInitData(req.get('X-Telegram-Init-Data'), env.BOT_TOKEN); }
        catch { return res.status(401).json({ error: 'Откройте приложение заново через Telegram.' }); }
        if (!await store.limit('api:' + req.user.id, 30)) return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' });
        if (req.method !== 'GET') res.on('finish', onWork);
        next();
    }));
    const api = express.Router();
    api.post('/action', wrap(async (req,res) => {
        const { fileId, preview = false, requestKey } = req.body;
        const items = await store.catalog(catalog);
        if (typeof fileId !== 'string' || !Object.hasOwn(items,fileId)) return res.status(404).json({ error: 'Материал не найден.' });
        if (typeof preview !== 'boolean' || typeof requestKey !== 'string' || !/^[a-f0-9-]{36}$/.test(requestKey)) return res.status(400).json({ error: 'Некорректный запрос.' });
        const item = items[fileId], user = req.user.id;
        if (!await store.limit('action:' + user, 8)) return res.status(429).json({ error: 'Подождите минуту перед следующим запросом.' });
        if (!preview) {
            const owned = await store.owned(user,fileId);
            if (owned) { await store.resend(owned.id); return res.json({ queued: true, orderId: owned.id }); }
        }
        const document = preview ? item.taskTelegramFileId : item.telegramFileId;
        if (!validFile(document)) return res.status(409).json({ error: 'Файл ещё не подготовлен. Напишите в поддержку.' });
        if (item.disabled && !preview) return res.status(409).json({ error: 'Материал временно недоступен.' });
        const amount = preview || item.type === 'free' ? 0 : item.priceStars;
        if (amount > 0 && !await store.owner()) return res.status(409).json({ error: 'Магазин ещё настраивается.' });
        if (!Number.isSafeInteger(amount) || amount < 0 || (item.type === 'paid' && !preview && amount === 0)) return res.status(409).json({ error: 'Цена пока не назначена.' });
        const member = await telegram('getChat', { chat_id: user });
        if (!member || ['left','kicked'].includes(member.status)) return res.status(409).json({ error: 'Сначала нажмите /start в чате с ботом.' });
        const order = await store.create({ user, file: (preview ? 'task:' : '') + fileId, document,
            title: (preview ? 'Задание: ' : '') + item.name + ' — ' + item.variant, amount, requestKey });
        if (order.file_id !== (preview ? 'task:' : '') + fileId) return res.status(409).json({ error: 'Повторите запрос.' });
        if (order.status === 'paid' || order.status === 'sent') return res.json({ queued: true, orderId: order.id });
        if (order.status !== 'pending') return res.status(409).json({ error: 'Этот счёт уже обрабатывается. Проверьте чат с ботом.' });
        let invoiceUrl = order.invoice_url;
        if (!invoiceUrl) {
            invoiceUrl = await telegram('createInvoiceLink', { title: order.title.slice(0,32),
                description: 'Готовый материал. После оплаты документ придёт в этот чат.',
                payload: order.id, provider_token: '', currency: 'XTR', prices: [{ label: 'Материал', amount: order.amount }] });
            await store.invoice(order.id, invoiceUrl);
        }
        res.json({ invoiceUrl, orderId: order.id });
    }));
    api.get('/orders/:id', wrap(async (req,res) => {
        const order = await store.get(req.params.id);
        if (!order || String(order.user_id) !== String(req.user.id)) return res.sendStatus(404);
        res.json({ status: order.status });
    }));
    async function support(user, text) {
        const owner = await store.owner();
        if (!owner) throw new Error('Support unavailable');
        if (typeof text !== 'string' || !text.trim() || text.length > 3000) return false;
        if (!await store.limit('support:' + user, 5)) return false;
        const message = await sendText(owner, 'Вопрос от пользователя ' + user + ':\n\n' + text);
        await store.supportLink(message.message_id, user);
        return true;
    }
    api.post('/support', wrap(async (req,res) => {
        if (!await support(req.user.id, req.body.text)) return res.status(429).json({ error: 'Введите вопрос до 3000 символов или повторите через минуту.' });
        res.json({ sent: true });
    }));
    api.use('/admin', wrap(async (req,res,next) => {
        if (!await admin(req.user)) return res.sendStatus(403);
        next();
    }));
    api.get('/admin/catalog', wrap(async (req,res) => res.json({ items: await store.catalog(catalog), uploads: await store.uploads() })));
    api.put('/admin/catalog/:id', wrap(async (req,res) => {
        const item = req.body, id = req.params.id;
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || ['__proto__','constructor','prototype'].includes(id)) return res.status(400).json({ error: 'Некорректный ID.' });
        for (const key of ['course','semester','subject','name','variant','desc']) {
            if (typeof item[key] !== 'string' || item[key].length > (key === 'desc' ? 3000 : 200) || (key !== 'desc' && !item[key].trim())) return res.status(400).json({ error: 'Проверьте поля материала.' });
        }
        if (!['free','paid'].includes(item.type) || (item.priceStars != null && (!Number.isSafeInteger(item.priceStars) || item.priceStars < 1 || item.priceStars > 100000))) return res.status(400).json({ error: 'Цена должна быть целым числом Stars от 1 до 100000.' });
        for (const key of ['telegramFileId','taskTelegramFileId']) if (item[key] && !validFile(item[key])) return res.status(400).json({ error: 'Некорректный файл Telegram.' });
        const clean = Object.fromEntries(['course','semester','subject','name','variant','desc','type','priceStars','telegramFileId','taskTelegramFileId'].map(k=>[k,item[k] ?? null]));
        clean.disabled = Boolean(item.disabled);
        await store.saveItem(id,clean);
        res.json({ saved: true });
    }));
    api.get('/admin/orders', wrap(async (req,res) => res.json(await store.adminOrders())));
    api.post('/admin/orders/:id/resend', wrap(async (req,res) => {
        const order = await store.get(req.params.id);
        if (!order || !['paid','sent'].includes(order.status)) return res.status(409).json({error:'Заказ недоступен для выдачи.'});
        await store.resend(order.id);
        res.json({ queued:true });
    }));
    api.post('/admin/orders/:id/refund', wrap(async (req,res) => {
        const order = await store.get(req.params.id);
        if (!order?.charge_id || !['paid','sent','refunded'].includes(order.status)) return res.status(409).json({error:'Нет оплаченного заказа.'});
        if (order.status !== 'refunded') {
            await telegram('refundStarPayment',{user_id:Number(order.user_id),telegram_payment_charge_id:order.charge_id});
            await store.refunded(order.charge_id);
        }
        res.json({ refunded:true });
    }));
    app.use('/api', api);
    app.post('/telegram-webhook', wrap(async (req,res) => {
        if (!sameSecret(req.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET)) return res.sendStatus(403);
        res.on('finish', onWork);
        const update = req.body;
        if (!Number.isSafeInteger(update?.update_id)) return res.sendStatus(400);
        if (update.pre_checkout_query) {
            const q = update.pre_checkout_query;
            const order = await store.get(q.invoice_payload);
            const ok = paymentMatches(order,q,q.from?.id) && await store.checkout(order.id, q.id);
            await telegram('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok,
                ...(ok ? {} : { error_message: 'Счёт недействителен или уже оплачен. Откройте приложение и выберите материал снова.' }) });
            return res.sendStatus(200);
        }
        const m = update.message;
        if (!m || m.chat?.type !== 'private' || m.from?.id !== m.chat.id) return res.sendStatus(200);
        const user = m.from.id;
        const isAdmin = await admin(m.from);
        if (m.successful_payment) {
            const p = m.successful_payment, order = await store.get(p.invoice_payload);
            if (!paymentMatches(order,p,user) || typeof p.telegram_payment_charge_id !== 'string') {
                console.error('Payment mismatch; update', update.update_id);
                return res.sendStatus(400);
            }
            await store.paid(order.id,p.telegram_payment_charge_id);
        } else if (m.refunded_payment) {
            await store.refunded(m.refunded_payment.telegram_payment_charge_id);
        } else if (isAdmin && m.text?.startsWith('/refund ')) {
            const order = await store.get(m.text.slice(8).trim());
            if (!order?.charge_id || !['paid','sent','refunded'].includes(order.status)) {
                await sendText(user,'Оплаченный заказ не найден.');
            } else if (order.status === 'refunded') {
                await sendText(user,'Возврат уже выполнен.');
            } else {
                await telegram('refundStarPayment', { user_id: Number(order.user_id), telegram_payment_charge_id: order.charge_id });
                await store.refunded(order.charge_id);
                await sendText(user,'Stars возвращены. Заказ: ' + order.id);
            }
        } else if (isAdmin && m.document) {
            await store.upload(m.document);
            await sendText(user, 'telegramFileId для решения (или taskTelegramFileId для задания):\n' + m.document.file_id + '\nИмя: ' + m.document.file_name);
        } else if (isAdmin && m.reply_to_message && m.text) {
            const target = await store.supportTarget(m.reply_to_message.message_id);
            if (target) await sendText(target,'Ответ поддержки:\n' + m.text);
            else await sendText(user,'Ответьте на сообщение бота с вопросом студента.');
        } else if (m.text?.match(/^\/start(?:\s|$)/)) {
            await sendText(user,'Выберите материал в приложении. Решение придёт сюда документом. Для повторной выдачи: /purchases. Для помощи: /paysupport.', {
                reply_markup: { inline_keyboard: [[{ text: 'Открыть материалы', web_app: { url: env.APP_URL } }], ...(isAdmin ? [[{ text: 'Админка', web_app: { url: new URL('/admin',env.APP_URL).href } }]] : [])] }
            });
        } else if (m.text === '/purchases') {
            if (await store.limit('purchases:' + user, 2)) {
                const orders = await store.recent(user);
                for (const order of orders) await store.resend(order.id);
                await sendText(user, orders.length ? 'Последние покупки поставлены в очередь повторной отправки.' : 'Покупок пока нет.');
            }
        } else if (m.text === '/paysupport' || m.text === '/support') {
            await sendText(user,'Напишите вопрос следующим сообщением. По оплате укажите название материала и номер заказа из счёта. Ответ придёт от этого бота.');
        } else if (m.text && !(isAdmin)) {
            const sent = await support(user,m.text);
            await sendText(user, sent ? 'Вопрос передан поддержке. Ответ придёт в этот чат.' : 'Не удалось передать вопрос. Повторите через минуту; максимум 3000 символов.');
        }
        res.sendStatus(200);
    }));
    app.all(['/create-payment','/webhook','/download/:token'], (req,res) => res.status(410).json({ error: 'Старые ссылки отключены. Откройте приложение через Telegram или напишите /paysupport боту.' }));
    app.use(express.static(path.join(__dirname,'../public'), { index: false }));
    app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'../public/admin.html')));
    app.get('/', (req,res) => res.sendFile(path.join(__dirname,'../index.html')));
    app.use((err,req,res,next) => {
        if (res.headersSent) return next(err);
        if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Запрос слишком большой.' });
        if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Некорректный JSON.' });
        console.error('Request failed', req.path, err.code || '');
        res.status(503).json({ error: 'Сервис временно недоступен. Проверьте, что бот запущен, и повторите позже.' });
    });
    let running = false;
    async function deliverPending() {
        if (running) return;
        running = true;
        try {
            await store.cleanup();
            for (let i = 0; i < 10; i++) {
                const order = await store.claim();
                if (!order) break;
                try {
                    await telegram('sendDocument', { chat_id: order.user_id, document: order.document,
                        caption: (order.title + '\nЗаказ: ' + order.id).slice(0,1024) });
                    await store.delivered(order.id);
                } catch (err) {
                    await store.failed(order.id, Math.max(err.retryAfter || 0, Math.min(3600, 5 * 2 ** Math.min(order.attempts,10))));
                    console.error('Delivery pending', order.id, err.code || '');
                }
            }
        } finally { running = false; }
    }
    return { app, deliverPending };
}
module.exports = { createApp };
