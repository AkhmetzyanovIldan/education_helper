'use strict';
const crypto = require('node:crypto');
function sameSecret(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function verifyInitData(raw, token, now = Math.floor(Date.now() / 1000)) {
    if (typeof raw !== 'string' || raw.length > 16384) throw new Error('Invalid auth');
    const params = new URLSearchParams(raw);
    if (new Set(params.keys()).size !== [...params.keys()].length) throw new Error('Duplicate fields');
    const hash = params.get('hash');
    params.delete('hash');
    const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => k + '=' + v).join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const expected = crypto.createHmac('sha256', key).update(check).digest('hex');
    if (!sameSecret(hash, expected)) throw new Error('Invalid signature');
    const date = Number(params.get('auth_date'));
    if (!Number.isInteger(date) || date > now + 30 || now - date > 3600) throw new Error('Expired auth');
    const user = JSON.parse(params.get('user'));
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('Invalid user');
    return user;
}
const validFile = value => typeof value === 'string' && /^[A-Za-z0-9_-]{10,512}$/.test(value);
function publicCatalog(catalog) {
    return Object.fromEntries(Object.entries(catalog).map(([id, item]) => [id, {
        course: item.course, semester: item.semester, subject: item.subject,
        name: item.name, variant: item.variant, desc: item.desc, type: item.type,
        priceStars: Number.isSafeInteger(item.priceStars) && item.priceStars > 0 ? item.priceStars : null,
        available: !item.disabled && validFile(item.telegramFileId) && (item.type === 'free' || (Number.isSafeInteger(item.priceStars) && item.priceStars > 0)),
        hasTaskFile: validFile(item.taskTelegramFileId)
    }]));
}
function paymentMatches(order, payment, userId) {
    return Boolean(order && String(order.user_id) === String(userId) && payment.currency === 'XTR'
        && order.amount === payment.total_amount && order.id === payment.invoice_payload && order.amount > 0);
}
module.exports = { sameSecret, verifyInitData, validFile, publicCatalog, paymentMatches };
