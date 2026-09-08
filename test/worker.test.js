'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createWorker}=require('../src/worker');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('worker wakes immediately for new work and does not poll idle storage continuously',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    let deliveries=0;
    const worker=createWorker(async()=>{deliveries++;},async()=>900000);
    worker.wake();await tick();
    assert.equal(deliveries,1);
    t.mock.timers.tick(60000);await tick();assert.equal(deliveries,1);
    worker.wake();await tick();assert.equal(deliveries,2);
    worker.stop();t.mock.timers.tick(900000);await tick();assert.equal(deliveries,2);
});
test('worker preserves wake requests received during an active delivery',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    let release, deliveries=0;
    const worker=createWorker(async()=>{deliveries++;if(deliveries===1) await new Promise(resolve=>{release=resolve;});},async()=>900000);
    worker.wake();worker.wake();release();await tick();
    t.mock.timers.tick(0);await tick();
    assert.equal(deliveries,2);worker.stop();
});
