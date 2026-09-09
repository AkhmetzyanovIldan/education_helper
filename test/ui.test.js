'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('student UI keeps navigation and safely renders quotes and HTML-like catalog text',async()=>{
    const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
    const script=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
    const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only'});
    const w=dom.window;
    const item={course:"1 ' курс",semester:'1 семестр',subject:'<img src=x onerror=alert(1)>',name:"Работа ' \" <script>bad()</script>",variant:'<b>1</b>',desc:'<svg onload=bad()>',type:'free',available:true};
    w.fetch=async()=>({ok:true,json:async()=>({a:item})});
    w.eval(script);await tick();
    for(const action of ['selectCourse','selectSemester','selectSubject','openFileModal','openTaskInfo']) {
        const element=w.document.querySelector('[data-action="'+action+'"]');
        assert.ok(element,action);
        element.click();
    }
    assert.match(w.document.getElementById('modal-content').textContent,/<svg onload=bad\(\)>/);
    assert.equal(w.document.querySelector('#app-view img'),null);
    assert.equal(w.document.querySelector('#modal-content svg'),null);
    assert.equal(w.document.querySelector('#modal-content script'),null);
    assert.equal(w.document.querySelector('[onclick]'),null);
    dom.window.close();
});
test('admin edits material fields and sends explicit Stars prices through authenticated API',async()=>{
    const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../public/admin.html'),'utf8'),{url:'https://example.test/admin',runScripts:'outside-only'});
    const w=dom.window;
    w.Telegram={WebApp:{initData:'signed-test',ready(){},expand(){}}};
    const item={course:'1 курс',semester:'1 семестр',subject:'Математика',name:'Тест',variant:'1',desc:'Задание',type:'paid',priceStars:null};
    const calls=[];
    w.fetch=async(url,options)=>{
        calls.push({url,options});
        return {ok:true,status:200,json:async()=>url.endsWith('/catalog')?{items:{a:item},uploads:[{file_id:'file_id_123456',name:'пример.docx'}]}:url.endsWith('/orders')?[]:url.includes('/uploads?')?{uploads:[],storageGroup:null}:{saved:true}};
    };
    w.eval(fs.readFileSync(path.join(__dirname,'../public/catalog-tools.js'),'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8'));
    await tick();await tick();
    assert.equal(w.document.getElementById('panel').hidden,false);
    const form=w.document.getElementById('editor');
    assert.equal(form.elements.name.value,'Тест');
    assert.equal(form.elements.priceStars.value,'');
    form.elements.priceStars.value='42';
    form.elements.telegramFileId.value='file_id_123456';
    form.dispatchEvent(new w.Event('submit',{cancelable:true}));
    await tick();await tick();
    const put=calls.find(c=>c.options.method==='PUT');
    assert.ok(put);
    assert.equal(JSON.parse(put.options.body).priceStars,42);
    assert.equal(put.options.headers['X-Telegram-Init-Data'],'signed-test');
    dom.window.close();
});
test('download shows immediate feedback, blocks repeat clicks and keeps confirmation visible',async()=>{
    const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{url:'https://example.test',runScripts:'outside-only'});
    const w=dom.window;
    w.Telegram={WebApp:{initData:'signed',ready(){},expand(){},isVersionAtLeast:()=>false}};
    const item={course:'1',semester:'1',subject:'Math',name:'Work',variant:'1',desc:'Task',type:'free',available:true};
    let complete, count=0;
    w.fetch=async url=>{
        if(url.endsWith('/catalog')) return {ok:true,json:async()=>({a:item})};
        count++;return new Promise(resolve=>{complete=()=>resolve({ok:true,json:async()=>({queued:true,orderId:'order'})});});
    };
    w.eval(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'));await tick();
    for(const name of ['selectCourse','selectSemester','selectSubject','openFileModal','showVariants']) w.document.querySelector('[data-action="'+name+'"]').click();
    const button=w.document.querySelector('[data-action="handleAction"]');
    button.click();
    assert.equal(button.disabled,true);
    assert.equal(button.getAttribute('aria-busy'),'true');
    assert.equal(button.classList.contains('delivery-working'),true);
    assert.equal(w.document.getElementById('delivery-feedback').hidden,false);
    button.click();assert.equal(count,1);
    complete();await tick();
    assert.match(w.document.getElementById('delivery-title').textContent,/Файл придёт/);
    assert.equal(button.textContent,'✓ Файл запрошен');
    assert.equal(w.document.querySelector('#delivery-feedback button').disabled,false);
    w.document.querySelector('#delivery-feedback button').click();
    assert.equal(w.document.getElementById('delivery-feedback').hidden,true);
    dom.window.close();
});
test('failed download restores button and reuses request key on retry',async()=>{
    const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{url:'https://example.test',runScripts:'outside-only'});
    const w=dom.window;
    w.Telegram={WebApp:{initData:'signed',ready(){},expand(){},isVersionAtLeast:()=>false}};
    const item={course:'1',semester:'1',subject:'Math',name:'Work',variant:'1',desc:'Task',type:'free',available:true};
    const keys=[];
    w.fetch=async(url,options)=>{
        if(url.endsWith('/catalog'))return {ok:true,json:async()=>({a:item})};
        keys.push(JSON.parse(options.body).requestKey);throw new Error('Network error');
    };
    w.eval(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'));await tick();
    for(const name of ['selectCourse','selectSemester','selectSubject','openFileModal','showVariants'])w.document.querySelector('[data-action="'+name+'"]').click();
    const button=w.document.querySelector('[data-action="handleAction"]');
    button.click();await tick();
    assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-busy'),null);
    assert.match(w.document.getElementById('delivery-title').textContent,/Не удалось/);
    w.document.querySelector('#delivery-feedback button').click();
    button.click();await tick();
    assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
    dom.window.close();
});

