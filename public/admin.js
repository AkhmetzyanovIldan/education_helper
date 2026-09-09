'use strict';
const tg = window.Telegram?.WebApp;
const status = document.getElementById('status');
const form = document.getElementById('editor');
const select = document.getElementById('materials');
let items = {}, uploads = [], saving = false;
async function request(path, method = 'GET', body) {
    if (!tg?.initData) throw new Error('Откройте админку кнопкой бота из аккаунта @AxmIldan.');
    const response = await fetch('/api/admin' + path, { method,
        headers: { 'Content-Type':'application/json', 'X-Telegram-Init-Data':tg.initData },
        ...(body ? { body:JSON.stringify(body) } : {}), signal:AbortSignal.timeout(25000) });
    if (response.status === 403) throw new Error('Доступ разрешён только владельцу.');
    const result = await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос. Откройте админку заново.');
    return result;
}
function option(value, text) {
    const node = document.createElement('option');
    node.value = value; node.textContent = text; return node;
}
function edit(id) {
    form.reset();
    const item = items[id] || {type:'free'};
    form.elements.id.value = id || '';
    form.elements.id.readOnly = Boolean(id);
    for (const key of ['course','semester','subject','name','variant','desc','type','priceStars','priceRub']) form.elements[key].value = item[key] ?? '';
    form.elements.disabled.checked = Boolean(item.disabled);
    for (const key of ['telegramFileId','taskTelegramFileId']) {
        const field = form.elements[key];
        field.replaceChildren(option('','Не выбран'));
        for (const doc of uploads) field.append(option(doc.file_id,doc.name + (doc.size ? ' (' + Math.ceil(doc.size/1024) + ' КБ)' : '')));
        if (item[key] && !uploads.some(doc=>doc.file_id===item[key])) field.append(option(item[key],'Текущий файл'));
        field.value = item[key] || '';
    }
}
async function refresh() {
    status.textContent = 'Загрузка…';
    try {
        const catalog = await request('/catalog');
        items = catalog.items; uploads = catalog.uploads;
        const previous = select.value;
        select.replaceChildren(...Object.entries(items).map(([id,item]) => option(id,item.name + ' / ' + item.variant)));
        select.value = Object.hasOwn(items,previous) ? previous : Object.keys(items)[0] || '';
        edit(select.value);
        const orders = await request('/orders'), container = document.getElementById('orders');
        container.replaceChildren();
        const labels = {pending:'Ожидает оплаты',checkout:'Подтверждение оплаты',paid:'В очереди выдачи',sent:'Отправлен',refunded:'Возвращён',canceled:'Отменён'};
        for (const order of orders) {
            const price = order.currency === 'RUB' ? (order.amount/100).toFixed(2)+' ₽' : order.amount+' ★';
            const row = document.createElement('div'); row.className = 'order';
            for (const text of [order.title, 'Заказ: ' + order.id, 'Пользователь: ' + order.user_id,
                (labels[order.status] || order.status) + ' · ' + price + ' · попыток: ' + order.attempts]) {
                const p = document.createElement('p'); p.textContent = text; row.append(p);
            }
            if (['paid','sent'].includes(order.status)) {
                for (const action of ['resend',...(order.amount>0 ? ['refund'] : [])]) {
                    const button = document.createElement('button');
                    button.textContent = action === 'resend' ? 'Отправить повторно' : 'Вернуть ' + price;
                    button.addEventListener('click',async()=>{
                        if (action === 'refund' && !window.confirm('Вернуть ' + price + ' по заказу ' + order.id + '?')) return;
                        button.disabled = true;
                        try { await request('/orders/'+order.id+'/'+action,'POST',{}); await refresh(); }
                        catch(e) { status.textContent=e.message; button.disabled=false; }
                    });
                    row.append(button);
                }
            }
            container.append(row);
        }
        if (!orders.length) container.textContent = 'Заказов пока нет.';
        document.getElementById('panel').hidden = false;
        status.textContent = 'Доступ владельца подтверждён.';
        await loadLibrary();
    } catch(e) { status.textContent=e.message; }
}
form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(saving) return;
    saving=true;
    const button=form.querySelector('button'); button.disabled=true;
    try {
        const body=Object.fromEntries(new FormData(form));
        body.priceStars=body.priceStars ? Number(body.priceStars) : null;
        body.priceRub=body.priceRub ? Number(body.priceRub) : null;
        body.disabled=form.elements.disabled.checked;
        await request('/catalog/'+encodeURIComponent(body.id),'PUT',body);
        await refresh(); status.textContent='Материал сохранён.';
    } catch(e) {status.textContent=e.message;}
    finally {saving=false;button.disabled=false;}
});
select.addEventListener('change',()=>edit(select.value));
document.getElementById('refresh').addEventListener('click',refresh);
document.getElementById('new').addEventListener('click',()=>{select.value='';edit('');});

