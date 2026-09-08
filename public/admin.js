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
    for (const key of ['course','semester','subject','name','variant','desc','type','priceStars']) form.elements[key].value = item[key] ?? '';
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
        const labels = {pending:'Ожидает оплаты',checkout:'Подтверждение оплаты',paid:'В очереди выдачи',sent:'Отправлен',refunded:'Возвращён'};
        for (const order of orders) {
            const row = document.createElement('div'); row.className = 'order';
            for (const text of [order.title, 'Заказ: ' + order.id, 'Пользователь: ' + order.user_id,
                (labels[order.status] || order.status) + ' · ' + order.amount + ' ★ · попыток: ' + order.attempts]) {
                const p = document.createElement('p'); p.textContent = text; row.append(p);
            }
            if (['paid','sent'].includes(order.status)) {
                for (const action of ['resend',...(order.amount>0 ? ['refund'] : [])]) {
                    const button = document.createElement('button');
                    button.textContent = action === 'resend' ? 'Отправить повторно' : 'Вернуть ' + order.amount + ' Stars';
                    button.addEventListener('click',async()=>{
                        if (action === 'refund' && !window.confirm('Вернуть ' + order.amount + ' Stars по заказу ' + order.id + '?')) return;
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
        body.disabled=form.elements.disabled.checked;
        await request('/catalog/'+encodeURIComponent(body.id),'PUT',body);
        await refresh(); status.textContent='Материал сохранён.';
    } catch(e) {status.textContent=e.message;}
    finally {saving=false;button.disabled=false;}
});
select.addEventListener('change',()=>edit(select.value));
document.getElementById('refresh').addEventListener('click',refresh);
document.getElementById('new').addEventListener('click',()=>{select.value='';edit('');});
tg?.ready(); tg?.expand(); refresh();
