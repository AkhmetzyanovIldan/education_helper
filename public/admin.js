'use strict';
const tg=window.Telegram?.WebApp;
const {levels,formattedCode,label:materialLabel}=window.HierarchyTools;
const $=id=>document.getElementById(id);
const form=$('editor');
let view=null,busy=false,dirty=false,nameAction=null,libraryOffset=0,libraryQuery='',libraryCount=0,libraryDocs=[],ordersLoaded=false;
async function request(path,method='GET',body){
    if(!tg?.initData)throw new Error('Откройте админку кнопкой бота из аккаунта владельца.');
    const response=await fetch('/api/admin'+path,{
        method,headers:{'Content-Type':'application/json','X-Telegram-Init-Data':tg.initData},
        ...(body!==undefined ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(25000)
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error || (response.status===403 ? 'Доступ разрешён только владельцу.' : 'Не удалось выполнить запрос. Откройте админку заново.'));
    return result;
}
function notice(message,kind='info',target=$('status')){
    target.hidden=false;target.dataset.kind=kind;target.textContent=message;
}
function errorMessage(error){return error.name==='TimeoutError' ? 'Сервер отвечает долго. Подтверждение не получено. Проверьте результат через «Обновить» перед повторной попыткой.' : error.message;}
async function perform(action,target=$('status')){
    if(busy)return;
    busy=true;
    const locked=[...document.querySelectorAll('button,input,select,textarea')].map(field=>({field,disabled:field.disabled}));
    for(const {field} of locked)field.disabled=true;
    try{await action();}
    catch(error){notice(errorMessage(error),'error',target);if(target!==$('status'))notice(errorMessage(error),'error');}
    finally{
        for(const {field,disabled} of locked)if(field.isConnected)field.disabled=disabled;
        busy=false;
        $('files-prev').disabled=libraryOffset===0;$('files-next').disabled=libraryCount<100;
    }
}
function mayLeave(){return !dirty || window.confirm('Есть несохранённые изменения варианта. Продолжить без сохранения?');}
function button(text,action,id){
    const node=document.createElement('button');node.type='button';node.textContent=text;
    node.dataset.action=action;if(id)node.dataset.id=id;return node;
}
function option(value,text){const node=document.createElement('option');node.value=value;node.textContent=text;return node;}
function currentId(){return view?.node?.id || null;}
function displayName(node){return String(node.number).padStart(2,'0')+' · '+node.name;}
function findNode(id){return [view?.node,...(view?.children || [])].find(node=>node?.id===id);}
function renderChildren(){
    const container=$('nodes');container.replaceChildren();
    const query=$('node-search').value.toLocaleLowerCase('ru').trim();
    const children=view.children.filter(node=>(displayName(node)+' '+node.code).toLocaleLowerCase('ru').includes(query));
    for(const node of children){
        const row=document.createElement('div');row.className='node';
        const open=button('','open',node.id);open.className='node-main';
        const title=document.createElement('strong');title.textContent=displayName(node);
        const info=document.createElement('small');info.textContent='ID '+node.code+(node.level===6 ? '' : ' · вариантов: '+node.variantCount);
        open.append(title,info);
        const actions=document.createElement('div');actions.className='node-actions';
        actions.append(button('Изменить','rename',node.id));
        const remove=button('Удалить','delete',node.id);remove.className='danger';actions.append(remove);
        row.append(open,actions);container.append(row);
    }
    if(!children.length)container.textContent=query ? 'Ничего не найдено.' : 'Здесь пока пусто. Создайте первый раздел кнопкой выше.';
}
function addFileOptions(docs){
    for(const key of ['telegramFileId','taskTelegramFileId']){
        const field=form.elements[key];
        for(const doc of docs)if(![...field.options].some(entry=>entry.value===doc.file_id))field.append(option(doc.file_id,doc.name));
    }
}
function renderVariant(){
    const item=view.item || {};
    form.reset();
    $('material-code').value=item.materialCode || view.node.code;
    $('variant-path').textContent=view.path.map(node=>node.name).join(' → ');
    for(const key of ['desc','type','priceStars','priceRub'])form.elements[key].value=item[key] ?? (key==='type' ? 'free' : '');
    form.elements.disabled.checked=Boolean(item.disabled);
    for(const key of ['telegramFileId','taskTelegramFileId']){
        form.elements[key].replaceChildren(option('','Не выбран'));
        const id=item[key];
        if(id){const doc=(view.files || []).find(file=>file.file_id===id);form.elements[key].append(option(id,doc?.name || 'Ранее выбранный файл'));form.elements[key].value=id;}
    }
    $('price-fields').hidden=item.type!=='paid';
    $('payment-hint').textContent=view.paymentProvider==='yookassa'
        ? 'В приложении выбран способ оплаты ЮKassa. Для продажи используется цена в рублях.'
        : 'В приложении выбран способ оплаты Telegram Stars. Рублёвую цену можно сохранить заранее; она начнёт использоваться после переключения оплаты на ЮKassa.';
    $('save-result').hidden=true;$('save-material').textContent='Сохранить вариант';
    dirty=false;
}
async function loadView(id=null){
    const data=await request('/structure'+(id ? '?parent='+encodeURIComponent(id) : ''));
    view=data;dirty=false;nameAction=null;$('name-form').hidden=true;
    $('breadcrumbs').replaceChildren(button('Все учебные заведения','root'));
    for(const node of data.path){
        const crumb=button(node.name,'open',node.id);
        if(node.id===id)crumb.setAttribute('aria-current','page');
        $('breadcrumbs').append(crumb);
    }
    $('view-title').textContent=data.node ? data.node.name : 'Учебные заведения';
    $('view-code').textContent=data.path.length ? 'ID: '+formattedCode(data.path) : 'Создавайте разделы и открывайте их, чтобы перейти на следующую ступень.';
    $('current-actions').hidden=!data.node;
    const variant=data.node?.level===6;
    $('branch-panel').hidden=variant;$('variant-panel').hidden=!variant;
    $('node-search').value='';
    if(variant){
        renderVariant();libraryOffset=0;libraryQuery='';$('files-search').value='';
    }else{
        const next=levels[(data.node?.level ?? -1)+1];
        $('create-node').textContent='Создать: '+next.title.toLocaleLowerCase('ru');
        $('level-hint').textContent=next.plural+'. Номера назначаются автоматически внутри этого раздела, начиная с 01.';
        renderChildren();
    }
    $('panel').hidden=false;
    notice(variant ? 'Открыт вариант. Здесь настраиваются цена и файлы.' : 'Откройте раздел или создайте новый.');
    if(variant)await loadLibrary();
}
function navigate(id){if(!busy && mayLeave())void perform(()=>loadView(id));}
function openNameForm(node=null){
    if(busy || !mayLeave())return;
    nameAction=node ? {mode:'rename',node} : {mode:'create',parentId:currentId(),requestKey:crypto.randomUUID()};
    $('name-form-title').textContent=node ? 'Изменить название: '+node.name : 'Создать: '+levels[(view.node?.level ?? -1)+1].title.toLocaleLowerCase('ru');
    $('node-name').value=node?.name || '';
    $('save-name').textContent=node ? 'Сохранить название' : 'Создать';
    $('name-form-hint').textContent=node ? 'ID и покупки сохранятся. Новое название будет показано у всех вложенных материалов.' : 'Номер будет назначен автоматически. Вручную вводить ID не нужно.';
    $('name-result').hidden=true;$('name-form').hidden=false;
    $('node-name').focus();
}
async function removeNode(node){
    if(busy || !mayLeave())return;
    if(!window.confirm('Удалить «'+node.name+'»'+(node.level<6 ? ' и все вложенные разделы' : '')+'?\nВариантов: '+node.variantCount+'.\nОни исчезнут из каталога. Прежние покупки и документы сохранятся.'))return;
    await perform(async()=>{
        const result=await request('/structure/'+node.id,'DELETE',{expectedRevision:view.revision});
        const destination=currentId()===node.id ? result.parentId : currentId();
        await loadView(destination);notice('Раздел удалён из каталога.','success');
    });
}
document.addEventListener('click',event=>{
    const target=event.target.closest('[data-action]');if(!target || busy)return;
    const id=target.dataset.id;
    if(target.dataset.action==='root')navigate(null);
    if(target.dataset.action==='open')navigate(id);
    if(target.dataset.action==='rename')openNameForm(findNode(id));
    if(target.dataset.action==='delete')void removeNode(findNode(id));
});
$('refresh').addEventListener('click',()=>navigate(currentId()));
$('create-node').addEventListener('click',()=>openNameForm());
$('rename-current').addEventListener('click',()=>openNameForm(view.node));
$('delete-current').addEventListener('click',()=>removeNode(view.node));
$('node-search').addEventListener('input',renderChildren);
$('cancel-name').addEventListener('click',()=>{$('name-form').hidden=true;nameAction=null;});
$('node-name').addEventListener('input',()=>{if(nameAction?.mode==='create')nameAction.requestKey=crypto.randomUUID();});
$('name-form').addEventListener('submit',event=>{
    event.preventDefault();if(busy || !nameAction)return;
    const name=$('node-name').value.trim(),action=nameAction;
    if(!name || name.length>200){notice('Введите название от 1 до 200 символов.','error',$('name-result'));return;}
    void perform(async()=>{
        notice('Сохраняем…','pending',$('name-result'));
        if(action.mode==='create'){
            const result=await request('/structure','POST',{parentId:action.parentId,name,requestKey:action.requestKey});
            await loadView(result.node.id);notice('Создано: '+name+'. Номер назначен автоматически.','success');
        }else{
            await request('/structure/'+action.node.id,'PATCH',{name,expectedVersion:action.node.version});
            await loadView(currentId());notice('Название сохранено.','success');
        }
    },$('name-result'));
});
function changedVariant(){
    dirty=true;$('save-result').hidden=true;$('save-material').textContent='Сохранить вариант';
    $('price-fields').hidden=form.elements.type.value!=='paid';
}
form.addEventListener('input',changedVariant);form.addEventListener('change',changedVariant);
form.addEventListener('submit',event=>{
    event.preventDefault();if(busy || view?.node?.level!==6)return;
    const invalid=[...form.elements].find(field=>field.willValidate && !field.validity.valid);
    if(invalid){notice('Проверьте поле «'+(invalid.labels?.[0]?.textContent.trim() || invalid.name)+'». Цена — целое число от 1 до 100000 или пустое поле.','error',$('save-result'));return;}
    const body={expectedVersion:view.node.version,disabled:form.elements.disabled.checked};
    for(const key of ['desc','type','telegramFileId','taskTelegramFileId'])body[key]=form.elements[key].value;
    for(const key of ['priceStars','priceRub'])body[key]=form.elements[key].value ? Number(form.elements[key].value) : null;
    void perform(async()=>{
        const button=$('save-material');button.textContent='Сохраняем…';button.setAttribute('aria-busy','true');
        notice('Сохраняем вариант. Дождитесь ответа сервера.','pending',$('save-result'));
        let saved=false;
        try{
            const result=await request('/structure/'+view.node.id+'/variant','PUT',body);
            if(result.saved!==true)throw new Error('Сервер не подтвердил сохранение. Обновите вариант и проверьте данные.');
            updateSavedFileUsage(view.item,result.item);
            view.node={...view.node,...result.node};view.item=result.item;view.revision=result.revision;dirty=false;saved=true;
            notice('Вариант сохранён. ID: '+result.item.materialCode+'.','success',$('save-result'));
            notice('Цена и файлы варианта сохранены.','success');
            button.textContent='✓ Сохранено';
        }finally{button.removeAttribute('aria-busy');button.textContent=saved ? '✓ Сохранено' : 'Сохранить вариант';}
    },$('save-result'));
});

function updateSavedFileUsage(previous,item){
    const oldLabel=materialLabel(previous),newLabel=materialLabel(item);
    for(const doc of libraryDocs){
        doc.usedIn=(doc.usedIn || []).filter(label=>label!==oldLabel);
        if(item.telegramFileId===doc.file_id || item.taskTelegramFileId===doc.file_id)doc.usedIn.push(newLabel);
        const text=[...$('file-library').querySelectorAll('[data-file-usage]')].find(node=>node.dataset.fileUsage===doc.file_id);
        if(text)text.textContent=doc.usedIn.length ? 'Используется: '+doc.usedIn.join('; ') : 'Не назначен вариантам';
    }
}

function selectFile(key,doc){
    if(busy || view?.node?.level!==6)return;
    addFileOptions([doc]);form.elements[key].value=doc.file_id;changedVariant();
    notice('Файл выбран для «'+view.node.name+'». Нажмите «Сохранить вариант».','info');
}
async function loadLibrary(){
    if(view?.node?.level!==6)return;
    const data=await request('/uploads?q='+encodeURIComponent(libraryQuery)+'&offset='+libraryOffset);
    libraryDocs=data.uploads;
    libraryCount=data.uploads.length;
    addFileOptions(data.uploads);
    $('storage-group').textContent=data.storageGroup ? 'Группа загрузки подключена.' : 'Группа ещё не подключена. Можно отправить документы в личный чат бота.';
    const container=$('file-library');container.replaceChildren();
    for(const doc of data.uploads){
        const row=document.createElement('div');row.className='order';
        const title=document.createElement('strong');title.textContent=doc.name;row.append(title);
        const used=document.createElement('p');used.dataset.fileUsage=doc.file_id;used.textContent=doc.usedIn?.length ? 'Используется: '+doc.usedIn.join('; ') : 'Не назначен вариантам';row.append(used);
        const label=document.createElement('label');label.textContent='Метка для поиска';
        const folder=document.createElement('input');folder.value=doc.folder || '';folder.maxLength=200;label.append(folder);row.append(label);
        for(const [text,handler] of [
            ['Сохранить метку',()=>perform(async()=>{await request('/uploads/'+encodeURIComponent(doc.file_id),'PUT',{folder:folder.value});notice('Метка файла сохранена.','success');})],
            ['Выбрать решением',()=>selectFile('telegramFileId',doc)],
            ['Выбрать заданием',()=>selectFile('taskTelegramFileId',doc)]
        ]){
            const button=document.createElement('button');button.type='button';button.textContent=text;button.addEventListener('click',handler);row.append(button);
        }
        container.append(row);
    }
    if(!data.uploads.length)container.textContent='Документы не найдены. Загрузите файл боту и обновите библиотеку.';
    $('files-prev').disabled=libraryOffset===0;$('files-next').disabled=data.uploads.length<100;
    $('files-page').textContent='Страница '+(libraryOffset/100+1);
}
$('files-search-button').addEventListener('click',()=>{if(busy)return;libraryQuery=$('files-search').value.trim();libraryOffset=0;void perform(loadLibrary);});
$('files-search').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('files-search-button').click();}});
$('files-prev').addEventListener('click',()=>{if(busy || libraryOffset===0)return;libraryOffset=Math.max(0,libraryOffset-100);void perform(loadLibrary);});
$('files-next').addEventListener('click',()=>{if(busy)return;libraryOffset+=100;void perform(loadLibrary);});
async function loadOrders(){
    const orders=await request('/orders'),container=$('orders');container.replaceChildren();
    const labels={pending:'Ожидает оплаты',checkout:'Подтверждение оплаты',paid:'В очереди выдачи',sent:'Отправлен',refunded:'Возвращён',canceled:'Отменён'};
    for(const order of orders){
        const price=order.currency==='RUB' ? (order.amount/100).toFixed(2)+' ₽' : order.amount+' ★';
        const row=document.createElement('div');row.className='order';
        for(const text of [order.title,'Заказ: '+order.id,'Пользователь: '+order.user_id,(labels[order.status] || order.status)+' · '+price]){
            const p=document.createElement('p');p.textContent=text;row.append(p);
        }
        if(['paid','sent'].includes(order.status))for(const action of ['resend',...(order.amount>0 ? ['refund'] : [])]){
            const button=document.createElement('button');button.textContent=action==='resend' ? 'Отправить повторно' : 'Вернуть '+price;
            button.addEventListener('click',()=>{
                if(busy || (action==='refund' && !window.confirm('Вернуть '+price+' по заказу '+order.id+'?')))return;
                void perform(async()=>{await request('/orders/'+order.id+'/'+action,'POST',{});await loadOrders();notice(action==='resend' ? 'Файл поставлен в очередь.' : 'Возврат обработан.','success');});
            });row.append(button);
        }
        container.append(row);
    }
    if(!orders.length)container.textContent='Заказов пока нет.';ordersLoaded=true;
}
$('load-orders').addEventListener('click',()=>perform(loadOrders));
$('orders-panel').addEventListener('toggle',()=>{if($('orders-panel').open && !ordersLoaded && !busy)void perform(loadOrders);});
tg?.ready();tg?.expand();void perform(()=>loadView());
