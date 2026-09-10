'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {code,formattedCode,levels}=require('../public/hierarchy-tools');
test('automatic catalog codes use two digits at each level and underscore before variant',()=>{
    const path=[1,2,1,1,3,4,5].map((number,level)=>({number,level}));
    assert.equal(levels.length,7);
    assert.equal(code(path),'010201010304_05');
    assert.equal(formattedCode(path),'01 02 01 01 03 04 _05');
    assert.equal(code(path.slice(0,5)),'0102010103');
});