// File inventory is independent of the editor: searches never reset unsaved fields.
let uploadOffset=0, uploadQuery='';
function selectUpload(key,doc) {
    const field=form.elements[key];
    if(![...field.options].some(o=>o.value===doc.file_id)) field.append(option(doc.file_id,doc.name));
    field.value=doc.file_id;
    status.textContent='Файл выбран. Нажмите «Сохранить материал», чтобы применить.';
}
async function loadLibrary() {
    const container=document.getElementById('file-library');
    if(!container) return;
    try {
        const data=await request('/uploads?q='+encodeURIComponent(uploadQuery)+'&offset='+uploadOffset);
        container.replaceChildren();
        document.getElementById('storage-group').textContent=data.storageGroup ? 'Группа загрузки подключена: '+data.storageGroup : 'Группа ещё не подключена. Добавьте бота администратором в закрытую группу и отправьте /bind_storage от своего аккаунта.';
        for(const doc of data.uploads) {
            const row=document.createElement('div');row.className='order';
            const title=document.createElement('strong');title.textContent=doc.name;row.append(title);
            const used=Object.entries(items).filter(([,item])=>item.telegramFileId===doc.file_id || item.taskTelegramFileId===doc.file_id).map(([,item])=>item.name+' / '+item.variant);
            const info=document.createElement('p');info.textContent=(doc.folder || 'Без папки')+' · '+(used.length ? 'Используется: '+used.join(', ') : 'Не назначен материалам');row.append(info);
            const folder=document.createElement('input');folder.value=doc.folder || '';folder.maxLength=200;folder.placeholder='Папка: 1 курс / Математика';folder.setAttribute('aria-label','Папка для '+doc.name);row.append(folder);
            for(const [label,handler] of [
                ['Сохранить папку',async()=>{await request('/uploads/'+encodeURIComponent(doc.file_id),'PUT',{folder:folder.value});await loadLibrary();}],
                ['Выбрать решением',async()=>selectUpload('telegramFileId',doc)],
                ['Выбрать заданием',async()=>selectUpload('taskTelegramFileId',doc)]
            ]) {
                const button=document.createElement('button');button.type='button';button.textContent=label;
                button.addEventListener('click',async()=>{button.disabled=true;try{await handler();}catch(e){status.textContent=e.message;}finally{button.disabled=false;}});
                row.append(button);
            }
            container.append(row);
        }
        if(!data.uploads.length) container.textContent='Файлы не найдены.';
        document.getElementById('files-prev').disabled=uploadOffset===0;
        document.getElementById('files-next').disabled=data.uploads.length<100;
        document.getElementById('files-page').textContent='Страница '+(uploadOffset/100+1);
    } catch(e) {status.textContent=e.message;}
}
document.getElementById('files-search-button').addEventListener('click',()=>{uploadQuery=document.getElementById('files-search').value.trim();uploadOffset=0;loadLibrary();});
document.getElementById('files-search').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();document.getElementById('files-search-button').click();}});
document.getElementById('files-prev').addEventListener('click',()=>{uploadOffset=Math.max(0,uploadOffset-100);loadLibrary();});
document.getElementById('files-next').addEventListener('click',()=>{uploadOffset+=100;loadLibrary();});

tg?.ready(); tg?.expand(); refresh();
