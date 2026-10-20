const test=require('node:test'),assert=require('node:assert/strict');
const {draftSelection}=require('./members.js');
test('draft feedback selects the current paragraph and preserves exact quotation',()=>{
 const block={dataset:{blockId:'paragraph-7'}};
 const body={contains:n=>n===block};
 const range={commonAncestorContainer:{nodeType:3,parentElement:{closest:()=>block}},toString:()=> '选中的机理证据'};
 const sel={isCollapsed:false,rangeCount:1,getRangeAt:()=>range};
 assert.deepEqual(draftSelection(sel,body),{id:'paragraph-7',quote:'选中的机理证据'});
 assert.equal(draftSelection({...sel,isCollapsed:true},body),null);
 assert.equal(draftSelection(sel,{contains:()=>false}),null);
 range.commonAncestorContainer={nodeType:1,closest:()=>null};
 assert.equal(draftSelection(sel,body),null);
});
