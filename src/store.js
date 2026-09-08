'use strict';
const { randomUUID } = require('node:crypto');
class Store {
    constructor(pool) { this.pool = pool; }
    async init() {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY, user_id BIGINT NOT NULL, file_id TEXT NOT NULL,
                document TEXT NOT NULL, title TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount >= 0),
                status TEXT NOT NULL DEFAULT 'pending', charge_id TEXT UNIQUE,
                invoice_url TEXT, checkout_query TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                sent_at TIMESTAMPTZ, next_attempt TIMESTAMPTZ NOT NULL DEFAULT now(),
                attempts INTEGER NOT NULL DEFAULT 0, lease_until TIMESTAMPTZ,
                request_key TEXT NOT NULL, UNIQUE(user_id, request_key)
            );
            CREATE INDEX IF NOT EXISTS orders_delivery ON orders(status, next_attempt);
            CREATE TABLE IF NOT EXISTS administrators (role TEXT PRIMARY KEY CHECK(role='owner'), user_id BIGINT UNIQUE NOT NULL);
            CREATE TABLE IF NOT EXISTS catalog_overrides (file_id TEXT PRIMARY KEY, item JSONB NOT NULL);
            CREATE TABLE IF NOT EXISTS uploaded_documents (file_id TEXT PRIMARY KEY, name TEXT NOT NULL, size BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
            CREATE TABLE IF NOT EXISTS support_messages (message_id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL);
            CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires TIMESTAMPTZ NOT NULL);
        `);
    }
    async limit(key, maximum = 12) {
        const { rows } = await this.pool.query(`INSERT INTO rate_limits VALUES ($1,1,now()+interval '1 minute')
            ON CONFLICT (key) DO UPDATE SET count=CASE WHEN rate_limits.expires < now() THEN 1 ELSE rate_limits.count+1 END,
            expires=CASE WHEN rate_limits.expires < now() THEN now()+interval '1 minute' ELSE rate_limits.expires END RETURNING count`, [key]);
        return rows[0].count <= maximum;
    }
    async get(id) { return (await this.pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0]; }
    async owned(user, file) {
        return (await this.pool.query("SELECT * FROM orders WHERE user_id=$1 AND file_id=$2 AND status IN ('paid','sent') AND amount>0 ORDER BY created_at DESC LIMIT 1", [user, file])).rows[0];
    }
    async create({ user, file, document, title, amount, requestKey }) {
        return (await this.pool.query(`INSERT INTO orders (id,user_id,file_id,document,title,amount,status,request_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,request_key) DO UPDATE SET request_key=orders.request_key RETURNING *`,
        [randomUUID(), user, file, document, title, amount, amount ? 'pending' : 'paid', requestKey])).rows[0];
    }
    async invoice(id, url) { await this.pool.query('UPDATE orders SET invoice_url=$2 WHERE id=$1', [id,url]); }
    async checkout(id, queryId) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const order = (await client.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
            if (!order) { await client.query('ROLLBACK'); return false; }
            // Serialize payment acceptance per buyer, including across server instances.
            await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[order.user_id]);
            const result = await client.query(`UPDATE orders SET status='checkout',checkout_query=$2
                WHERE id=$1 AND (status='pending' OR (status='checkout' AND checkout_query=$2))
                AND created_at > now()-interval '1 hour'
                AND NOT EXISTS (SELECT 1 FROM orders other WHERE other.user_id=orders.user_id
                    AND other.file_id=orders.file_id AND other.id<>orders.id
                    AND (other.status IN ('paid','sent') OR (other.status='checkout' AND other.created_at>now()-interval '1 hour')))
                RETURNING id`, [id,queryId]);
            await client.query('COMMIT');
            return result.rowCount === 1;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
    }
    async paid(id, charge) {
        await this.pool.query(`UPDATE orders SET status='paid', charge_id=$2 WHERE id=$1 AND status IN ('pending','checkout') AND charge_id IS NULL`, [id,charge]);
    }
    async refunded(charge) { await this.pool.query("UPDATE orders SET status='refunded' WHERE charge_id=$1", [charge]); }
    async resend(id) { await this.pool.query("UPDATE orders SET status='paid', next_attempt=now() WHERE id=$1 AND status='sent'", [id]); }
    async claim() {
        return (await this.pool.query(`UPDATE orders SET lease_until=now()+interval '1 minute', attempts=attempts+1
            WHERE id=(SELECT id FROM orders WHERE status='paid' AND next_attempt<=now()
            AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_attempt FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)).rows[0];
    }
    async delivered(id) { await this.pool.query("UPDATE orders SET status='sent',sent_at=now(),lease_until=NULL WHERE id=$1 AND status='paid'", [id]); }
    async failed(id, delay) { await this.pool.query("UPDATE orders SET lease_until=NULL,next_attempt=now()+($2 * interval '1 second') WHERE id=$1", [id,delay]); }
    async recent(user) { return (await this.pool.query("SELECT * FROM orders WHERE user_id=$1 AND status IN ('paid','sent') AND amount>0 ORDER BY created_at DESC LIMIT 10", [user])).rows; }
    async owner() { return (await this.pool.query("SELECT user_id FROM administrators WHERE role='owner'")).rows[0]?.user_id; }
    async enroll(user) { await this.pool.query("INSERT INTO administrators VALUES ('owner',$1) ON CONFLICT DO NOTHING",[user]); return String(await this.owner())===String(user); }
    async catalog(base) { return { ...base, ...Object.fromEntries((await this.pool.query('SELECT * FROM catalog_overrides')).rows.map(r=>[r.file_id,r.item])) }; }
    async saveItem(id,item) { await this.pool.query('INSERT INTO catalog_overrides VALUES ($1,$2) ON CONFLICT(file_id) DO UPDATE SET item=$2',[id,JSON.stringify(item)]); }
    async upload(doc) { await this.pool.query('INSERT INTO uploaded_documents(file_id,name,size) VALUES ($1,$2,$3) ON CONFLICT(file_id) DO UPDATE SET name=$2',[doc.file_id,doc.file_name || 'Документ',doc.file_size || null]); }
    async uploads() { return (await this.pool.query('SELECT * FROM uploaded_documents ORDER BY created_at DESC LIMIT 100')).rows; }
    async adminOrders() { return (await this.pool.query('SELECT id,user_id,file_id,title,amount,status,created_at,sent_at,attempts FROM orders ORDER BY created_at DESC LIMIT 100')).rows; }
    async supportLink(message, user) { await this.pool.query('INSERT INTO support_messages VALUES ($1,$2) ON CONFLICT DO NOTHING', [message,user]); }
    async supportTarget(message) { return (await this.pool.query('SELECT user_id FROM support_messages WHERE message_id=$1', [message])).rows[0]?.user_id; }
    async nextWake() {
        const row = (await this.pool.query("SELECT EXTRACT(EPOCH FROM (min(GREATEST(next_attempt,COALESCE(lease_until,next_attempt)))-now())) AS delay FROM orders WHERE status='paid'")).rows[0];
        return row.delay == null ? 900000 : Math.max(1000, Math.min(900000, Number(row.delay)*1000));
    }
    async cleanup() { await this.pool.query("DELETE FROM rate_limits WHERE expires < now()-interval '1 day'"); }
}
module.exports = { Store };
