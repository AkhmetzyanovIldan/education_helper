'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const { createApp } = require('./src/app');
const { Store } = require('./src/store');
const { createWorker } = require('./src/worker');
const { telegramClient } = require('./src/telegram');
async function main() {
    const env = process.env;
    for (const key of ['BOT_TOKEN', 'DATABASE_URL', 'APP_URL', 'TELEGRAM_WEBHOOK_SECRET']) {
        if (!env[key]) throw new Error('Set ' + key);
    }
    if (!/^https:\/\//.test(env.APP_URL)) throw new Error('APP_URL must use HTTPS');
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) throw new Error('Invalid webhook secret');
    if (env.ADMIN_CHAT_ID && !/^[1-9][0-9]+$/.test(env.ADMIN_CHAT_ID)) throw new Error('ADMIN_CHAT_ID must be your personal Telegram user id');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
    pool.on('error', () => console.error('Database connection failed'));
    const store = new Store(pool);
    await store.init();
    const telegram = telegramClient(env.BOT_TOKEN);
    let worker;
    const { app, deliverPending } = createApp({ store, telegram, env, catalog: require('./catalog.json'), onWork: () => worker?.wake() });
    const server = app.listen(env.PORT || 3000, () => console.log('Server listening'));
    await telegram('setWebhook', {
        url: new URL('/telegram-webhook', env.APP_URL).href,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'pre_checkout_query'], drop_pending_updates: false
    });
    worker = createWorker(deliverPending, () => store.nextWake());
    worker.wake();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        worker.stop();
        server.close(() => pool.end().then(() => process.exit(0)));
    });
}
if (require.main === module) main().catch(err => { console.error('Startup failed:', err.message.replace(/https?:\/\/\S+/g, '[URL]')); process.exit(1); });
