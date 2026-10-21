const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const exporter=require('../member-system/article-export.js');
test('original figure, extended figure and table labels override sequential asset names',()=>{
 const labels=['图1','扩展图1','表1','表2','表3','表4','图2','图3','扩展图2','扩展图3'];
 const blocks=labels.map((label,i)=>({id:'f'+i,kind:'figure',src:`figures/figure-${String(i+1).padStart(2,'0')}.png`,text:label+'｜科学说明'}));
 const sourceLabels=Object.fromEntries(blocks.map((b,i)=>[b.src,labels[i]]));
 const plan=exporter.figurePlan(blocks,sourceLabels);assert.deepEqual(plan.map(f=>f.reference),labels.map(l=>'原文'+l));assert.deepEqual(plan.map(f=>f.number),labels.map((_,i)=>String(i+1).padStart(2,'0')));
 const html=exporter.render(blocks,new Map(),{placeholders:true,sourceLabels});assert.match(html,/插入图片03｜原文表1/);assert.match(html,/插入图片10｜原文扩展图3/);
});
test('scheme panel labels retain their real panel letters without changing insertion order',()=>{const blocks=['scheme-01.png','scheme-03d.png','scheme-01bc.png'].map((file,i)=>({id:'s'+i,kind:'figure',src:'figures/'+file,text:'图式1｜说明'}));const plan=exporter.figurePlan(blocks,{'s0':'图式1','s1':'图式3D（局部）','s2':'图式1BC（局部）'});assert.deepEqual(plan.map(f=>f.reference),['原文图式1','原文图式3D（局部）','原文图式1BC（局部）']);assert.equal(plan[2].number,'03');});
test('legacy deliberate guide and source numbering remains unchanged',()=>{const plan=exporter.figurePlan([{id:'f',kind:'figure',src:'figures/scheme-01.png',text:'图式2｜导读编号'}]);assert.equal(plan[0].reference,'原文图式01｜文中图式2');assert.equal(plan[0].stem,'01-图式01');});
