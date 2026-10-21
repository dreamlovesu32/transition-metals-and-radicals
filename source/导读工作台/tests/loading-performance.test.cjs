'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {createSessionCache}=require('../member-system/members.js');
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};};
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
test('anonymous navigation and focus reuse a 30-second response; expired cache refreshes',async()=>{
 let now=1000,calls=0;const store=storage(),request=async()=>{calls++;return {user:null,configured:true,csrfToken:'anonymous'};};
 const first=createSessionCache(store,()=>now);await first.read(request);await first.read(request);assert.equal(calls,1);
 const nextPage=createSessionCache(store,()=>now);await nextPage.read(request);assert.equal(calls,1);
 now+=30001;await nextPage.read(request);assert.equal(calls,2);
});
test('session inflight is merged; explicit authentication refresh bypasses a fresh cache',async()=>{
 let calls=0;const store=storage(),cache=createSessionCache(store),pending=deferred();const request=()=>{calls++;return pending.promise;};
 const a=cache.read(request),b=cache.read(request);assert.equal(a,b);await Promise.resolve();assert.equal(calls,1);
 pending.resolve({user:null,configured:true,csrfToken:'old'});await a;
 const result=await cache.read(async()=>{calls++;return {user:null,configured:true,csrfToken:'new'};},{force:true});assert.equal(result.csrfToken,'new');assert.equal(calls,2);
});
test('account roles never survive navigation; spoofed stored administrators are rejected',async()=>{
 const store=storage(),admin={user:{id:'synthetic',role:'admin'},configured:true,csrfToken:'private'};
 await createSessionCache(store).read(async()=>admin);
 assert.equal(store.values.has('read-anonymous-session-v1'),false);assert.equal([...store.values.values()].some(v=>v.includes('"role"')||v.includes('private')||v.includes('csrfToken')),false);
 const next=createSessionCache(store);assert.equal(next.hint(),true);let calls=0;const cached=await next.read(async()=>{calls++;return admin;});assert.equal(calls,0);assert.equal(cached.user.role,undefined);assert.equal(cached.cached,true);
 store.setItem('read-session-presentation-v2',JSON.stringify({at:Date.now(),configured:true,user:{id:'spoofed',email:'synthetic@example.invalid',role:'admin'},adminNavHint:true,csrfToken:'stolen'}));
 const spoofed=await createSessionCache(store).read(async()=>{calls++;return {user:null,configured:true,csrfToken:'server'};});assert.equal(spoofed.user.role,undefined);assert.equal(spoofed.csrfToken,'');assert.equal(calls,0);
});
test('logout invalidates memory and disk; an old response cannot repopulate the cache',async()=>{
 const store=storage(),cache=createSessionCache(store),old=deferred();const task=cache.read(()=>old.promise);await Promise.resolve();cache.invalidate();
 old.resolve({user:{id:'old',role:'admin'},configured:true,csrfToken:'obsolete'});await task;assert.equal(cache.hint(),false);assert.equal(store.values.size,0);
 let calls=0;await cache.read(async()=>{calls++;return {user:null,configured:true,csrfToken:'fresh'};});assert.equal(calls,1);
});
test('nonfinite, future and expired presentation timestamps never suppress refresh',async()=>{
 for(const at of ['NaN',null,Infinity,20000,-50000]){
   const store=storage();store.setItem('read-session-presentation-v2',JSON.stringify({at,user:{id:'cached',email:'synthetic@example.invalid'},configured:true,adminNavHint:true}));
   let calls=0;await createSessionCache(store,()=>10000).read(async()=>{calls++;return {user:null,configured:true,csrfToken:'fresh'};});assert.equal(calls,1);
 }
});
function preparationHarness(desktop=true){
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const at=source.indexOf('function revealReadingContent('),end=source.indexOf('\nasync function resumeRemoteProgress(',at);
 const nodes=new Map(),node=selector=>{if(!nodes.has(selector))nodes.set(selector,{hidden:false,inert:true,textContent:'',classList:{remove(){}},querySelector:()=>null});return nodes.get(selector);};
 const picture=deferred();let preloads=0,failures=0;
 const wrap={dataset:{figureIndex:'4'},querySelector:()=>({})};
 const ctx={$:node,preparationAttempt:0,panelFigureReady:picture.promise,readingPreparationSaved:null,readingPrepared:false,documentState:{article:{}},currentFigureIndex:0,isDesktopLayout:()=>desktop,CustomEvent:class{},document:{dispatchEvent(){},body:{classList:{remove(){}}}},window:{ReadMedia:{inline(){}}},preloadOtherFigures:()=>preloads++,retryPanelFigure(){},currentInlineFigure:()=>wrap,waitForInlineImage:()=>picture.promise,applyInlineFigureScale(){},showPreparationFailure(){failures++;node('#reading-preparation-retry').hidden=false;node('#reading-preparation-continue').hidden=false;}};
 vm.createContext(ctx);vm.runInContext(source.slice(at,end)+';this.finish=finishReadingPreparation;',ctx);
 return {ctx,node,picture,get preloads(){return preloads;},get failures(){return failures;}};
}
test('body and current original unlock together only after readiness, for desktop and restored single-column figure',async()=>{
 for(const desktop of [true,false]){
  const h=preparationHarness(desktop),job=h.ctx.finish();await Promise.resolve();
  assert.equal(h.ctx.readingPrepared,false);assert.equal(h.node('.layout').inert,true);
  h.picture.resolve('ready');await job;
  assert.equal(h.ctx.readingPrepared,true);assert.equal(h.node('#reading-preparation').hidden,true);assert.equal(h.preloads,1);
  if(!desktop)assert.equal(h.ctx.currentFigureIndex,4);
 }
});
test('failed image stays gated with retry and explicit text-only escape; superseded image cannot unlock',async()=>{
 const h=preparationHarness(),job=h.ctx.finish();h.picture.resolve('error');await job;
 assert.equal(h.ctx.readingPrepared,false);assert.equal(h.failures,1);assert.equal(h.node('#reading-preparation-continue').hidden,false);
 await h.ctx.finish(false,true);assert.equal(h.ctx.readingPrepared,true);assert.equal(h.preloads,0);
 const stale=preparationHarness(),first=stale.ctx.finish(),newPicture=deferred();
 stale.ctx.panelFigureReady=newPicture.promise;stale.picture.resolve('stale');await Promise.resolve();
 assert.equal(stale.ctx.readingPrepared,false);newPicture.resolve('ready');await first;assert.equal(stale.ctx.readingPrepared,true);
});

