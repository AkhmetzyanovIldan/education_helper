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
    async function request(route,{body,user=123,username='student',method,headers={},origin=url}={}) {
        const response=await fetch(origin+route,{method:method || (body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Telegram-Init-Data':auth(user,username),...headers},...(body?{body:JSON.stringify(body)}:{})});
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
        const item={...catalog.free,telegramFileId:'admin_document_123',priceStars:null,materialCode:'0101110101_01'};
        assert.equal((await request('/api/admin/catalog/0101110101_01',{user:999,body:item,method:'PUT'})).status,200);
        assert.equal((await request('/api/catalog')).data['0101110101_01'].available,true);
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
    await t.test('storage group accepts only the owner in the bound group and indexes topics',async()=>{
        const group=(id,user,extra)=>({message:{message_id:50,from:{id:user},chat:{id,type:'supergroup'},...extra}});
        await webhook(group(-100777,123,{text:'/bind_storage'}));
        assert.equal(await store.storageGroup(),undefined);
        await webhook(group(-100777,999,{text:'/bind_storage'}));
        assert.equal(Number(await store.storageGroup()),-100777);
        await webhook(group(-100777,999,{message_thread_id:10,forum_topic_created:{name:'Математика'}}));
        await webhook(group(-100777,123,{document:{file_id:'outsider_file_123',file_name:'bad.pdf'}}));
        await webhook(group(-100888,999,{document:{file_id:'other_group_file_123',file_name:'wrong.pdf'}}));
        await webhook(group(-100777,999,{message_thread_id:10,document:{file_id:'topic_file_123',file_name:'решение.pdf'}}));
        assert.equal((await store.uploads('Математика')).length,1);
        assert.equal((await store.uploads('bad.pdf')).length,0);
        assert.equal((await store.uploads('wrong.pdf')).length,0);
        assert.equal((await store.uploads('решение.pdf'))[0].folder,'Математика');
        assert.equal((await request('/api/admin/uploads/topic_file_123',{user:123,method:'PUT',body:{folder:'hack'}})).status,403);
        assert.equal((await request('/api/admin/uploads/topic_file_123',{user:999,method:'PUT',body:{folder:'1 курс / Математика'}})).status,200);
        assert.equal((await store.uploads('1 курс')).length,1);
    });
    await t.test('YooKassa verifies merchant, mode, amount and payment; return link does not grant delivery',async()=>{
        await pool.query('DELETE FROM rate_limits');
        const yooEnv={...env,PAYMENT_PROVIDER:'yookassa',YOOKASSA_SHOP_ID:'shop',YOOKASSA_SECRET_KEY:'test-key',YOOKASSA_TEST_MODE:'true'};
        const payments=new Map(),yooCalls=[];
        const yookassa=async(method,path,body,key)=>{
            yooCalls.push({method,path,body,key});
            if(method==='POST' && path==='payments'){
                const p={id:'yoo-'+key,status:'pending',paid:false,test:true,recipient:{account_id:'shop'},amount:body.amount,metadata:body.metadata,confirmation:{confirmation_url:'https://yookassa.ru/test-payment'}};
                payments.set(p.id,p);return p;
            }
            if(path==='refunds')return {status:'succeeded',id:'refund',payment_id:body.payment_id,amount:body.amount};
            if(path.startsWith('refunds/')) { const p=[...payments.values()][0];return {status:'succeeded',id:'refund',payment_id:p.id,amount:p.amount}; }
            return payments.get(path.slice('payments/'.length));
        };
        const yooApp=createApp({store,telegram:async(method,body)=>method==='getMe'?{username:'EducationTestBot'}:telegram(method,body),env:yooEnv,catalog:{rub:{...catalog.paid,priceRub:100}},yookassa});
        const srv=yooApp.app.listen(0,'127.0.0.1');await new Promise(resolve=>srv.on('listening',resolve));
        const origin='http://127.0.0.1:'+srv.address().port;
        try {
            const purchase=await request('/api/action',{origin,user:888,body:{fileId:'rub',requestKey:crypto.randomUUID()}});
            assert.equal(purchase.status,200);
            const order=await store.get(purchase.data.orderId),p=payments.get(order.provider_payment_id);
            assert.equal(order.amount,10000);assert.equal(order.currency,'RUB');
            assert.equal(yooCalls[0].body.confirmation.return_url,'https://t.me/EducationTestBot?start=order_'+order.id);
            const again=await request('/api/action',{origin,user:888,body:{fileId:'rub',requestKey:crypto.randomUUID()}});
            assert.equal(again.data.orderId,order.id);assert.equal(yooCalls.filter(c=>c.method==='POST').length,1);
            const incoming=()=>request('/yookassa-webhook',{origin,body:{type:'notification',event:'payment.succeeded',object:{id:p.id,paid:true,status:'succeeded'}}});
            await incoming();await yooApp.deliverPending();
            assert.equal((await store.get(order.id)).status,'pending');
            p.paid=true;p.status='succeeded';p.amount={currency:'RUB',value:'1.00'};
            assert.equal((await incoming()).status,503);assert.equal((await store.get(order.id)).status,'pending');
            p.amount={currency:'RUB',value:'100.00'};p.recipient.account_id='other';
            assert.equal((await incoming()).status,503);
            p.recipient.account_id='shop';p.test=false;assert.equal((await incoming()).status,503);
            p.test=true;assert.equal((await incoming()).status,200);
            await yooApp.deliverPending();
            const sends=calls.filter(c=>c.method==='sendDocument' && Number(c.body.chat_id)===888);
            assert.equal(sends.length,1);
            await incoming();await yooApp.deliverPending();
            assert.equal(calls.filter(c=>c.method==='sendDocument' && Number(c.body.chat_id)===888).length,1);
            assert.equal((await request('/api/admin/orders/'+order.id+'/refund',{origin,user:999,body:{}})).status,200);
            assert.equal((await store.get(order.id)).status,'refunded');
            assert.equal(yooCalls.at(-1).body.amount.value,'100.00');
            const refundEvent=await request('/yookassa-webhook',{origin,body:{type:'notification',event:'refund.succeeded',object:{id:'refund'}}});
            assert.equal(refundEvent.status,200);
            await webhook(message(999,{document:{file_id:'receipt_file_123',file_name:'чек.pdf'},caption:'/receipt '+order.id}));
            assert.equal(calls.filter(c=>c.method==='sendDocument' && c.body.document==='receipt_file_123').length,1);
            assert.equal((await store.uploads('чек.pdf')).length,0);
        } finally {await new Promise(resolve=>srv.close(resolve));}
    });

    await t.test('structured codes are unique and editable without breaking existing purchases',async()=>{
        await pool.query('DELETE FROM rate_limits');
        const put=(id,item)=>request('/api/admin/catalog/'+id,{user:999,method:'PUT',body:item});
        const code='0102110304_05', changed='0102110304_06';
        const item={...catalog.paid,materialCode:code,institution:'Университет',specialty:'Нефтегазовое дело',createOnly:true};
        assert.equal((await put('bad',{...item,materialCode:'01 02'})).status,400);
        assert.equal((await put(code,{...item,materialCode:null})).status,400);
        assert.equal((await put(code,item)).status,200);
        assert.equal((await put(code,{...item,name:'Нельзя перезаписать'})).status,409);
        assert.equal((await store.catalog(catalog))[code].name,catalog.paid.name);
        const purchase=await store.create({user:456,file:code,document:'solution_file_id_123',title:'Original title',amount:25,requestKey:crypto.randomUUID()});
        await store.paid(purchase.id,'code-purchase'); await store.delivered(purchase.id);
        assert.equal((await put(code,{...item,materialCode:changed,createOnly:false})).status,200);
        assert.equal((await put(changed,{...item,materialCode:changed})).status,409);
        assert.equal((await put('free',{...catalog.free,materialCode:changed})).status,409);
        assert.equal((await put(code,{...item,materialCode:null,createOnly:false})).status,400);
        assert.equal((await store.owned(456,code)).id,purchase.id);
        const delivered=await request('/api/action',{user:456,body:{fileId:code,requestKey:crypto.randomUUID()}});
        assert.equal(delivered.data.orderId,purchase.id);assert.equal(delivered.data.queued,true);
        const catalogResponse=await request('/api/catalog');
        assert.ok(catalogResponse.data[code]);
        assert.equal(catalogResponse.data[changed],undefined);
        assert.equal((await store.get(purchase.id)).title,'Original title');
        // Legacy material can receive an accounting code while retaining its internal ID.
        assert.equal((await put('free',{...catalog.free,materialCode:'0102110304_07'})).status,200);
        assert.equal((await store.catalog(catalog)).free.materialCode,'0102110304_07');
        await store.init(); // The additive schema change is safe on subsequent deployments.
        assert.equal((await store.owned(456,code)).id,purchase.id);
    });
    await t.test('group rename updates all variants atomically and respects scope and occupied names',async()=>{
        await pool.query('DELETE FROM rate_limits');
        const code='0201110101_01';
        const first={...catalog.free,materialCode:code,institution:'Вуз 2',specialty:'Направление',subject:'Физика',name:'ДЗ',variant:'1'};
        const second={...first,materialCode:'0201110101_02',variant:'2'};
        const third={...first,materialCode:'0201110102_01',name:'Лабораторная'};
        const elsewhere={...first,materialCode:'0201210101_01',course:'2 курс'};
        for (const item of [first,second,third,elsewhere]) assert.equal((await request('/api/admin/catalog/'+item.materialCode,{user:999,method:'PUT',body:{...item,createOnly:true}})).status,200);
        const rename=(field,newName,expectedName,user=999)=>request('/api/admin/catalog/rename',{user,body:{sourceId:code,field,newName,expectedName}});
        assert.equal((await rename('subject','Механика','Физика',123)).status,403);
        assert.equal((await rename('name','Лабораторная','ДЗ')).status,409);
        assert.equal((await rename('name','Самостоятельная','ДЗ')).data.count,2);
        assert.equal((await rename('name','Устаревшее изменение','ДЗ')).status,409);
        assert.equal((await rename('subject',' Механика ','Физика')).data.count,3);
        const items=await store.catalog(catalog);
        assert.equal(items[code].subject,'Механика');
        assert.equal(items[second.materialCode].name,'Самостоятельная');
        assert.equal(items[third.materialCode].name,'Лабораторная');
        assert.equal(items[elsewhere.materialCode].subject,'Физика');
        assert.equal(items[code].materialCode,code);
        assert.equal(items[code].telegramFileId,first.telegramFileId);
        assert.equal((await rename('course','3 курс','1 курс')).status,400);
    });

});
