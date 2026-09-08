'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { Store } = require('../src/store');
const { createApp } = require('../src/app');
const { verifyInitData } = require('../src/security');
const env = { BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret-not-real', APP_URL:'https://example.test', ADMIN_USERNAME:'AxmIldan' };
function auth(id=123, username='student', date=Math.floor(Date.now()/1000)) {
    const params=new URLSearchParams({auth_date:String(date),user:JSON.stringify({id,username})});
    const check=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
    const key=crypto.createHmac('sha256','WebAppData').update(env.BOT_TOKEN).digest();
    params.set('hash',crypto.createHmac('sha256',key).update(check).digest('hex'));
    return params.toString();
}
test('initData: signature, expiration, future dates, duplicates and forged user',()=>{
    assert.equal(verifyInitData(auth(),env.BOT_TOKEN).id,123);
    for(const raw of [auth().replace('student','attacker'),auth(123,'student',1),auth(123,'student',Math.floor(Date.now()/1000)+1000),auth()+'&user={}',auth().replace(/hash=.*/, 'hash=x')]) assert.throws(()=>verifyInitData(raw,env.BOT_TOKEN));
});
test('HTTP + real PostgreSQL engine: payment, delivery, authorization and administration',async t=>{
    const db=new PGlite();
    const pool={
        async query(sql,args) {
            if (!args && sql.includes('CREATE TABLE')) {await db.exec(sql);return {rows:[],rowCount:0};}
            const result=await db.query(sql,args);
            return {...result,rowCount:result.affectedRows ?? result.rows.length};
        },
        async connect(){return {...this,release(){}};}
    };
    const store=new Store(pool); await store.init();
    const catalog={
        paid:{course:'1 курс',semester:'1 семестр',subject:'Математика',name:'Решение',variant:'1',desc:'Задание',type:'paid',priceStars:25,telegramFileId:'solution_file_id_123',taskTelegramFileId:'task_file_id_123',fileUrl:'https://secret.example/file'},
        free:{course:'1 курс',semester:'1 семестр',subject:'Математика',name:'Бесплатно',variant:'1',desc:'Описание',type:'free',telegramFileId:'free_file_id_123'},
        missing:{type:'paid',price:100,fileUrl:'https://secret.example/file'}
    };
    let calls=[], failSend=false, messageId=1;
    const telegram=async(method,body)=>{
        calls.push({method,body});
        if(method==='sendDocument' && failSend) throw Object.assign(new Error('temporary'),{code:429,retryAfter:2});
        if(method==='createInvoiceLink') return 'https://t.me/$test';
        return {message_id:messageId++,status:'member',id:body.chat_id};
    };
    const {app,deliverPending}=createApp({store,telegram,env,catalog});
    const server=app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.on('listening',resolve));
    const url='http://127.0.0.1:'+server.address().port;
    t.after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
    async function request(route,{body,user=123,username='student',method,headers={}}={}) {
        const response=await fetch(url+route,{method:method || (body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Telegram-Init-Data':auth(user,username),...headers},...(body?{body:JSON.stringify(body)}:{})});
        return {status:response.status,data:await response.json().catch(()=>null)};
    }
    let updateId=1;
    const webhook=body=>request('/telegram-webhook',{body:{update_id:updateId++,...body},headers:{'X-Telegram-Bot-Api-Secret-Token':env.TELEGRAM_WEBHOOK_SECRET}});
    const message=(user,extra)=>({message:{from:{id:user,username:user===999?'AxmIldan':'student'},chat:{id:user,type:'private'},...extra}});
    const action=(fileId,extra={})=>request('/api/action',{body:{fileId,requestKey:crypto.randomUUID(),...extra}});
    await t.test('public catalog has no storage URLs or file IDs',async()=>{
        const r=await request('/api/catalog');
        assert.equal(r.status,200);
        assert.equal(JSON.stringify(r.data).includes('secret.example'),false);
        assert.equal(r.data.paid.telegramFileId,undefined);
        assert.equal(r.data.missing.available,false);
    });
    await t.test('forged identities and old payment webhook cannot issue files',async()=>{
        assert.equal((await request('/api/action',{body:{fileId:'free',chatId:999},headers:{'X-Telegram-Init-Data':'fake'}})).status,401);
        assert.equal((await request('/telegram-webhook',{body:{update_id:1,message:{successful_payment:{}}}})).status,403);
        assert.equal((await request('/webhook',{body:{event:'payment.succeeded'}})).status,410);
        assert.equal(calls.length,0);
    });
    await t.test('admin is pinned to verified user ID; username reuse gives no access',async()=>{
        assert.equal((await request('/api/admin/catalog')).status,403);
        assert.equal((await request('/api/admin/catalog',{user:999,username:'AxmIldan'})).status,200);
        assert.equal((await request('/api/admin/catalog',{user:998,username:'AxmIldan'})).status,403);
        assert.equal((await request('/api/admin/catalog',{user:999,username:'renamed'})).status,200);
    });
    let order;
    await t.test('paid action creates Stars invoice and no delivery before payment',async()=>{
        const r=await action('paid',{chatId:999});
        assert.equal(r.status,200);order=await store.get(r.data.orderId);
        assert.equal(Number(order.user_id),123);
        assert.equal(order.amount,25);
        await deliverPending();
        assert.equal(calls.filter(c=>c.method==='sendDocument').length,0);
        assert.equal((await request('/api/orders/'+order.id,{user:444})).status,404);
    });
    await t.test('checkout validates user, currency, amount; replay of same query is safe',async()=>{
        const q={id:'checkout1',from:{id:123},invoice_payload:order.id,currency:'XTR',total_amount:25};
        for(const extra of [{from:{id:999}},{currency:'RUB'},{total_amount:1}]) {
            assert.equal((await webhook({pre_checkout_query:{...q,...extra}})).status,200);
            assert.equal(calls.at(-1).body.ok,false);
        }
        assert.equal((await webhook({pre_checkout_query:q})).status,200);
        assert.equal(calls.at(-1).body.ok,true);
        assert.equal((await webhook({pre_checkout_query:q})).status,200);
        assert.equal(calls.at(-1).body.ok,true);
        await deliverPending();
        assert.equal(calls.filter(c=>c.method==='sendDocument').length,0);
    });
    await t.test('a second order for the same material cannot be checked out concurrently',async()=>{
        const other=await store.create({user:123,file:'paid',document:'solution_file_id_123',title:'Duplicate',amount:25,requestKey:crypto.randomUUID()});
        assert.equal(await store.checkout(other.id,'another_query'),false);
    });
    const payment={invoice_payload:null,currency:'XTR',total_amount:25,telegram_payment_charge_id:'charge1'};
    await t.test('only successful_payment unlocks file; duplicate update sends once',async()=>{
        payment.invoice_payload=order.id;
        assert.equal((await webhook(message(123,{successful_payment:{...payment,total_amount:1}}))).status,400);
        assert.equal((await webhook(message(123,{successful_payment:payment}))).status,200);
        await webhook(message(123,{successful_payment:payment}));
        await deliverPending();
        await webhook(message(123,{successful_payment:payment}));
        await deliverPending();
        const sends=calls.filter(c=>c.method==='sendDocument');
        assert.equal(sends.length,1);
        assert.equal(sends[0].body.document,'solution_file_id_123');
        assert.equal(Number(sends[0].body.chat_id),123);
    });
    await t.test('repeat purchase issues owned file without second invoice',async()=>{
        const before=calls.filter(c=>c.method==='createInvoiceLink').length;
        assert.equal((await action('paid')).data.queued,true);
        await deliverPending();
        assert.equal(calls.filter(c=>c.method==='createInvoiceLink').length,before);
    });
    await t.test('free and task documents use queue; retries survive new Store instance',async()=>{
        const r=await action('free'); assert.equal(r.data.queued,true);
        failSend=true; await deliverPending();
        assert.equal((await store.get(r.data.orderId)).status,'paid');
        failSend=false;
        await pool.query("UPDATE orders SET next_attempt=now() WHERE id=$1",[r.data.orderId]);
        const restarted=createApp({store:new Store(pool),telegram,env,catalog});
        await restarted.deliverPending();
        assert.equal((await store.get(r.data.orderId)).status,'sent');
        const preview=await action('paid',{preview:true});
        assert.equal(preview.data.queued,true);
        await deliverPending();
        assert.equal(calls.at(-1).body.document,'task_file_id_123');
    });
    await t.test('idempotency key cannot be repurposed and missing files cannot be sold',async()=>{
        const key=crypto.randomUUID();
        const first=await action('free',{requestKey:key});
        const second=await action('free',{requestKey:key});
        assert.equal(first.data.orderId,second.data.orderId);
        assert.equal((await action('paid',{preview:true,requestKey:key})).status,409);
        await pool.query('DELETE FROM rate_limits');
        assert.equal((await action('missing')).status,409);
    });
    await t.test('support actually routes messages and only owner can reply',async()=>{
        assert.equal((await request('/api/support',{body:{text:'Где файл?'}})).status,200);
        const sent=calls.at(-1); assert.equal(Number(sent.body.chat_id),999);
        const adminMessage=messageId-1;
        await webhook(message(999,{text:'Помогу',reply_to_message:{message_id:adminMessage}}));
        assert.equal(Number(calls.at(-1).body.chat_id),123);
        assert.match(calls.at(-1).body.text,/Помогу/);
    });
    await t.test('admin uploads documents, edits catalog and refunds a payment',async()=>{
        await webhook(message(999,{document:{file_id:'admin_document_123',file_name:'тест.xlsx',file_size:123}}));
        const uploaded=await store.uploads(); assert.equal(uploaded[0].name,'тест.xlsx');
        const item={...catalog.free,telegramFileId:'admin_document_123',priceStars:null};
        assert.equal((await request('/api/admin/catalog/new',{user:999,body:item,method:'PUT'})).status,200);
        assert.equal((await request('/api/catalog')).data.new.available,true);
        assert.equal((await request('/api/admin/orders/'+order.id+'/refund',{user:123,body:{}})).status,403);
        assert.equal((await request('/api/admin/orders/'+order.id+'/refund',{user:999,body:{}})).status,200);
        assert.equal((await store.get(order.id)).status,'refunded');
        assert.equal((await request('/api/admin/orders/'+order.id+'/refund',{user:999,body:{}})).status,200);
        assert.equal(calls.filter(c=>c.method==='refundStarPayment').length,1);
    });
    await t.test('rate limiter and invalid JSON fail safely',async()=>{
        for(let i=0;i<6;i++) await request('/api/support',{user:555,body:{text:'test'}});
        assert.equal((await request('/api/support',{user:555,body:{text:'test'}})).status,429);
        const r=await fetch(url+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'});
        assert.equal(r.status,400);
    });
});