test('public cache and static reading have no artificial wait for publication service',async()=>{
 const target='../public-site/published-library.js';delete require.cache[require.resolve(target)];
 const original=global.fetch,base={article:{id:'synthetic'},blocks:[],version_hash:'b'.repeat(64)};
 global.fetch=async url=>url==='/base.json'?{ok:true,json:async()=>base}:new Promise(()=>{});
 try{const api=require(target),start=performance.now();assert.equal(await api.read('synthetic','/base.json'),base);assert(performance.now()-start<100);}finally{global.fetch=original;}
});
test('initial reader startup renders before any account request is awaited',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),start=source.slice(source.indexOf('async function start()'));
 const normal=start.slice(start.indexOf('}else documentState'),start.indexOf('renderArticle();'));
 assert(!normal.includes('await window.ReadMembers.ready'));assert(!normal.includes('await window.ReadMembers.loadProgress'));
});
function accountHarness(fetch){
 const source=fs.readFileSync(path.join(__dirname,'../member-system/members.js'),'utf8').replace('const exported={','const exported={requestForTest:api,');
 const context={module:{exports:{}},fetch,AbortSignal,structuredClone,setTimeout,clearTimeout,URLSearchParams,sessionStorage:storage(),CustomEvent:class{}};
 context.globalThis=context;vm.createContext(context);vm.runInContext(source,context);return {context,members:context.module.exports};
}
test('cached account A cannot replay a pending write into confirmed account B',async()=>{
 const requests=[];
 const h=accountHarness(async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({user:{id:'B',role:'member'},configured:true,csrfToken:'new-csrf'})};});
 Object.assign(h.members.state,{user:{id:'A'},authStatus:'cached',csrfToken:'',epoch:1});
 await assert.rejects(h.members.requestForTest('favorites/synthetic',{},'PUT'),/登录状态已变化/);
 assert.equal(requests.length,1);assert(requests[0].url.endsWith('/session'));
});
test('concurrent cached mutations share one refresh and DELETE receives current CSRF',async()=>{
 const requests=[],session=deferred();
 const h=accountHarness(async(url,options)=>{requests.push({url,options});if(url.endsWith('/session'))await session.promise;return {ok:true,json:async()=>url.endsWith('/session')?{user:{id:'A',role:'member'},configured:true,csrfToken:'current-csrf'}:{ok:true}};});
 Object.assign(h.members.state,{user:{id:'A'},authStatus:'cached',csrfToken:'',epoch:1});
 const a=h.members.requestForTest('favorites/one',{},'PUT'),b=h.members.requestForTest('favorites/two',undefined,'DELETE');
 await new Promise(r=>setImmediate(r));assert.equal(requests.length,1);
 session.resolve();await Promise.all([a,b]);assert.equal(requests.length,3);
 assert.equal(requests[2].options.method,'DELETE');for(const request of requests.slice(1))assert.equal(request.options.headers['X-CSRF-Token'],'current-csrf');
});
test('401 clears CSRF and cached admin hints; direct re-login gets fresh preauth',async()=>{
 const requests=[];
 const h=accountHarness(async(url,options)=>{requests.push({url,options});return {ok:!url.endsWith('/notes'),status:url.endsWith('/notes')?401:200,json:async()=>url.endsWith('/notes')?{error:'authentication_required'}:url.endsWith('/session')?{user:null,configured:true,csrfToken:'fresh-preauth'}:{ok:true}};});
 h.context.document={querySelectorAll:()=>[],dispatchEvent(){}};
 Object.assign(h.members.state,{user:{id:'A',role:'admin'},authStatus:'ready',csrfToken:'obsolete',epoch:1,adminNavHint:true});
 await assert.rejects(h.members.requestForTest('notes'),/登录状态已失效/);
 assert.equal(h.members.state.csrfToken,'');assert.equal(h.members.state.adminNavHint,false);
 await h.members.requestForTest('login',{username:'synthetic@example.invalid',password:'synthetic'});
 assert.equal(requests.filter(x=>x.url.endsWith('/session')).length,1);assert.equal(requests.at(-1).options.headers['X-CSRF-Token'],'fresh-preauth');
});
test('figure warm-up is bounded to the next two, then advances in reading order',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),at=source.indexOf('function preloadOtherFigures()'),end=source.indexOf('\nfunction showPreparationFailure',at),requests=[];
 class Image{constructor(){this.dataset={};}set src(value){requests.push(value);queueMicrotask(()=>this.onload());}}
 const context={Image,figurePreloadActive:false,figurePreloadQueued:false,documentState:{},figureBlocks:Array.from({length:39},(_,i)=>({src:'figure-'+i})),currentFigureIndex:0,backgroundFigureImages:[],reviewMode:false,isDesktopLayout:()=>false,articleAsset:x=>x,setTimeout,clearTimeout};
 vm.createContext(context);vm.runInContext(source.slice(at,end)+';this.warm=preloadOtherFigures;',context);
 context.warm();await new Promise(r=>setImmediate(r));assert.deepEqual(requests,['figure-1','figure-2']);
 context.currentFigureIndex=1;context.warm();await new Promise(r=>setImmediate(r));assert.deepEqual(requests,['figure-1','figure-2','figure-3']);
});
test('public reader starts account I/O only after content readiness and a paint opportunity',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../member-system/members.js'),'utf8');
 const at=source.indexOf('  async function waitForReaderContent('),end=source.indexOf('  // Serialize writes',at);
 const listeners={},frames=[];let requests=0;
 const ctx={global:{ReadContentReady:false},state:{epoch:0},document:{body:{classList:{contains:()=>true}},querySelector:()=>null,addEventListener:(name,fn)=>listeners[name]=fn},location:{pathname:'/read.html',search:'?article=synthetic'},URLSearchParams,sessionCache:{peek:()=>null,hint:()=>false},guestLoad:()=>({favorites:[],annotations:[]}),refreshNavigation(){},resolveAuthReady(){},loadReaderContext:async()=>{requests++;return {session:{configured:true,user:null,csrfToken:'synthetic'}};},requestAnimationFrame:fn=>frames.push(fn),setTimeout,notify(){}};
 vm.createContext(ctx);vm.runInContext(source.slice(at,end)+';this.start=init;',ctx);
 const pending=ctx.start();await Promise.resolve();assert.equal(requests,0);
 listeners['read-content-ready']();await Promise.resolve();assert.equal(requests,0);
 frames.shift()();assert.equal(requests,0);frames.shift()();await pending;assert.equal(requests,1);
});
test('private review authenticates before content readiness so drafts never load as a guest',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../member-system/members.js'),'utf8'),at=source.indexOf('  async function waitForReaderContent('),end=source.indexOf('  // Serialize writes',at);let requests=0;
 const ctx={global:{ReadContentReady:false},state:{epoch:0},document:{body:{classList:{contains:()=>true}},querySelector:()=>null,addEventListener(){throw Error('private review must not wait for public text');}},location:{pathname:'/read.html',search:'?article=synthetic&review=1'},URLSearchParams,sessionCache:{peek:()=>null,hint:()=>false},guestLoad:()=>({favorites:[],annotations:[]}),refreshNavigation(){},resolveAuthReady(){},api:async()=>{requests++;return {user:{id:'admin',role:'admin'},csrfToken:'fresh',configured:true};},remoteLoad:async()=>({favorites:[],annotations:[]}),setTimeout,notify(){}};
 vm.createContext(ctx);vm.runInContext(source.slice(at,end)+';this.start=init;',ctx);await ctx.start();assert.equal(requests,1);assert.equal(ctx.state.user.role,'admin');
});
test('highlighter has no second notes button; history retains a read-only record entry',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../reader-chrome.js'),'utf8'),at=source.indexOf('  function convertDetails('),end=source.indexOf('  function tidyMemberTools(',at);
 for(const hasMarker of [true,false]){
  const created=[],existing={setAttribute(){}},ctx={notesPanel:null,annotationButton:hasMarker?existing:null,notesTrigger:null,panel:()=>({querySelector:()=>({append(){}})}),tool:(key,label)=>{created.push({key,label});return {setAttribute(){}};},actions:{append(){}},showPanel(){}};
  vm.createContext(ctx);vm.runInContext(source.slice(at,end)+';this.convert=convertDetails;',ctx);ctx.convert({dataset:{},querySelector:()=>({hidden:false})},'批注','notes',false);
  assert.equal(created.length,hasMarker?0:1);if(hasMarker)assert.equal(ctx.notesTrigger,null);else assert.deepEqual(created[0],{key:'notes',label:'批注记录'});
 }
});


test('panel switching hides the old image until current decode; stale and failed requests stay hidden',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const at=source.indexOf('async function decodeFigureImage('),end=source.indexOf('\nfunction retryPanelFigure(',at);
 const images=[],nodes=new Map(),states=[];
 const node=s=>{if(!nodes.has(s))nodes.set(s,{textContent:'old',innerHTML:'old',remove(){},naturalWidth:300,dataset:{},alt:'old',setAttribute(k,v){this[k]=v;},replaceWith(next){nodes.set('#panel-figure-image',next);}});return nodes.get(s);};
 class FakeImage{
  constructor(){this.dataset={};this.complete=false;this.naturalWidth=500;this.decodingJob=deferred();images.push(this);}
  addEventListener(name,handler){this.listeners ||= {}; (this.listeners[name] ||= new Set()).add(handler);}
  removeEventListener(name,handler){this.listeners?.[name]?.delete(handler);}
  emit(name){for(const handler of [...(this.listeners?.[name]||[])])handler();}
  getAttribute(name){return name==='src'?this.src:null;}
  decode(){return this.decodingJob.promise;}
  replaceWith(next){nodes.set('#panel-figure-image',next);}
 }
 const ctx={$:node,Image:FakeImage,setTimeout,clearTimeout,panelFigureRequest:0,panelFigureReady:null,backgroundFigureImages:[],imageRetryNumber:0,IMAGE_READY_TIMEOUT_MS:40,articleAsset:x=>x,figureMedia:()=>({}),updateDragPanState:stage=>states.push(stage.dataset.imageState),figureScale:1,handlePanelVisibleLoad(){},figurePage:src=>src,inlineMarkdown:text=>text,tr:()=>'',currentFigureIndex:0,figureBlocks:[1,2,3],currentLanguage:'zh'};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function setPanelFigureState('),source.indexOf('function handlePanelVisibleLoad('))+source.slice(at,end),ctx);
 const old=node('#panel-figure-image'),a=ctx.requestPanelFigure({src:'A',text:'captionA'});images[0].emit("load");assert.equal(node('#figure-stage').dataset.hasImage,'false');assert.equal(node('#panel-figure-status').hidden,false);
 ctx.currentFigureIndex=1;ctx.updatePanelFigurePosition();const b=ctx.requestPanelFigure({src:'B',text:'captionB'});images[1].emit("load");
 images[0].decodingJob.resolve();assert.equal(await a,'stale');assert.equal(node('#panel-figure-image'),old);assert.equal(node('#panel-figure-caption').innerHTML,'old');assert.equal(node('#figure-stage').dataset.imageState,'loading');assert.equal(node('.figure-panel-head .rail-kicker').textContent,'原文配图 / 02');
 images[1].decodingJob.resolve();assert.equal(await b,'ready');assert.equal(node('#panel-figure-image').src,'B');assert.equal(node('#panel-figure-caption').innerHTML,'captionB');assert.equal(node('#panel-figure-page').textContent,'B');assert.equal(node('#figure-stage').dataset.hasImage,'true');assert.equal(node('#panel-figure-status').hidden,true);assert.equal(node('.figure-panel-head .rail-kicker').textContent,'原文配图 / 02');
 ctx.currentFigureIndex=2;const c=ctx.requestPanelFigure({src:'C',text:'captionC'});images[2].emit("error");assert.equal(await c,'error');assert.equal(node('#panel-figure-image').src,'B');assert.equal(node('#panel-figure-caption').innerHTML,'captionB');assert.equal(node('#figure-stage').dataset.hasImage,'false');assert.equal(node('#panel-figure-status').hidden,false);
 const timeout=ctx.requestPanelFigure({src:'D',text:'captionD'});assert.equal(await timeout,'timeout');assert.equal(node('#panel-figure-image').src,'B');
 ctx.documentState={blocks:[{kind:'figure',src:'E'}]};ctx.currentFigureIndex=0;
 ctx.primeCurrentFigure();const count=images.length,first=ctx.requestPanelFigure({src:'E',text:'E-old'}),last=ctx.requestPanelFigure({src:'E',text:'E-final'});
 assert.equal(images.length,count);const original=images.at(-1);original.emit('load');original.decodingJob.resolve();
 assert.equal(await first,'stale');assert.equal(await last,'ready');assert.equal(node('#panel-figure-image'),original);assert.equal(node('#panel-figure-caption').innerHTML,'E-final');
 ctx.documentState.blocks=[{kind:'figure',src:'broken'}];ctx.primeCurrentFigure();images.at(-1).complete=true;images.at(-1).naturalWidth=0;
 assert.equal(await ctx.requestPanelFigure({src:'broken',text:'broken'}),'error');
 const inline={isConnected:true,dataset:{},getAttribute:()=> 'inline-current'};ctx.backgroundFigureImages.push(inline);
 const oldCount=images.length,newPanel=ctx.requestPanelFigure({src:'inline-current',text:'inline-current'});assert.equal(images.length,oldCount+1);
 const panelCopy=images.at(-1);panelCopy.emit('load');panelCopy.decodingJob.resolve();assert.equal(await newPanel,'ready');assert.notEqual(node('#panel-figure-image'),inline);
 const cached=new FakeImage();cached.src='cached';cached.complete=true;cached.dataset.decoded='true';ctx.backgroundFigureImages.push(cached);const before=states.length;assert.equal(await ctx.requestPanelFigure({src:'cached',text:'cached'}),'ready');assert.deepEqual(states.slice(before),['ready']);assert.equal(node('#panel-figure-image'),cached);


});
test('single-column current image waits for decode and reports decode failure',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const start=source.indexOf('function waitForInlineImage('),end=source.indexOf('\nfunction preloadOtherFigures(',start);
 for(const failed of [false,true]){
  let resolveDecode,rejectDecode;const pending={promise:new Promise((resolve,reject)=>{resolveDecode=resolve;rejectDecode=reject;})},handlers={};let settled=false;
  const image={dataset:{src:'/current'},complete:true,naturalWidth:400,loading:'lazy',getAttribute:()=>'/current',addEventListener:(k,f)=>handlers[k]=f,removeEventListener(){}};
  const ctx={backgroundFigureImages:[],setTimeout,clearTimeout,IMAGE_READY_TIMEOUT_MS:100,decodeFigureImage:()=>pending.promise,window:{ReadMedia:{load(){}}}};
  vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
  const job=ctx.waitForInlineImage(image).then(value=>{settled=true;return value;});await Promise.resolve();assert.equal(settled,false);
  failed?rejectDecode(Error('decode')):resolveDecode();assert.equal(await job,failed?'error':'ready');
 }
});
test('preparation stays below an interactive header and failure offers a text-only action',()=>{
 for(const file of ['index.html','public-site/read.html']){const html=fs.readFileSync(path.join(__dirname,'..',file),'utf8');assert.ok(html.includes('<header class="topbar">'));assert.ok(html.includes('id="reading-preparation-continue"'));}
 const css=fs.readFileSync(path.join(__dirname,'../app.css'),'utf8');assert.ok(css.includes('inset:var(--reader-header,70px) 0 0'));assert.ok(css.includes('body.reader-preparing .layout{visibility:hidden'));
});


test('a text-only article has no artificial picture failure',async()=>{
 const h=preparationHarness(false);h.ctx.currentInlineFigure=()=>null;h.ctx.waitForInlineImage=image=>Promise.resolve(image?'error':'ready');
 await h.ctx.finish();assert.equal(h.ctx.readingPrepared,true);assert.equal(h.failures,0);
});
test('late remote progress offers explicit resume, never jumps on response, and expires with its owner',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const at=source.indexOf('async function resumeRemoteProgress('),end=source.indexOf('\nfunction mountReadingTools(',at);
 for(const expire of [false,true]){
  const handlers={},buttons=[];let figures=0,restores=0,finishes=0;
  const state={user:{id:'A'},epoch:1},remote={figure:{index:3},scroll:{blockId:'later'}};
  const ctx={reviewMode:false,window:{ReadMembers:{ready:Promise.resolve(),state,loadProgress:async()=>remote}},articleId:()=> 'synthetic',documentState:{version_hash:'v'},storedReadingState:()=>null,readingMode:()=> 'desktop',readingRestoreInterrupted:false,readingPrepared:true,readingPreparationSaved:null,captureReadingState:()=>({figure:{index:0}}),
   document:{createElement(){const b={addEventListener:(name,cb)=>b[name]=cb,remove(){b.removed=true;}};buttons.push(b);return b;},addEventListener:(name,cb)=>handlers[name]=cb,removeEventListener:name=>delete handlers[name],body:{classList:{add(){}}}},
   $:()=>({append(){},inert:false,hidden:true}),DEFAULT_PANE_RATIO:.45,inlineFigureScales:new Map(),showFigure:()=>figures++,setFigureAuto(){},setFigureFillPane(){},restoreReadingState:async()=>restores++,finishReadingPreparation:async()=>finishes++};
  vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);
  const job=ctx.resumeRemoteProgress(()=>false);await new Promise(r=>setImmediate(r));assert.equal(figures,0);assert.equal(restores,0);assert.equal(buttons.length,1);assert.equal(ctx.window.ReadProgressPending,false);
  if(expire){state.user={id:'B'};state.epoch++;handlers['read-members-change']();}else buttons[0].click();
  await job;assert.equal(figures,expire?0:1);assert.equal(finishes,expire?0:1);assert.equal(buttons[0].removed,true);
 }
});


