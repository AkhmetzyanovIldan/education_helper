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

const catalogTools = window.CatalogTools;
const { parts, buildCode, parseCode, materialCode, formatCode, label: materialLabel, sameGroup } = catalogTools;
let editingId = '', dirty = false, renaming = false;
const editableFields = ['institution','specialty','course','semester','subject','name','variant','desc','type','priceStars','priceRub'];
for (const [key,title,width] of parts) {
    const label = document.createElement('label'); label.textContent = title + ' · ' + width + (width === 1 ? ' цифра' : ' цифры');
    const input = document.createElement('input');
    input.name = 'code_' + key; input.inputMode = 'numeric'; input.maxLength = width;
    input.pattern = '[0-9]{1,' + width + '}'; input.placeholder = '0'.repeat(width);
    label.append(input); document.getElementById('code-parts').append(label);
}
function codeValues() { return Object.fromEntries(parts.map(([key]) => [key,form.elements['code_'+key].value])); }
function syncCode() {
    const code = buildCode(codeValues());
    form.elements.materialCode.value = code;
    if (!editingId) form.elements.id.value = code;
    const legacy = editingId && !materialCode(editingId,items[editingId]);
    document.getElementById('code-hint').textContent = code
        ? 'По частям: ' + formatCode(code) + '. Смена учётного ID сохраняет связь с прежними покупками.'
        : legacy ? 'Старый ID: ' + editingId + '. Можно пока оставить его или заполнить все семь частей нового ID.'
            : 'Заполните все семь частей. Семестр — номер внутри курса (обычно 1 или 2). Названия кнопок задаются ниже.';
}
function showDetails() {
    const draft = Object.fromEntries(editableFields.map(key=>[key,form.elements[key].value]));
    draft.materialCode = form.elements.materialCode.value;
    document.getElementById('material-details').textContent = (editingId ? 'Редактируете' : 'Новый материал') +
        (dirty ? ' · есть несохранённые изменения' : '') + ':\n' + materialLabel(editingId || 'ещё не задан',draft);
}
function renderSelector() {
    const terms = document.getElementById('materials-search').value.toLocaleLowerCase('ru').trim().split(/\s+/).filter(Boolean);
    const matches = Object.entries(items).filter(([id,item]) => {
        const haystack = (materialLabel(id,item)+' '+id+' '+formatCode(materialCode(id,item))).toLocaleLowerCase('ru');
        return terms.every(term=>haystack.includes(term));
    }).sort(([id,a],[otherId,b])=>materialLabel(id,a).localeCompare(materialLabel(otherId,b),'ru',{numeric:true}));
    select.replaceChildren(...matches.map(([id,item])=>option(id,materialLabel(id,item))));
    if (!matches.some(([id])=>id===editingId)) {
        select.prepend(option('',matches.length ? 'Выберите материал из результатов поиска' : 'Ничего не найдено'));
        select.value = '';
    } else select.value = editingId;
    document.getElementById('materials-count').textContent = 'Найдено: ' + matches.length + ' из ' + Object.keys(items).length;
}
function suggestions() {
    const all = Object.values(items);
    for (const key of ['institution','specialty','course','semester','subject','name','variant']) {
        const fields = ['institution','specialty','course','semester','subject','name'];
        const level = fields.indexOf(key);
        const relevant = all.filter(item => fields.slice(0,level < 0 ? fields.length : level).every(parent => !form.elements[parent].value || item[parent] === form.elements[parent].value));
        const values = [...new Set(relevant.map(item=>item[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru',{numeric:true}));
        document.getElementById(key+'-options').replaceChildren(...values.map(value=>option(value,value)));
    }
}
function renamePreview() {
    const source = items[editingId], field = document.getElementById('rename-field').value;
    const affected = source ? Object.values(items).filter(item=>sameGroup(item,source,field)) : [];
    document.getElementById('rename-scope').textContent = source
        ? materialLabel(editingId,source) + '\nБудет изменено материалов: ' + affected.length
        : 'Сначала выберите сохранённый материал.';
    document.getElementById('rename-value').value = source?.[field] || '';
    document.getElementById('rename-button').disabled = !source || renaming;
    document.getElementById('rename-button').textContent = 'Переименовать (' + affected.length + ')';
}
function mayLeave() {
    return !dirty || window.confirm('В форме есть несохранённые изменения. Продолжить без сохранения?');
}
function edit(id, draft) {
    form.reset();
    editingId = id || '';
    const item = draft || items[id] || {type:'free'};
    form.elements.id.value = id || '';
    for (const key of editableFields) form.elements[key].value = item[key] ?? '';
    form.elements.disabled.checked = Boolean(item.disabled);
    const values = parseCode(materialCode(id,item)) || {};
    for (const [key] of parts) form.elements['code_'+key].value = values[key] || '';
    if (draft) form.elements.code_variant.value = '';
    for (const key of ['telegramFileId','taskTelegramFileId']) {
        const field = form.elements[key];
        field.replaceChildren(option('','Не выбран'));
        for (const doc of uploads) field.append(option(doc.file_id,doc.name + (doc.size ? ' (' + Math.ceil(doc.size/1024) + ' КБ)' : '')));
        if (item[key] && !uploads.some(doc=>doc.file_id===item[key])) field.append(option(item[key],'Текущий файл'));
        field.value = item[key] || '';
    }
    dirty = Boolean(draft);
    syncCode(); showDetails(); suggestions(); renamePreview();
    document.getElementById('new-variant').disabled = !id;
}
async function refresh(preferredId = editingId || select.value) {
    status.textContent = 'Загрузка…';
    try {
        const catalog = await request('/catalog');
        items = catalog.items; uploads = catalog.uploads;
        const chosen = Object.hasOwn(items,preferredId) ? preferredId : Object.keys(items)[0] || '';
        edit(chosen); renderSelector();
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
    if(saving || renaming) return;
    saving=true;
    const button=document.getElementById('save-material'); button.disabled=true;
    try {
        syncCode();
        const anyCode = Object.values(codeValues()).some(value=>value.trim());
        if ((!editingId || anyCode || materialCode(editingId,items[editingId])) && !form.elements.materialCode.value) throw new Error('Заполните все семь частей ID цифрами указанной длины.');
        const body=Object.fromEntries(new FormData(form));
        body.materialCode = body.materialCode || null;
        body.createOnly = !editingId;
        body.priceStars=body.priceStars ? Number(body.priceStars) : null;
        body.priceRub=body.priceRub ? Number(body.priceRub) : null;
        body.disabled=form.elements.disabled.checked;
        await request('/catalog/'+encodeURIComponent(body.id),'PUT',body);
        dirty=false;
        await refresh(body.id); status.textContent='Материал сохранён. Кнопки каталога обновятся при повторном открытии приложения.';
    } catch(e) {status.textContent=e.message;}
    finally {saving=false;button.disabled=false;}
});

form.addEventListener('input',()=>{dirty=true;syncCode();showDetails();suggestions();});
form.addEventListener('change',()=>{dirty=true;showDetails();});
document.getElementById('materials-search').addEventListener('input',renderSelector);
select.addEventListener('change',()=>{
    if (!select.value) return;
    if (!mayLeave()) {renderSelector();return;}
    edit(select.value);
});
document.getElementById('refresh').addEventListener('click',()=>{if(mayLeave()) refresh();});
document.getElementById('new').addEventListener('click',()=>{if(mayLeave()){edit('');renderSelector();form.elements.code_institution.focus();}});
document.getElementById('new-variant').addEventListener('click',()=>{
    if (!items[editingId] || !mayLeave()) return;
    const source = items[editingId];
    const draft = {...source,materialCode:materialCode(editingId,source),variant:'',telegramFileId:'',taskTelegramFileId:''};
    edit('',draft);renderSelector();
    status.textContent='Укажите код и название нового варианта, выберите его файлы и сохраните материал.';
    form.elements.code_variant.focus();
});
document.getElementById('rename-field').addEventListener('change',renamePreview);
document.getElementById('rename-button').addEventListener('click',async()=>{
    if (saving || renaming || !items[editingId]) return;
    if (dirty) {status.textContent='Сначала сохраните изменения материала. Затем переименуйте весь раздел.';return;}
    const field=document.getElementById('rename-field').value;
    const newName=document.getElementById('rename-value').value.trim();
    if (!newName) {status.textContent='Введите новое название.';return;}
    renaming=true;document.getElementById('rename-button').disabled=true;
    try {
        const result=await request('/catalog/rename','POST',{sourceId:editingId,field,newName,expectedName:items[editingId][field]});
        await refresh();status.textContent='Название сохранено. Изменено материалов: '+result.count+'.';
    } catch(e) {status.textContent=e.message;}
    finally {renaming=false;document.getElementById('rename-button').disabled=!items[editingId];}
});

// File inventory is independent of the editor: searches never reset unsaved fields.
let uploadOffset=0, uploadQuery='';
function selectUpload(key,doc) {
    const field=form.elements[key];
    if(![...field.options].some(o=>o.value===doc.file_id)) field.append(option(doc.file_id,doc.name));
    field.value=doc.file_id;dirty=true;showDetails();
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
            const used=Object.entries(items).filter(([,item])=>item.telegramFileId===doc.file_id || item.taskTelegramFileId===doc.file_id).map(([id,item])=>materialLabel(id,item));
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
