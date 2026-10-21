'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {updatedToday,sourceUrl}=require('../card-actions.js');
const {createSessionCache,annotationPopupPosition}=require('../member-system/members.js');
test('New uses real zoned update time in Beijing; publication date and unknown time are insufficient',()=>{
 const now=new Date('2026-10-20T00:30:00+08:00');
 assert.equal(updatedToday('2026-10-19T16:10:00Z',now),true);assert.equal(updatedToday('2026-10-19T15:59:00Z',now),false);
 for(const value of [null,'2026-10-20','2026-10-20T00:10:00','invalid'])assert.equal(updatedToday(value,now),false);
 assert.equal(sourceUrl({doi:'10.1021/synthetic.1'}),'https://doi.org/10.1021/synthetic.1');
 assert.equal(sourceUrl({sourceUrl:'javascript:bad',doi:'invalid'}),null);
});
test('favorite presentation persists only explicitly public IDs, without notes/roles/tokens',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const cache=createSessionCache(storage);await cache.read(async()=>({user:{id:'reader',email:'reader@example.invalid',role:'admin'},configured:true,csrfToken:'secret'}));
 cache.rememberFavorites(['public-1','private-draft'],['public-1']);
 const shown=await createSessionCache(storage).read(()=>{throw Error('fresh presentation must not refetch');});assert.deepEqual(shown.favoriteIds,['public-1']);assert.equal(shown.user.role,undefined);assert.equal(shown.csrfToken,'');
 assert(!JSON.stringify([...values.values()]).includes('private-draft'));cache.invalidate();assert.equal(values.size,0);
});
test('selection popup stays beside desktop text and inside mobile/keyboard viewport',()=>{
 for(const viewport of [{left:0,top:0,width:1440,height:900},{left:0,top:0,width:390,height:844},{left:10,top:30,width:320,height:300}]){
  const p=annotationPopupPosition({left:50,right:200,top:viewport.top+viewport.height-35,bottom:viewport.top+viewport.height-20},{height:350},viewport);
  assert(p.left>=viewport.left+12);assert(p.top>=viewport.top+12);assert(p.left+p.width<=viewport.left+viewport.width-12);assert(p.maxHeight<=viewport.height-24);
 }
});
class Node{
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.listeners={};this.disabled=false;this.isConnected=true;}
 append(...children){for(const n of children){n.parentElement=this;this.children.push(n);}}
 setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}
 addEventListener(k,fn){this.listeners[k]=fn;}querySelector(s){return this.children.find(n=>'.'+n.className===s)||null;}remove(){this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
}
test('card actions stay in metadata outside article links; unknown favorite state confirms before toggling in place',async()=>{
 const nodes=[],events={},body=new Node('body'),document={readyState:'complete',createElement:tag=>{const n=new Node(tag);nodes.push(n);return n;},addEventListener:(name,fn)=>events[name]=fn,querySelectorAll:()=>nodes.filter(n=>n.dataset.favoriteArticle&&n.isConnected)};
 let confirm;const ready=new Promise(r=>confirm=r),state={library:{favorites:[]}};let toggles=0;
 const context={document,URL,Date,Intl,ReadMembers:{ready,state,toggleFavorite:async id=>{toggles++;assert(state.library.favorites.includes(id),'must use confirmed state, not an unknown false');state.library.favorites=[];}}};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(__dirname+'/../card-actions.js','utf8'),context);
 const card=new Node('article'),main=new Node('a'),metadata=new Node('div');metadata.className='card-meta-row';card.append(main,metadata);body.append(card);let removed=0;
 const button=context.ReadCardActions.mount(card,{id:'published',public:true,doi:'10.1021/synthetic.1'},{onRemoved:()=>removed++});
 assert.equal(card.children[0],main);assert.equal(card.children[1],metadata);assert.equal(metadata.children[0].className,'card-actions');const original=metadata.children[0].children[1];assert.equal(original.target,'_blank');assert.equal(original.rel,'noopener');assert(!main.children.includes(button));
 let prevented=0;const work=button.listeners.click({preventDefault(){prevented++;},stopPropagation(){prevented++;}});await Promise.resolve();assert.equal(toggles,0);
 state.library.favorites=['published'];context.ReadCardActions.refresh();confirm();await work;assert.equal(toggles,1);assert.equal(button.getAttribute('aria-pressed'),'false');assert.equal(removed,1);assert.equal(card.children[0],main);assert.equal(prevented,2);
});
test('highlighter is off by default; only enabled selection opens the same editor, saved notes still open when off',()=>{
 const source=fs.readFileSync(__dirname+'/../member-system/members.js','utf8'),at=source.indexOf('  function mountReviewReader('),end=source.indexOf('\n  function ',at+4),nodes=[],listeners={},timers=[];
 class Element extends Node{constructor(tag,text,cls){super(tag);this.textContent=text;this.className=cls;this.value='';this.hidden=false;this.classList={add(){},remove(){}};}replaceChildren(...items){this.children=items;}querySelectorAll(){return [];}focus(){}}
 const el=(tag,text,cls)=>{const n=new Element(tag,text,cls);nodes.push(n);return n;},root=el('main'),toolbar=el('nav');let selection=null;
 const context={document:{body:el('body'),addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener(){},querySelectorAll:()=>nodes.filter(n=>n.className==='member-review-editor')},URLSearchParams,location:{search:'?review=1'},state:{epoch:1,user:{id:'admin'}},el,global:{getSelection:()=>({isCollapsed:true,removeAllRanges(){}})},mountVersionHistory(){},mountArticleExport(){},mountHistoricReader(){},mountHighlightNotes:()=>()=>{},positionAnnotationPopup(){},reviewLocation:()=>null,reviewAnchor:()=>selection,closeAnnotationButton:action=>{const n=el('button','X');n.act=action;return n;},button:(text,action)=>{const n=el('button',text);n.act=action;return n;},notify(){},clearTimeout:()=>timers.splice(0),setTimeout:fn=>{timers.push(fn);return 1;}};
 vm.createContext(context);vm.runInContext(source.slice(at,end)+';this.mount=mountReviewReader;',context);context.mount({articleId:'synthetic',revision:'a'.repeat(64),root,toolbar,draft:{feedback:[]}});
 const marker=nodes.find(n=>n.textContent==='荧光笔'),editor=nodes.find(n=>n.className==='member-review-editor');assert.equal(marker.getAttribute('aria-pressed'),'false');
 listeners.selectionchange();assert.equal(timers.length,0);marker.act();assert.equal(marker.getAttribute('aria-pressed'),'true');assert.equal(editor.hidden,true);
 selection={blockId:'b1',quote:'synthetic quote',start:0,end:15};listeners.selectionchange();timers.shift()();assert.equal(editor.hidden,false);
 marker.act();assert.equal(marker.getAttribute('aria-pressed'),'false');assert.equal(editor.hidden,true);listeners.selectionchange();assert.equal(timers.length,0);assert.equal(nodes.filter(n=>n.textContent==='荧光笔').length,1);
});