test('unchanged remote progress and a restored local position never create a resume prompt',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const at=source.indexOf('async function resumeRemoteProgress('),end=source.indexOf('\nfunction mountReadingTools(',at);
 for(const localPreferred of [false,true]){
  let created=0;const remote={figure:{index:localPreferred?4:0}},state={user:{id:'A'},epoch:1};
  const ctx={reviewMode:false,window:{ReadMembers:{ready:Promise.resolve(),state,loadProgress:async()=>remote}},articleId:()=> 'synthetic',documentState:{version_hash:'v'},storedReadingState:()=>null,readingMode:()=> 'desktop',readingRestoreInterrupted:false,readingPrepared:true,readingPreparationSaved:localPreferred?{figure:{index:1}}:null,captureReadingState:()=>({figure:{index:0}}),document:{createElement(){created++;throw Error('unexpected resume');}}};
  vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);await ctx.resumeRemoteProgress(()=>false);assert.equal(created,0);
 }
});


test('sequential preloading drops an obsolete window after a figure jump',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');const at=source.indexOf('function preloadOtherFigures('),end=source.indexOf('\nfunction showPreparationFailure(',at);
 const requests=[],images=[];
 class FakeImage{constructor(){this.dataset={};images.push(this);}set src(value){requests.push(value);}}
 const ctx={Image:FakeImage,setTimeout,clearTimeout,isDesktopLayout:()=>true,$:()=>({dataset:{imageState:'ready'}}),documentState:{},currentFigureIndex:0,figureBlocks:Array.from({length:39},(_,i)=>({src:'figure-'+i})),backgroundFigureImages:[],figurePreloadActive:false,figurePreloadQueued:false,reviewMode:false,articleAsset:x=>x,decodeFigureImage:async()=>{}};
 vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);ctx.preloadOtherFigures();assert.deepEqual(requests,['figure-1']);
 ctx.currentFigureIndex=10;ctx.preloadOtherFigures();await images[0].onload();await new Promise(r=>setImmediate(r));assert.deepEqual(requests,['figure-1','figure-11']);
 await images[1].onload();await new Promise(r=>setImmediate(r));assert.deepEqual(requests,['figure-1','figure-11','figure-12']);await images[2].onload();
});


