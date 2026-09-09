'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildCode,parseCode,formatCode,isCode,label} = require('../public/catalog-tools');
test('material code preserves leading zeros, separates variant and rejects partial or oversized segments',()=>{
    const values = {institution:'1',specialty:'2',course:'1',semester:'1',subject:'3',work:'4',variant:'5'};
    assert.equal(buildCode(values),'0102110304_05');
    assert.equal(formatCode(buildCode(values)),'01 02 1 1 03 04 _05');
    assert.deepEqual(parseCode(buildCode(values)),{institution:'01',specialty:'02',course:'1',semester:'1',subject:'03',work:'04',variant:'05'});
    for (const extra of [{variant:''},{course:'10'},{institution:'abc'},{work:'100'},{variant:'-1'},{subject:'1.2'}]) assert.equal(buildCode({...values,...extra}),'');
    assert.equal(isCode('01 02 1 1 03 04 _05'),false);
    assert.equal(isCode('0102110304_05'),true);
    assert.match(label('old',{materialCode:'0102110304_05',course:'1 курс',semester:'1 семестр',subject:'Математика',name:'ДЗ',variant:'5'}),/1 курс → 1 семестр → Математика → ДЗ → 5 → ID 0102110304_05/);
});
