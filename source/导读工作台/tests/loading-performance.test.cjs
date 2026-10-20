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
test('full-resolution image latency never prevents reading from unlocking',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const at=source.indexOf('async function finishReadingPreparation('),end=source.indexOf('\nasync function resumeRemoteProgress(',at);
 const nodes=new Map(),node=selector=>{if(!nodes.has(selector))nodes.set(selector,{hidden:false,inert:true,textContent:'',classList:{remove(){}},querySelector:()=>null});return nodes.get(selector);};
 const picture=deferred();let preloads=0;
 const ctx={$:node,preparationAttempt:0,panelFigureReady:picture.promise,readingPreparationSaved:null,readingPrepared:false,isDesktopLayout:()=>true,CustomEvent:class{},document:{dispatchEvent(){},body:{classList:{remove(){}}}},window:{ReadMedia:{inline(){}}},preloadOtherFigures:()=>preloads++,retryPanelFigure(){}};
 vm.createContext(ctx);vm.runInContext(source.slice(at,end)+';this.finish=finishReadingPreparation;',ctx);
 await ctx.finish();assert.equal(ctx.readingPrepared,true);assert.equal(node('.layout').inert,false);assert.equal(node('#reading-preparation').hidden,true);assert.equal(preloads,0);
 picture.resolve('ready');await Promise.resolve();assert.equal(preloads,1);
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