test('reading originals omit small previews and opacity transitions while navigation covers stay progressive',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');const at=source.indexOf('function figureImageMarkup('),end=source.indexOf('\nasync function decodeFigureImage(',at);
 const ctx={figureMedia:()=>({width:800,height:600,preview:'/small.webp'}),articleAsset:()=>'/original.png'};vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);
 const html=ctx.figureImageMarkup({src:'original'},'source');assert.ok(html.includes('data-src="/original.png"'));assert.ok(html.includes('width="800" height="600"'));assert.ok(!html.includes('data-preview'));
 const css=fs.readFileSync(path.join(__dirname,'../progressive-media.css'),'utf8');assert.ok(css.includes('.source-figure .inline-figure-stage img[data-src]{transition:none}'));assert.ok(css.includes('.progressive-media img[data-src]{opacity:0;transition:opacity .2s ease}'));
 const media=fs.readFileSync(path.join(__dirname,'../progressive-media.js'),'utf8');assert.ok(media.includes('image.dataset.preview'));
});


test('configured final figure retains a quarter viewport buffer and releases on scrolling farther back',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');const at=source.indexOf('function isReadingAtEnd('),end=source.indexOf('\nfunction observeFigures(',at);
 for(const height of [400,950]){
  const selected=[],anchors=[10,30,2000].map(top=>({getBoundingClientRect:()=>({top})}));
  const ctx={currentFigureIndex:0,figureBlocks:[{},{},{scrollTrigger:'article-end'}],restoringReadingState:false,figureAuto:true,isDesktopLayout:()=>true,readingPrepared:true,documentState:{article:{scrollThreshold:.52}},window:{scrollY:2000-height-4,innerHeight:height},document:{scrollingElement:{scrollHeight:2000},documentElement:{scrollHeight:2000},querySelectorAll:()=>anchors},showFigure:i=>selected.push(i)};
  vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);
  ctx.syncFigureToScroll();ctx.currentFigureIndex=2;assert.deepEqual(selected,[2]);
  ctx.window.scrollY=2000-height-20;ctx.syncFigureToScroll();assert.deepEqual(selected,[2,2]);
  ctx.window.scrollY=2000-height-height*.3;ctx.syncFigureToScroll();ctx.currentFigureIndex=1;assert.deepEqual(selected,[2,2,1]);
  ctx.figureAuto=false;ctx.window.scrollY=2000-height;ctx.syncFigureToScroll();assert.deepEqual(selected,[2,2,1]);
  ctx.figureAuto=true;ctx.restoringReadingState=true;ctx.syncFigureToScroll();assert.deepEqual(selected,[2,2,1]);
  ctx.restoringReadingState=false;ctx.document.scrollingElement.scrollHeight=3000;ctx.syncFigureToScroll();assert.equal(selected.at(-1),1);
  assert.equal(ctx.isReadingAtEnd(100,0,100),false);
 }
});
test('unconfigured and single-column figures keep natural anchor behavior',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');const at=source.indexOf('function isReadingAtEnd('),end=source.indexOf('\nfunction observeFigures(',at);
 const selected=[],ctx={currentFigureIndex:0,figureBlocks:[{},{},{}],restoringReadingState:false,figureAuto:true,isDesktopLayout:()=>true,readingPrepared:true,documentState:{article:{}},window:{scrollY:1400,innerHeight:600},document:{scrollingElement:{scrollHeight:2000},documentElement:{scrollHeight:2000},querySelectorAll:()=>[0,10,2000].map(top=>({getBoundingClientRect:()=>({top})}))},showFigure:i=>selected.push(i)};
 vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);ctx.syncFigureToScroll();assert.equal(selected.at(-1),1);
 ctx.figureBlocks[0].scrollTrigger='article-end';assert.equal(ctx.articleEndFigureIndex(),-1);
 ctx.updatePanelFigurePosition=()=>{};ctx.isDesktopLayout=()=>false;ctx.currentInlineFigure=()=>({dataset:{figureIndex:'2'}});ctx.currentFigureIndex=0;ctx.preloadOtherFigures=()=>{};ctx.syncFigureToScroll();assert.equal(ctx.currentFigureIndex,2);assert.equal(selected.length,1);
});


