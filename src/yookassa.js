'use strict';
function amountRub(minor) { return (minor / 100).toFixed(2); }
function minorRub(value) {
    if(typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) return null;
    const [rub, kopecks] = value.split('.');
    const minor = Number(rub) * 100 + Number(kopecks);
    return Number.isSafeInteger(minor) ? minor : null;
}
function yookassaClient(env) {
    return async (method, resource, body, key) => {
        const response = await fetch('https://api.yookassa.ru/v3/' + resource, {
            method, headers: { 'Content-Type':'application/json',
                Authorization:'Basic '+Buffer.from(env.YOOKASSA_SHOP_ID+':'+env.YOOKASSA_SECRET_KEY).toString('base64'),
                ...(key ? {'Idempotence-Key':key} : {}) },
            ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(15000)
        });
        const data=await response.json();
        if(!response.ok) throw Object.assign(new Error('ЮKassa временно недоступна.'),{code:'YOOKASSA_'+response.status});
        return data;
    };
}
function matches(order,payment,env) {
    return Boolean(order && order.provider==='yookassa' && order.currency==='RUB'
        && order.provider_payment_id===payment.id && payment.metadata?.orderId===order.id
        && payment.recipient?.account_id===env.YOOKASSA_SHOP_ID
        && payment.amount?.currency==='RUB' && minorRub(payment.amount.value)===order.amount
        && payment.test===(env.YOOKASSA_TEST_MODE==='true'));
}
module.exports={yookassaClient,amountRub,minorRub,matches};
