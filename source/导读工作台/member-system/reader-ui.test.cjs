const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const format=require('../inline-format.js'),{createReaderJumpController}=require('../reader-chrome.js');
test('ligand stars use superscript consistently without consuming bold/italic delimiters',()=>{
 for(const text of ['L*1–L*3','**L*1** 与 **L*9**','**L∗2**','*L*1*']){
  const html=format.html(text);assert.match(html,/<sup [^>]*>&#42;<\/sup>/);assert(!html.includes('L*'));
 }
 assert.match(format.html('**L*1**'),/^<strong>L<sup .*<\/sup>1<\/strong>$/);
 assert.equal(format.html('**图 1** 和 *N,N,P*'),'<strong>图1</strong>和<em>N,N,P</em>');
 assert(!format.html('<script>x</script>').includes('<script>'));
 assert.match(format.html('S<sub>N</sub>2'),/S<sub>N<\/sub>2/);
 const exported=require('./article-export.js').render([{kind:'paragraph',text:'**L*1**'}],new Map());assert(exported.replace(/\sstyle="[^"]*"/g,'').includes(format.html('**L*1**').replace(/\sstyle="[^"]*"/g,'')));
});
test('page jumps return to the original reading anchor without browser history',async()=>{
 let position={x:0,y:730,anchor:{blockId:'synthetic',offset:17}},events=[],moved=[];
 const controller=createReaderJumpController(()=>({...position}),edge=>moved.push(edge),saved=>position=saved,active=>events.push(active));
 await controller.jump('top');assert.equal(controller.edge,'top');position={y:0};
 await controller.jump('bottom');assert.equal(controller.edge,'bottom');position={y:5000};
 await controller.jump('bottom');assert.equal(controller.edge,null);assert.equal(position.y,730);assert.equal(position.anchor.offset,17);assert.deepEqual(moved,['top','bottom']);assert.deepEqual(events,['top','bottom',null]);
});
test('archived versions return the read-only reader before mutable controls mount',()=>{
 const src=fs.readFileSync(path.join(__dirname,'members.js'),'utf8');let readonly=0;
 const context={URLSearchParams,location:{search:'?review=1&version=archived'},mountHistoricReader:()=>{readonly++;return 'readonly';}};vm.createContext(context);
 const at=src.indexOf('  function mountReviewReader('),end=src.indexOf('\n  function ',at+4);vm.runInContext(src.slice(src.indexOf('  function clearPendingAnnotation('),src.indexOf('  function annotationPopupPosition('))+src.slice(at,end)+';this.mount=mountReviewReader;',context);
 assert.equal(context.mount({articleId:'synthetic',revision:'a'.repeat(64)}),'readonly');assert.equal(readonly,1);
});
test('opening a reading drawer dismisses the sentence editor first',async()=>{
 const src=fs.readFileSync(path.join(__dirname,'../reader-chrome.js'),'utf8'),at=src.indexOf('  async function showPanel('),end=src.indexOf('\n  function panel(',at),editor={hidden:false};
 const context={document:{querySelectorAll:()=>[editor]},closePanel:async()=>{},openPanel:null,backdrop:{hidden:true},returnFocus:null};vm.createContext(context);vm.runInContext(src.slice(at,end)+';this.open=showPanel;',context);
 const panel={hidden:true,dataset:{},classList:{contains:()=>false},querySelectorAll:()=>[],querySelector:()=>null},trigger={setAttribute(){}};
 await context.open(panel,trigger);assert.equal(editor.hidden,true);assert.equal(panel.hidden,false);
});
test('existing feedback reuses one editor and saves via versioned PUT; new feedback uses POST',async()=>{
 const src=fs.readFileSync(path.join(__dirname,'members.js'),'utf8'),nodes=[],calls=[],highlights=new Map(),CSS={highlights};class Highlight{constructor(...ranges){this.ranges=ranges;}}
 class Node{constructor(tag,text,cls){this.tag=tag;this.textContent=text;this.className=cls;this.children=[];this.hidden=false;this.value='';this.classList={add(){},remove(){}};}append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}setAttribute(){}addEventListener(){}removeEventListener(){}querySelectorAll(){return [];}querySelector(){return null;}remove(){this.hidden=true;}focus(){}}
 const el=(tag,text,cls)=>{const n=new Node(tag,text,cls);nodes.push(n);return n;},root=el('main'),toolbar=el('nav'),draft={feedback:[{id:'f1',uid:'admin',version_hash:'a'.repeat(64),target_type:'paragraph',target_id:'b1',quote:'synthetic quote',comment:'original'}]},selection={isCollapsed:true,removeAllRanges(){}};
 const document={body:el('body'),addEventListener(){},removeEventListener(){},querySelectorAll:()=>nodes.filter(n=>n.className==='member-review-editor')};
 const context={document,CSS,Highlight,URLSearchParams,location:{search:'?review=1'},state:{epoch:1,user:{id:'admin'}},el,global:{CSS,Highlight,getSelection:()=>selection},positionAnnotationPopup(){},mountVersionHistory(){},mountArticleExport(){},mountHistoricReader(){throw Error('must be current')},mountHighlightNotes:()=>()=>{},reviewLocation:()=>null,reviewAnchor:()=>null,closeAnnotationButton:action=>{const n=el('button','X');n.act=action;return n;},button:(text,action)=>{const n=el('button',text);n.act=action;return n;},notify(){},clearTimeout,setTimeout,api:async(route,data,method)=>{calls.push({route,data,method});return {id:method==='PUT'?'f1':'f2',comment:data.comment,edit_revision:1};}};
 vm.createContext(context);const at=src.indexOf('  function mountReviewReader('),end=src.indexOf('\n  function ',at+4);vm.runInContext(src.slice(src.indexOf('  function clearPendingAnnotation('),src.indexOf('  function annotationPopupPosition('))+src.slice(at,end)+';this.mount=mountReviewReader;',context);
 context.mount({articleId:'paper',revision:'a'.repeat(64),root,toolbar,draft});
 const editor=nodes.find(n=>n.className==='member-review-editor'),input=nodes.find(n=>n.tag==='textarea');
 nodes.find(n=>n.textContent==='查看 / 修改批注').act();assert.equal(editor.hidden,false);assert.equal(input.value,'original');input.value='edited';await nodes.find(n=>n.textContent==='保存批注').act();assert.equal(editor.hidden,true);assert.equal(calls[0].method,'PUT');assert.equal(calls[0].route,'admin/drafts/paper/feedback/f1');assert.equal(calls[0].data.edit_revision,0);
 nodes.find(n=>n.textContent==='整篇意见').act();assert.equal(editor.hidden,false);assert.equal(input.value,'');input.value='new article note';await nodes.find(n=>n.textContent==='保存批注').act();assert.equal(calls[1].method,undefined);assert.equal(calls[1].route,'admin/drafts/paper/feedback');assert.equal(editor.hidden,true);assert.equal(nodes.filter(n=>n.className==='member-review-editor').length,1);
 const clone={kind:'cloned-native-selection'},range={cloneRange:()=>clone};selection.isCollapsed=false;selection.rangeCount=1;selection.getRangeAt=()=>range;context.reviewAnchor=()=>({blockId:'b1',quote:'new quote',start:0,end:9});
 const before=calls.length;nodes.find(n=>n.textContent==='写批注').act();assert.equal(calls.length,before);assert.equal(highlights.get('read-pending-annotation').ranges[0],clone);assert.equal(editor.hidden,false);
 selection.isCollapsed=true;selection.rangeCount=0;assert(highlights.has('read-pending-annotation'),'trace must survive focus collapsing the native selection');
 nodes.find(n=>n.textContent==='X').act();assert.equal(highlights.has('read-pending-annotation'),false);assert.equal(calls.length,before,'cancel never saves');
 selection.isCollapsed=false;selection.rangeCount=1;nodes.find(n=>n.textContent==='写批注').act();input.value='explicit save';await nodes.find(n=>n.textContent==='保存批注').act();assert.equal(calls.length,before+1);assert.equal(highlights.has('read-pending-annotation'),false);assert(highlights.has('read-review-notes'),'saved yellow feedback registry remains independent');

});


test('annotation editor returns to bottom-right on desktop and avoids the selected text with a mobile keyboard',()=>{
 const {annotationPopupPosition}=require('./members.js');
 const desktop=annotationPopupPosition({left:100,right:200,top:200,bottom:225},{height:350},{left:0,top:0,width:1440,height:900});assert.equal(desktop.left,1008);assert.equal(desktop.top,538);
 for(const viewport of [{left:0,top:0,width:390,height:844},{left:10,top:30,width:320,height:300}]){
  const anchor={left:40,right:260,top:viewport.top+viewport.height-80,bottom:viewport.top+viewport.height-60};
  const p=annotationPopupPosition(anchor,{height:350},viewport),height=Math.min(350,p.maxHeight);
  assert(p.top+height<=anchor.top||p.top>=anchor.bottom,'mobile editor must leave the selected text exposed');assert(p.left>=viewport.left+12);assert(p.top>=viewport.top+12);assert(p.left+p.width<=viewport.left+viewport.width-12);assert(p.top+height<=viewport.top+viewport.height-12);
 }
});