test('ordinary anchor hysteresis accumulates micro scrolls and uses distinct stable upward/downward lines',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');const at=source.indexOf('function selectAutoFigure('),end=source.indexOf('\nfunction resetAutoFigureTracking(',at);const ctx={};vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);
 const pick=(tops,current,force=false)=>ctx.selectAutoFigure(tops,current,-1,300,500,900,false,force);
 assert.equal(pick([0,299,700],0),1);
 for(let top=301;top<=390;top++)assert.equal(pick([0,top,top+400],1),1);
 assert.equal(pick([0,391,791],1),0);
 assert.equal(pick([0,310,710],0),0);assert.equal(pick([0,300,700],0),1);
 assert.equal(pick([0,200,210,220,700],0),3);assert.equal(pick([100,390,400,410,800],3),1);
 assert.equal(pick([0,320,700],1,true),0);
 assert.ok(!source.slice(at,end).includes('setTimeout'));
});
test('reading height excludes the chrome and explicit jumps bypass hysteresis only until their clamped target',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');const at=source.indexOf('function isReadingAtEnd('),end=source.indexOf('\nfunction observeFigures(',at);
 const chosen=[];const ctx={currentFigureIndex:1,figureBlocks:[{},{},{}],figureAuto:true,readingPrepared:true,readingPreparationSaved:null,restoringReadingState:false,documentState:{article:{}},isDesktopLayout:()=>true,window:{scrollY:500,innerHeight:600},document:{scrollingElement:{scrollHeight:2000},documentElement:{scrollHeight:2000},querySelector:()=>({getBoundingClientRect:()=>({bottom:100})}),querySelectorAll:()=>[0,320,900].map(top=>({getBoundingClientRect:()=>({top})}))},showFigure:i=>chosen.push(i)};
 vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);assert.equal(ctx.readingVisibleHeight(),500);
 ctx.syncFigureToScroll();assert.equal(chosen.at(-1),1);
 ctx.beginFigureJump(500);assert.equal(chosen.at(-1),0);assert.equal(ctx.syncFigureToScroll.jumpTarget,null);
 ctx.beginFigureJump(5000);assert.equal(ctx.syncFigureToScroll.jumpTarget,1400);assert.equal(chosen.at(-1),2);
 ctx.window.scrollY=1400;ctx.syncFigureToScroll();assert.equal(ctx.syncFigureToScroll.jumpTarget,null);
 ctx.beginFigureJump(0);ctx.cancelFigureJump({target:{closest:()=>true}});assert.equal(ctx.syncFigureToScroll.jumpTarget,0);
 ctx.cancelFigureJump({target:{closest:()=>false}});assert.equal(ctx.syncFigureToScroll.jumpTarget,null);
 ctx.readingPrepared=false;ctx.readingPreparationSaved={figure:{index:1}};ctx.currentFigureIndex=1;ctx.window.scrollY=500;ctx.syncFigureToScroll();assert.equal(chosen.at(-1),1);
 ctx.readingPreparationSaved=null;ctx.syncFigureToScroll();assert.equal(chosen.at(-1),0);
});
test('explicit navigation, auto toggles, reflow and resize all route through immediate recalibration',()=>{
 const root=path.join(__dirname,'..');const app=fs.readFileSync(path.join(root,'app.js'),'utf8'),chrome=fs.readFileSync(path.join(root,'reader-chrome.js'),'utf8'),boot=fs.readFileSync(path.join(root,'public-site/reader-boot.js'),'utf8');
 assert.ok(chrome.includes('beginFigureJump(h.getBoundingClientRect().top+window.scrollY'));
 assert.ok(chrome.includes("beginFigureJump(edge==='top'?0:document.documentElement.scrollHeight)"));
 assert.ok(app.includes('if (enabled) syncFigureToScroll(true);'));
 for(const source of [app,boot])assert.ok(source.includes('resetAutoFigureTracking();'));
});


test('classic centered loading card retains its larger vertical R mark below usable navigation',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../app.css'),'utf8');
 const finalCard=css.slice(css.lastIndexOf('.reading-preparation-card{width:min(360px'));
 assert.match(finalCard,/padding:32px;display:block/);assert.match(finalCard,/font:700 38px Georgia/);
 assert(!finalCard.includes('font-size:22px'));assert(!finalCard.includes('padding:14px 16px'));
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 assert(source.includes('textContent = "正在准备阅读…"'));
});