async function adminFixture(items) {
    const dom = new JSDOM(fs.readFileSync(path.join(__dirname,'../public/admin.html'),'utf8'),{url:'https://example.test/admin',runScripts:'outside-only'});
    const w=dom.window,calls=[];
    w.Telegram={WebApp:{initData:'signed-test',ready(){},expand(){}}};
    w.confirm=()=>true;
    const documents=[{file_id:'solution_file_id',name:'решение.docx',folder:'Математика'},{file_id:'task_file_id',name:'задание.pdf',folder:'Математика'}];
    w.fetch=async(url,options)=>{
        calls.push({url,options});
        const body=options.body ? JSON.parse(options.body) : null;
        let result;
        if(options.method==='PUT' && url.includes('/catalog/')) {items[decodeURIComponent(url.split('/').at(-1))]=body;result={saved:true};}
        else if(url.endsWith('/catalog/rename')) {
            let count=0;
            for(const item of Object.values(items)) if(w.CatalogTools.sameGroup(item,items[body.sourceId],body.field)) count++;
            const targets=Object.values(items).filter(item=>w.CatalogTools.sameGroup(item,items[body.sourceId],body.field));
            for(const item of targets)item[body.field]=body.newName;
            result={saved:true,count};
        }
        else if(url.endsWith('/catalog')) result={items,uploads:documents};
        else if(url.includes('/uploads?'))result={uploads:documents,storageGroup:'-100'};
        else result=[];
        return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(result))};
    };
    w.eval(fs.readFileSync(path.join(__dirname,'../public/catalog-tools.js'),'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8'));
    await tick();await tick();
    return {dom,w,calls};
}
test('admin search shows the full hierarchy without discarding the current editor',async()=>{
    const item={course:'2 курс',semester:'1 семестр',subject:'Математика',name:'ДЗ #1',variant:'3 вариант',desc:'',type:'free'};
    const {dom,w}=await adminFixture({old:item,other:{...item,subject:'Физика'}});
    try {
        const d=w.document,form=d.getElementById('editor');
        assert.match(d.getElementById('materials').textContent,/2 курс → 1 семестр → Математика → ДЗ #1 → 3 вариант → ID old/);
        assert.match(d.getElementById('material-details').textContent,/Математика/);
        form.elements.desc.value='Несохранённое описание';
        form.elements.desc.dispatchEvent(new w.Event('input',{bubbles:true}));
        const search=d.getElementById('materials-search');
        search.value='Физика 2 курс';search.dispatchEvent(new w.Event('input'));
        assert.equal(d.querySelectorAll('#materials option[value="other"]').length,1);
        assert.equal(d.querySelectorAll('#materials option[value="old"]').length,0);
        assert.equal(form.elements.desc.value,'Несохранённое описание');
        search.value='<script>';search.dispatchEvent(new w.Event('input'));
        assert.match(d.getElementById('materials-count').textContent,/Найдено: 0/);
        assert.equal(form.elements.id.value,'old');
        assert.match(d.getElementById('file-library').textContent,/Не назначен материалам/);
    } finally {dom.window.close();}
});
test('admin new variant builds structured ID, clears documents and selects saved material',async()=>{
    const id='0102110304_05';
    const item={materialCode:id,institution:'Вуз',specialty:'Нефтегазовое дело',course:'1 курс',semester:'1 семестр',subject:'Математика',name:'ДЗ',variant:'5 вариант',desc:'Условие',type:'paid',priceStars:42,telegramFileId:'solution_file_id',taskTelegramFileId:'task_file_id'};
    const {dom,w,calls}=await adminFixture({[id]:item});
    try {
        const d=w.document,form=d.getElementById('editor');
        assert.match(d.getElementById('file-library').textContent,/Вуз → Нефтегазовое дело → 1 курс → 1 семестр → Математика/);
        d.getElementById('new-variant').click();
        assert.equal(form.elements.name.value,'ДЗ');
        assert.equal(form.elements.priceStars.value,'42');
        assert.equal(form.elements.code_institution.value,'01');
        assert.equal(form.elements.code_variant.value,'');
        assert.equal(form.elements.telegramFileId.value,'');
        assert.equal(form.elements.taskTelegramFileId.value,'');
        form.dispatchEvent(new w.Event('submit',{cancelable:true}));
        await tick();
        assert.equal(calls.some(c=>c.options.method==='PUT'),false);
        form.elements.code_variant.value='6';
        form.elements.code_variant.dispatchEvent(new w.Event('input',{bubbles:true}));
        form.elements.variant.value='6 вариант';
        assert.equal(form.elements.materialCode.value,'0102110304_06');
        form.dispatchEvent(new w.Event('submit',{cancelable:true}));
        await tick();await tick();
        const call=calls.find(c=>c.options.method==='PUT'),body=JSON.parse(call.options.body);
        assert.equal(call.url,'/api/admin/catalog/0102110304_06');
        assert.equal(body.createOnly,true);
        assert.equal(body.materialCode,'0102110304_06');
        assert.equal(body.telegramFileId,'');
        assert.equal(d.getElementById('materials').value,'0102110304_06');
        assert.equal(form.elements.variant.value,'6 вариант');
    } finally {dom.window.close();}
});
test('admin assigns new code to legacy material using stable internal ID and renames all variants',async()=>{
    const item={course:'1 курс',semester:'1 семестр',subject:'Математика',name:'Работа',variant:'1',desc:'',type:'free'};
    const {dom,w,calls}=await adminFixture({legacy:item,second:{...item,variant:'2'}});
    try {
        const d=w.document,form=d.getElementById('editor');
        for (const [key,value] of Object.entries({institution:'1',specialty:'2',course:'1',semester:'1',subject:'3',work:'4',variant:'1'})) form.elements['code_'+key].value=value;
        form.elements.code_variant.dispatchEvent(new w.Event('input',{bubbles:true}));
        form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
        const put=calls.find(c=>c.options.method==='PUT');
        assert.equal(put.url,'/api/admin/catalog/legacy');
        assert.equal(JSON.parse(put.options.body).materialCode,'0102110304_01');
        assert.equal(JSON.parse(put.options.body).createOnly,false);
        const field=d.getElementById('rename-field');field.value='name';field.dispatchEvent(new w.Event('change'));
        assert.match(d.getElementById('rename-button').textContent,/2/);
        d.getElementById('rename-value').value='Самостоятельная';
        d.getElementById('rename-button').click();await tick();await tick();
        assert.equal(form.elements.name.value,'Самостоятельная');
        assert.match(d.getElementById('materials').textContent,/Самостоятельная → 2/);
        assert.equal(form.elements.id.value,'legacy');
    } finally {dom.window.close();}
});
