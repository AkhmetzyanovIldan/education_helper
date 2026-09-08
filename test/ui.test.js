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
        return {ok:true,status:200,json:async()=>url.endsWith('/catalog')?{items:{a:item},uploads:[{file_id:'file_id_123456',name:'пример.docx'}]}:url.endsWith('/orders')?[]:{saved:true}};
    };
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