test('known restored original starts before DOM and layout recovery and shares one pending decode',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const at=source.indexOf('async function decodeFigureImage('),end=source.indexOf('function commitPanelFigure(',at);
 const images=[];let decodeCalls=0;
 class FakeImage{constructor(){this.dataset={};this.naturalWidth=500;images.push(this);}getAttribute(k){return this[k];}decode(){decodeCalls++;return Promise.resolve();}}
 const ctx={Image:FakeImage,documentState:{blocks:[{kind:'figure',src:'first'},{kind:'figure',src:'restored'}]},currentFigureIndex:1,backgroundFigureImages:[],articleAsset:x=>x,figureMedia:()=>({width:300,height:400})};
 vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);
 ctx.primeCurrentFigure();ctx.primeCurrentFigure();assert.equal(images.length,1);assert.equal(images[0].src,'restored');assert.equal(images[0].fetchPriority,'high');
 await Promise.all([ctx.decodeFigureImage(images[0]),ctx.decodeFigureImage(images[0])]);assert.equal(decodeCalls,1);
 ctx.documentState.blocks=[];ctx.primeCurrentFigure();assert.equal(images.length,1);
 for(const file of ['app.js','public-site/reader-boot.js']){const text=fs.readFileSync(path.join(__dirname,'..',file),'utf8'),start=text.slice(text.indexOf('async function start()'));assert(start.indexOf('primeCurrentFigure();')<start.indexOf('renderArticle();'));assert(start.indexOf('primeCurrentFigure();')<start.indexOf('await restoreReadingState(saved)'));}
});

