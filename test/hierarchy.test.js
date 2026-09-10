'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {Store}=require('../src/store');
const {createApp}=require('../src/app');
const env={BOT_TOKEN:'test-token',TELEGRAM_WEBHOOK_SECRET:'test-webhook-secret',APP_URL:'https://example.test',ADMIN_CHAT_ID:'999'};
function auth(user=999){
    const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:user})});
    const check=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
    const key=crypto.createHmac('sha256','WebAppData').update(env.BOT_TOKEN).digest();
    params.set('hash',crypto.createHmac('sha256',key).update(check).digest('hex'));return params.toString();
}
test('hierarchical catalog migration, CRUD, numbering and purchase preservation',async t=>{
    const db=new PGlite();let available=Promise.resolve();
    const query=async(sql,args)=>{
        if(!args && sql.includes('CREATE TABLE')){await db.exec(sql);return {rows:[],rowCount:0};}
        const result=await db.query(sql,args);return {...result,rowCount:result.affectedRows ?? result.rows.length};
    };
    const pool={query,async connect(){
        const previous=available;let release;available=new Promise(resolve=>{release=resolve;});await previous;
        return {query,release};
    }};
    const store=new Store(pool);await store.init();await store.enroll(999);
    const base={
        legacy:{course:'1 курс',semester:'1 семестр',subject:'Математика',name:'ДЗ',variant:'1 вариант',type:'paid',priceStars:30,priceRub:150,desc:'Условие',telegramFileId:'solution_original_123',taskTelegramFileId:'task_original_123'},
        legacy2:{course:'1 курс',semester:'1 семестр',subject:'Математика',name:'ДЗ',variant:'2 вариант',type:'free',telegramFileId:'solution_second_123'}
    };
    const oldOrder=await store.create({user:77,file:'legacy',document:'solution_original_123',title:'Прежняя покупка',amount:30,requestKey:crypto.randomUUID()});
    await store.paid(oldOrder.id,'paid-before-migration');
    const calls=[],telegram=async(method,body)=>{calls.push({method,body});return {message_id:1};};
    const {app,deliverPending}=createApp({store,telegram,env,catalog:base});
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    t.after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
    const request=async(path,method='GET',body,user=999)=>{
        const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json','X-Telegram-Init-Data':auth(user)},...(body ? {body:JSON.stringify(body)} : {})});
        return {status:response.status,data:await response.json().catch(()=>null)};
    };
    const create=async(parentId,name,key=crypto.randomUUID())=>store.hierarchy.create(base,parentId,name,key);
    let leaf,path;
    await t.test('migration builds all seven levels once, preserves files and prices and keeps order keys',async()=>{
        await store.hierarchy.ensure(base);
        const first=await store.hierarchy.rows();
        leaf=first.find(node=>node.material_id==='legacy');path=store.hierarchy.path(first,leaf.id);
        assert.equal(path.length,7);assert.equal(path[0].name,'РГУНиГ');assert.equal(path[1].name,'РФ');
        assert.equal((await store.catalog(base)).legacy.materialCode,'010101010101_01');
        assert.equal((await store.catalog(base)).legacy.priceRub,150);
        assert.equal((await store.catalog(base)).legacy.telegramFileId,'solution_original_123');
        const restarted=new Store(pool);await restarted.init();await restarted.hierarchy.ensure(base);
        assert.equal((await restarted.hierarchy.rows()).length,first.length);
        assert.equal((await restarted.owned(77,'legacy')).id,oldOrder.id);
        await deliverPending();assert.equal(calls.find(call=>call.method==='sendDocument').body.document,'solution_original_123');
    });
    await t.test('empty nodes are independent and numbering restarts under each parent',async()=>{
        const institution=await create(null,'Новый вуз'),specialty=await create(institution.id,'Специальность');
        const course1=await create(specialty.id,'Первый курс'),course2=await create(specialty.id,'Второй курс');
        const sem1=await create(course1.id,'Семестр'),sem2=await create(course2.id,'Семестр');
        const math1=await create(sem1.id,'Математика'),physics1=await create(sem1.id,'Физика'),math2=await create(sem2.id,'Математика');
        assert.equal(course1.number,1);assert.equal(course2.number,2);
        assert.equal(math1.number,1);assert.equal(physics1.number,2);assert.equal(math2.number,1);
        const response=await store.hierarchy.browse(base,sem2.id);
        assert.equal(response.children.length,1);assert.equal(response.children[0].variantCount,0);
        assert.equal(response.children[0].code,'0201020101');
        assert.equal((await store.catalog(base)).legacy.priceStars,30);
        const concurrent=await Promise.all([create(sem2.id,'Химия'),create(sem2.id,'Биология')]);
        assert.deepEqual(concurrent.map(node=>node.number),[2,3]);
    });
    await t.test('create is idempotent; duplicate names and a reused request for another parent are rejected',async()=>{
        const key=crypto.randomUUID(),first=await create(null,'Повторяемый запрос',key);
        assert.equal((await create(null,'Повторяемый запрос',key)).id,first.id);
        await assert.rejects(create(null,'повторяемый запрос'),/уже есть/);
        await assert.rejects(create(path[0].id,'Повторяемый запрос',key),/запрос уже использован/);
    });
    await t.test('all seven levels can be renamed without changing codes, prices or old purchase access',async()=>{
        const previousCode=(await store.catalog(base)).legacy.materialCode;
        for(let level=0;level<7;level++){
            const fresh=(await store.hierarchy.rows()).find(node=>node.id===path[level].id);
            await store.hierarchy.rename(base,fresh.id,'Новое название '+level,fresh.version);
        }
        const item=(await store.catalog(base)).legacy;
        for(const [index,key] of ['institution','specialty','course','semester','subject','name','variant'].entries())assert.equal(item[key],'Новое название '+index);
        assert.equal(item.materialCode,previousCode);assert.equal(item.priceStars,30);
        assert.equal((await store.owned(77,'legacy')).id,oldOrder.id);
        assert.equal((await store.get(oldOrder.id)).title,'Прежняя покупка');
    });
    await t.test('HTTP authorizes owner, validates content, ignores manual hierarchy changes and saves prices without YooKassa',async()=>{
        await pool.query('DELETE FROM rate_limits');
        const route='/api/admin/structure';
        assert.equal((await request(route,'GET',null,123)).status,403);
        const fresh=(await store.hierarchy.browse(base,leaf.id));
        const values={desc:'Новое условие',type:'paid',priceStars:35,priceRub:250,disabled:false,telegramFileId:'solution_updated_123',taskTelegramFileId:null,expectedVersion:fresh.node.version,materialCode:'forged',institution:'Подмена'};
        assert.equal((await request(route+'/'+leaf.id+'/variant','PUT',values,123)).status,403);
        assert.equal((await request(route+'/'+leaf.id+'/variant','PUT',{...values,priceRub:0})).status,400);
        const saved=await request(route+'/'+leaf.id+'/variant','PUT',values);
        assert.equal(saved.status,200);assert.equal(saved.data.item.priceRub,250);assert.equal(saved.data.item.materialCode,'010101010101_01');
        assert.equal(saved.data.item.institution,'Новое название 0');assert.ok(Number.isInteger(saved.data.revision));
        assert.equal((await request(route+'/'+leaf.id+'/variant','PUT',values)).status,409);
        assert.equal((await request('/api/admin/catalog/legacy','PUT',values)).status,410);
        assert.equal((await request(route+'/'+path[4].id+'/variant','PUT',{...values,expectedVersion:1})).status,400);
        assert.equal((await request(route+'/'+leaf.id,'DELETE',{expectedRevision:saved.data.revision},123)).status,403);
        const code=(await store.catalog(base)).legacy.materialCode;
        const renamed=await request(route+'/'+leaf.id,'PATCH',{name:'Вариант исправлен',expectedVersion:saved.data.node.version});
        assert.equal(renamed.status,200);assert.equal((await store.catalog(base)).legacy.materialCode,code);
    });
    await t.test('stale deletion preview is rejected; deleting subtree hides legacy catalog without losing paid files',async()=>{
        const before=await store.hierarchy.browse(base,path[4].id);
        await create(path[3].id,'Другой предмет');
        await assert.rejects(store.hierarchy.remove(base,path[4].id,before.revision),/Каталог изменился/);
        const fresh=await store.hierarchy.browse(base,path[4].id);
        const deleted=await request('/api/admin/structure/'+path[4].id,'DELETE',{expectedRevision:fresh.revision});
        assert.equal(deleted.status,200);assert.ok(deleted.data.removed>=4);
        assert.equal((await store.catalog(base)).legacy,undefined);assert.equal((await store.catalog(base)).legacy2,undefined);
        assert.equal((await request('/api/catalog')).data.legacy,undefined);
        const restarted=new Store(pool);await restarted.hierarchy.ensure(base);
        assert.equal((await restarted.catalog(base)).legacy,undefined);
        assert.equal((await store.owned(77,'legacy')).id,oldOrder.id);
        await store.resend(oldOrder.id);await deliverPending();
        assert.equal(calls.filter(call=>call.method==='sendDocument').at(-1).body.document,'solution_original_123');
        const next=await create(path[3].id,'Математика снова');
        assert.equal(next.number,3);
        const again=await store.hierarchy.remove(base,path[4].id,fresh.revision);
        assert.equal(again.removed,0);
    });
    await t.test('new variant is a disabled draft with a generated code and a persistent internal key',async()=>{
        const workParent=(await store.hierarchy.browse(base,path[3].id)).children.find(node=>node.name==='Другой предмет');
        const work=await create(workParent.id,'Самостоятельная работа');
        const result=await request('/api/admin/structure','POST',{parentId:work.id,name:'Вариант 1',requestKey:crypto.randomUUID()});
        assert.equal(result.status,200);const node=result.data.node;
        const variant=await request('/api/admin/structure?parent='+node.id);
        assert.equal(variant.data.item.disabled,true);assert.equal(variant.data.item.telegramFileId,null);
        assert.match(variant.data.item.materialCode,/^\d{12}_01$/);
        assert.equal(variant.data.item.materialCode,variant.data.node.code);
        assert.notEqual(node.material_id,node.id);
        await assert.rejects(create(node.id,'Вложенный раздел'),/Внутри варианта/);
    });
    await t.test('number 99 is the last available sibling and archived numbers remain reserved',async()=>{
        const parent=await create(null,'Проверка лимита');
        await pool.query('INSERT INTO catalog_nodes(id,parent_id,level,number,name) VALUES($1,$2,1,99,$3)',[crypto.randomUUID(),parent.id,'Последний номер']);
        await assert.rejects(create(parent.id,'Сотая специальность'),/закончились номера/);
    });
});
