const test=require('node:test'),assert=require('node:assert/strict');
const {reviewLocation,reviewAnchor}=require('./members.js');
test('review highlights bind exact version and exact text offsets',()=>{const r={version_hash:'v1',target_type:'paragraph',target_id:JSON.stringify({blockId:'p1',start:3,end:5}),quote:'证据'};assert.deepEqual(reviewLocation(r,'v1','这里的证据明确'),{blockId:'p1',start:3,end:5});assert.equal(reviewLocation(r,'v2','这里的证据明确'),null);assert.equal(reviewLocation(r,'v1','变化后的证据明确'),null);assert.equal(reviewLocation({...r,target_id:'{"blockId":"p1","start":-1,"end":5}'},'v1','这里的证据明确'),null);});
test('legacy feedback highlights only unambiguous quotation in the original block',()=>{const r={version_hash:'v1',target_type:'paragraph',target_id:'p1',quote:'证据'};assert.deepEqual(reviewLocation(r,'v1','该证据明确'),{blockId:'p1',start:1,end:3});assert.equal(reviewLocation(r,'v1','证据与证据'),null);assert.equal(reviewLocation({...r,target_type:'article'},'v1','该证据明确'),null);});
test('review selection rejects outside body or overlong text',()=>{const block={dataset:{blockId:'p1'},querySelector:()=>null};const range={commonAncestorContainer:{nodeType:1,closest:()=>block},toString:()=> '证据',cloneRange:()=>({selectNodeContents(){},setEnd(){},toString:()=> '该'})};const selection={isCollapsed:false,rangeCount:1,getRangeAt:()=>range};assert.deepEqual(reviewAnchor(selection,{contains:()=>true}),{blockId:'p1',start:1,end:3,quote:'证据'});assert.equal(reviewAnchor(selection,{contains:()=>false}),null);range.toString=()=> 'x'.repeat(2001);assert.equal(reviewAnchor(selection,{contains:()=>true}),null);});


test('existing and historic review offsets survive only a proven same-block whitespace presentation repair',()=>{
 const legacy='产物 1 在 5 mL 溶剂中反应。',text='产物1在5 mL溶剂中反应。',quote='1 在 5 mL 溶剂';const start=legacy.indexOf(quote);
 const record={version_hash:'v',target_type:'paragraph',target_id:JSON.stringify({blockId:'p',start,end:start+quote.length}),quote};const frozen=JSON.stringify(record);
 assert.deepEqual(reviewLocation(record,'v',text,legacy),{blockId:'p',start:2,end:text.indexOf('中')});assert.equal(JSON.stringify(record),frozen);
 assert.equal(reviewLocation(record,'other',text,legacy),null);assert.equal(reviewLocation(record,'v',text.replace('反应','变化'),legacy),null);assert.equal(reviewLocation(record,'v',text),null);
});