test('single-column adopts the already requested original instead of starting a second element',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),at=source.indexOf('function waitForInlineImage('),end=source.indexOf('function preloadOtherFigures(',at);
 const requested={dataset:{},complete:true,naturalWidth:300,getAttribute:()=>'/current',addEventListener(){},removeEventListener(){}};let replacement,decoded;
 const placeholder={dataset:{src:'/current'},alt:'current original',replaceWith:image=>{replacement=image;}};
 const ctx={backgroundFigureImages:[requested],setTimeout,clearTimeout,IMAGE_READY_TIMEOUT_MS:100,decodeFigureImage:async image=>{decoded=image;},window:{ReadMedia:{load:image=>assert.equal(image,requested)}}};
 vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);
 let revealed=null;ctx.window.ReadMedia.reveal=image=>revealed=image;assert.equal(await ctx.waitForInlineImage(placeholder),'ready');assert.equal(revealed,requested);assert.equal(replacement,requested);assert.equal(decoded,requested);assert.equal(requested.alt,'current original');
 requested.isConnected=true;requested.id='panel-figure-image';let moved=false;
 const ownInline={dataset:{src:'/current'},complete:true,naturalWidth:300,getAttribute:()=>'/current',addEventListener(){},removeEventListener(){},replaceWith(){moved=true;}};
 ctx.window.ReadMedia.load=image=>assert.equal(image,ownInline);
 assert.equal(await ctx.waitForInlineImage(ownInline),'ready');assert.equal(decoded,ownInline);assert.equal(moved,false);

});


