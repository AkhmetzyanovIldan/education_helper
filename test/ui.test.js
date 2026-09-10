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


async function adminFixture(){
    const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../public/admin.html'),'utf8'),{url:'https://example.test/admin',runScripts:'outside-only'});
    const w=dom.window,calls=[];w.confirm=()=>true;
    w.Telegram={WebApp:{initData:'signed-owner',ready(){},expand(){}}};
    const helpers=require('../public/hierarchy-tools');
    const nodes=['Вуз','Специальность','1 курс','1 семестр','Математика','ДЗ','Вариант 1'].map((name,level)=>({id:'n'+level,parent_id:level ? 'n'+(level-1) : null,level,number:1,name,version:1,material_id:level===6 ? 'legacy' : null}));
    const items={legacy:{institution:'Вуз',specialty:'Специальность',course:'1 курс',semester:'1 семестр',subject:'Математика',name:'ДЗ',variant:'Вариант 1',materialCode:'010101010101_01',type:'paid',priceStars:30,priceRub:150,desc:'Условие',telegramFileId:'solution_file_id',taskTelegramFileId:'task_file_id',disabled:false}};
    const docs=[{file_id:'solution_file_id',name:'Решение.docx',folder:'Математика'},{file_id:'task_file_id',name:'Задание.pdf'},{file_id:'extra_file_id',name:'Другой.docx'}];
    let revision=1;
    const nodePath=id=>{const result=[];for(let current=nodes.find(n=>n.id===id);current;current=nodes.find(n=>n.id===current.parent_id))result.unshift(current);return result;};
    const descendants=id=>nodes.filter(node=>nodePath(node.id).some(parent=>parent.id===id));
    const decorate=node=>({...node,code:helpers.code(nodePath(node.id)),descendantCount:descendants(node.id).length-1,variantCount:descendants(node.id).filter(n=>n.level===6).length});
    w.fetch=async(url,options={})=>{
        calls.push({url,options});
        const body=options.body ? JSON.parse(options.body) : null,parsed=new URL(url,'https://example.test');
        let result;
        if(parsed.pathname==='/api/admin/structure' && options.method==='GET'){
            const id=parsed.searchParams.get('parent'),node=nodes.find(n=>n.id===id);
            result={node:node ? decorate(node) : null,path:id ? nodePath(id) : [],children:nodes.filter(n=>n.parent_id===id).map(decorate),revision,item:node?.material_id ? items[node.material_id] : null,files:docs,paymentProvider:'yookassa'};
        }else if(parsed.pathname==='/api/admin/structure' && options.method==='POST'){
            const parent=nodes.find(n=>n.id===body.parentId);
            const node={id:'created'+nodes.length,parent_id:body.parentId,level:parent ? parent.level+1 : 0,number:1+Math.max(0,...nodes.filter(n=>n.parent_id===body.parentId).map(n=>n.number)),name:body.name,version:1};
            nodes.push(node);revision++;result={saved:true,node};
        }else if(options.method==='PATCH'){
            const node=nodes.find(n=>n.id===parsed.pathname.split('/').at(-1));
            node.name=body.name;node.version++;revision++;result={saved:true,node};
        }else if(options.method==='DELETE'){
            const id=parsed.pathname.split('/').at(-1),node=nodes.find(n=>n.id===id),targets=new Set(descendants(id).map(n=>n.id));
            for(let i=nodes.length-1;i>=0;i--)if(targets.has(nodes[i].id))nodes.splice(i,1);
            revision++;result={saved:true,parentId:node.parent_id,removed:targets.size};
        }else if(parsed.pathname.endsWith('/variant')){
            const node=nodes.find(n=>n.id===parsed.pathname.split('/').at(-2));node.version++;revision++;
            items[node.material_id]={...items[node.material_id],...body};
            result={saved:true,node:decorate(node),item:items[node.material_id],revision};
        }else if(parsed.pathname==='/api/admin/uploads')result={uploads:docs,storageGroup:'-100'};
        else result=[];
        return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(result))};
    };
    w.eval(fs.readFileSync(path.join(__dirname,'../public/hierarchy-tools.js'),'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8'));
    await tick();await tick();
    const openVariant=async()=>{for(let i=0;i<7;i++){w.document.querySelector('[data-action="open"][data-id="n'+i+'"]').click();await tick();await tick();}};
    return {dom,w,calls,nodes,items,openVariant};
}
test('admin navigates seven levels and only loads file library at variant level',async()=>{
    const {dom,w,calls,openVariant}=await adminFixture();
    try{
        const d=w.document;
        assert.equal(d.getElementById('panel').hidden,false);
        assert.equal(d.getElementById('variant-panel').hidden,true);
        assert.equal(calls.some(call=>call.url.includes('/uploads')),false);
        assert.equal(d.getElementById('create-node').textContent,'Создать: учебное заведение');
        await openVariant();
        assert.equal(d.getElementById('variant-panel').hidden,false);
        assert.equal(d.getElementById('branch-panel').hidden,true);
        assert.equal(calls.filter(call=>call.url.includes('/uploads')).length,1);
        assert.equal(d.getElementById('material-code').value,'010101010101_01');
        assert.equal(d.getElementById('material-code').readOnly,true);
        assert.equal(d.querySelectorAll('#breadcrumbs button').length,8);
        assert.equal(d.getElementById('editor').elements.priceRub.value,'150');
        d.querySelector('[data-action="open"][data-id="n4"]').click();await tick();await tick();
        assert.equal(d.getElementById('variant-panel').hidden,true);
        assert.equal(d.getElementById('create-node').textContent,'Создать: работа');
    }finally{dom.window.close();}
});
test('admin creates a named section without manual ID fields, renames it and confirms deletion',async()=>{
    const {dom,w,calls}=await adminFixture();
    try{
        const d=w.document;
        d.getElementById('create-node').click();
        d.getElementById('node-name').value='Другой вуз';
        d.getElementById('save-name').click();await tick();await tick();
        const create=calls.find(call=>call.options.method==='POST'),body=JSON.parse(create.options.body);
        assert.equal(body.parentId,null);assert.equal(body.name,'Другой вуз');
        assert.ok(body.requestKey);assert.equal(body.materialCode,undefined);
        assert.equal(d.getElementById('view-title').textContent,'Другой вуз');
        assert.match(d.getElementById('view-code').textContent,/02/);
        d.getElementById('rename-current').click();d.getElementById('node-name').value='Переименованный вуз';d.getElementById('save-name').click();await tick();await tick();
        assert.equal(d.getElementById('view-title').textContent,'Переименованный вуз');
        w.confirm=()=>false;d.getElementById('delete-current').click();await tick();
        assert.equal(calls.some(call=>call.options.method==='DELETE'),false);
        let confirmation;w.confirm=text=>{confirmation=text;return true;};
        d.getElementById('delete-current').click();await tick();await tick();
        assert.match(confirmation,/Переименованный вуз/);assert.match(confirmation,/Вариантов: 0/);
        assert.ok(calls.find(call=>call.options.method==='DELETE'));
        assert.equal(d.getElementById('view-title').textContent,'Учебные заведения');
    }finally{dom.window.close();}
});
test('variant save immediately shows progress and confirms saved price without unrelated refresh',async()=>{
    const {dom,w,openVariant,items,nodes}=await adminFixture();
    try{
        await openVariant();const d=w.document,form=d.getElementById('editor'),button=d.getElementById('save-material');
        form.elements.priceRub.value='250';form.elements.priceRub.dispatchEvent(new w.Event('input',{bubbles:true}));
        let finish,count=0,sent;
        w.fetch=async(url,options)=>{
            count++;sent=JSON.parse(options.body);
            return new Promise(resolve=>{finish=()=>resolve({ok:true,status:200,json:async()=>({saved:true,node:{...nodes[6],version:2},item:{...items.legacy,priceRub:250},revision:2})});});
        };
        button.click();assert.equal(button.disabled,true);assert.equal(button.textContent,'Сохраняем…');
        assert.equal(d.getElementById('save-result').dataset.kind,'pending');
        button.click();assert.equal(count,1);assert.equal(sent.priceRub,250);assert.equal(sent.materialCode,undefined);
        finish();await tick();await tick();
        assert.equal(button.disabled,false);assert.equal(button.textContent,'✓ Сохранено');
        assert.equal(d.getElementById('save-result').dataset.kind,'success');
        assert.match(d.getElementById('file-library').textContent,/Используется: Вуз → Специальность → 1 курс/);
        assert.equal(count,1);
    }finally{dom.window.close();}
});
test('save errors stay visible and entered price remains in form; invalid price does not send',async()=>{
    const {dom,w,openVariant}=await adminFixture();
    try{
        await openVariant();const d=w.document,form=d.getElementById('editor');
        let count=0;w.fetch=async()=>{count++;return {ok:false,status:409,json:async()=>({error:'Вариант уже изменился. Обновите его.'})};};
        form.elements.priceRub.value='0';d.getElementById('save-material').click();await tick();
        assert.equal(count,0);assert.equal(d.getElementById('save-result').dataset.kind,'error');
        form.elements.priceRub.value='275';d.getElementById('save-material').click();await tick();await tick();
        assert.equal(count,1);assert.equal(form.elements.priceRub.value,'275');
        assert.match(d.getElementById('save-result').textContent,/Вариант уже изменился/);
        assert.equal(d.getElementById('save-material').textContent,'Сохранить вариант');
        assert.equal(d.getElementById('save-material').disabled,false);
    }finally{dom.window.close();}
});
test('library search and file assignment preserve unsaved variant fields',async()=>{
    const {dom,w,openVariant}=await adminFixture();
    try{
        await openVariant();const d=w.document,form=d.getElementById('editor');
        form.elements.desc.value='Не потерять описание';form.elements.desc.dispatchEvent(new w.Event('input',{bubbles:true}));
        d.getElementById('files-search').value='Другой';d.getElementById('files-search-button').click();await tick();await tick();
        assert.equal(form.elements.desc.value,'Не потерять описание');
        const row=[...d.querySelectorAll('#file-library .order')].find(node=>node.textContent.includes('Другой.docx'));
        [...row.querySelectorAll('button')].find(button=>button.textContent==='Выбрать решением').click();
        assert.equal(form.elements.telegramFileId.value,'extra_file_id');
        assert.equal(form.elements.desc.value,'Не потерять описание');
        assert.equal(d.getElementById('save-result').hidden,true);
    }finally{dom.window.close();}
});
test('student catalog separates institutions and specialties without mixing identical subject names',async()=>{
    const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{url:'https://example.test',runScripts:'outside-only'});
    try{
        const w=dom.window;
        const item={course:'1 курс',semester:'1 семестр',subject:'Математика',name:'Работа',variant:'1',desc:'',type:'free',available:true};
        w.fetch=async()=>({ok:true,json:async()=>({
            a:{...item,institution:'Вуз A',specialty:'Нефть'},
            b:{...item,institution:'Вуз A',specialty:'Газ',name:'Работа Газ'},
            c:{...item,institution:'Вуз B',specialty:'Нефть',name:'Работа другого вуза'}
        })});
        w.eval(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'));await tick();
        w.document.querySelector('[data-action="selectInstitution"]').click();
        const specialties=[...w.document.querySelectorAll('[data-action="selectSpecialty"]')];
        assert.equal(specialties.length,2);
        specialties.find(button=>button.textContent.includes('Газ')).click();
        for(const action of ['selectCourse','selectSemester','selectSubject'])w.document.querySelector('[data-action="'+action+'"]').click();
        const content=w.document.getElementById('app-view').textContent;
        assert.match(content,/Работа Газ/);assert.doesNotMatch(content,/другого вуза/);
    }finally{dom.window.close();}
});

test('task preview sends the selected variant rather than the first file in the work',async()=>{
    const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../index.html'),'utf8'),{url:'https://example.test',runScripts:'outside-only'});
    try{
        const w=dom.window,requests=[];
        const item={course:'1 курс',semester:'1 семестр',subject:'Математика',name:'ДЗ',desc:'',type:'free',available:true,hasTaskFile:true};
        w.Telegram={WebApp:{initData:'signed',ready(){},expand(){},isVersionAtLeast:()=>false}};
        w.fetch=async(url,options)=>{
            if(url.endsWith('/catalog'))return {ok:true,json:async()=>({first:{...item,variant:'1 вариант'},second:{...item,variant:'2 вариант'}})};
            requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({queued:true,orderId:'preview'})};
        };
        w.eval(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'));await tick();
        for(const action of ['selectCourse','selectSemester','selectSubject','openFileModal','openTaskInfo'])w.document.querySelector('[data-action="'+action+'"]').click();
        assert.equal(requests.length,0);
        [...w.document.querySelectorAll('[data-action="openVariantTask"]')].find(button=>button.textContent==='2 вариант').click();
        await tick();
        assert.equal(requests[0].fileId,'second');assert.equal(requests[0].preview,true);
    }finally{dom.window.close();}
});