test('figure sequence labels follow the requested image immediately in desktop and single-column modes',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const labelStart=source.indexOf('function updatePanelFigurePosition('),labelEnd=source.indexOf('function commitPanelFigure(',labelStart);
 const showStart=source.indexOf('function showFigure('),showEnd=source.indexOf('function setFigureFillPane(',showStart);
 for(const desktop of [true,false]){
  const nodes=new Map();const node=key=>{if(!nodes.has(key))nodes.set(key,{querySelectorAll:()=>[],dataset:{}});return nodes.get(key);};
  const requested=[];const ctx={$:node,currentLanguage:'zh',currentFigureIndex:0,figureBlocks:Array.from({length:5},(_,i)=>({src:String(i)})),isDesktopLayout:()=>desktop,requestPanelFigure:block=>{requested.push(block.src);return new Promise(()=>{});}};
  vm.createContext(ctx);vm.runInContext(source.slice(labelStart,labelEnd)+source.slice(showStart,showEnd),ctx);
  ctx.showFigure(2);assert.equal(node('.figure-panel-head .rail-kicker').textContent,'原文配图 / 03');assert.equal(node('#figure-position').textContent,'03 / 05');
  ctx.showFigure(4);assert.equal(node('.figure-panel-head .rail-kicker').textContent,'原文配图 / 05');assert.equal(node('#figure-position').textContent,'05 / 05');assert.deepEqual(requested,desktop?['2','4']:[]);
 }
});


test('loading overlays are centered in fixed viewports and no stylesheet can revive the previous panel image',()=>{
 const root=path.join(__dirname,'..'),css=fs.readFileSync(path.join(root,'app.css'),'utf8'),media=fs.readFileSync(path.join(root,'progressive-media.css'),'utf8');
 const status=css.match(/\.figure-image-status\{([^}]*)\}/)[1];
 for(const rule of ['position:absolute','inset:0','align-items:center','justify-content:center'])assert(status.includes(rule));
 assert(css.includes('.figure-stage-wrap{position:relative}'));
 for(const state of ['loading','failed'])assert((css+media).includes(`.figure-stage[data-image-state="${state}"] #panel-figure-image`));
 assert(!/data-has-image="true"[^}]*visibility:visible/.test(css+media));
 assert(!css.includes('.figure-stage[data-has-image="true"] .figure-image-status'));
 for(const file of ['index.html','public-site/read.html']){
  const html=fs.readFileSync(path.join(root,file),'utf8');assert(html.includes('</div></div><div id="panel-figure-status"'));
 }
 const inline=css.match(/\.inline-figure-status\{([^}]*)\}/)[1];for(const rule of ['position:absolute','inset:0','align-items:center','justify-content:center'])assert(inline.includes(rule));
 assert(css.includes('.source-figure .inline-figure-canvas img:not([data-decoded="true"]){visibility:hidden}'));
 assert(css.includes('.inline-figure-viewport:has(img[data-decoded="true"]) .inline-figure-status'));
 const exporter=fs.readFileSync(path.join(root,'export_github_pages.py'),'utf8');assert(exporter.slice(exporter.indexOf('READER_FUNCTIONS = ('),exporter.indexOf('def public_reader_script')).includes('"updatePanelFigurePosition"'));
});

test('both private and exported single-column load handlers wait for decode before revealing and report decode errors',async()=>{
 for(const file of ['app.js','public-site/reader-prelude.js'])for(const failure of [false,true]){
  const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8'),at=source.indexOf('function blockElement('),end=source.indexOf('\nfunction renderArticle(',at);
  let finish,revealed=0,errors=0;const handlers={};const image={addEventListener:(name,fn)=>handlers[name]=fn,dispatchEvent:event=>{assert.equal(event.type,'error');errors++;}};
  const wrap={dataset:{},querySelector:selector=>selector.includes('img')?image:{addEventListener(){}},};
  const pending=new Promise((resolve,reject)=>finish=failure?()=>reject(Error('decode')):resolve);
  const block={id:'synthetic',kind:'figure',src:'synthetic.png',text:'caption'};
  const ctx={document:{createElement:()=>wrap},figureBlocks:[block],figurePage:()=>1,currentLanguage:'zh',figureImageMarkup:()=>'<img>',tr:()=>'',inlineMarkdown:x=>x,READING_TOOLS_ENABLED:false,installDragPan(){},decodeFigureImage:()=>pending,window:{ReadMedia:{reveal(){revealed++;}}},applyInlineFigureScale(){},pendingInlinePositions:null,Event};
  vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);ctx.blockElement(block);assert(wrap.innerHTML.includes('inline-figure-viewport'));const loaded=handlers.load();assert.equal(revealed,0);finish();await loaded;assert.equal(revealed,failure?0:1);assert.equal(errors,failure?1:0);
 }
});
