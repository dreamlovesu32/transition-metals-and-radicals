// Run the complete member module with an isolated DOM and synthetic server identities.
// Real browser acceptance is performed separately through the supported CUA surface.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/members.js','utf8');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

class Element{
 constructor(tag,text){this.tagName=tag.toUpperCase();this._text=text||'';this.children=[];this.parentElement=null;this.dataset={};this.attributes={};this.listeners={};this.className='';}
 get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
 set textContent(value){this._text=String(value);this.children=[];}
 get isConnected(){return this.tagName==='BODY'||Boolean(this.parentElement?.isConnected);}
 setAttribute(k,v){this.attributes[k]=String(v);}
 append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
 replaceChildren(...nodes){this.children.forEach(n=>n.parentElement=null);this.children=[];this._text='';this.append(...nodes);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}
 matches(selector){if(selector[0]==='.')return this.className.split(' ').includes(selector.slice(1));if(selector.startsWith('[data-'))return Object.hasOwn(this.attributes,selector.slice(1,-1))||Object.hasOwn(this.dataset,selector.slice(6,-1).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()));return this.tagName.toLowerCase()===selector;}
 querySelectorAll(selector){const out=[];for(const child of this.children){if(child.matches(selector))out.push(child);out.push(...child.querySelectorAll(selector));}return out;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
 addEventListener(k,f){(this.listeners[k]??=[]).push(f);}
 async emit(k){for(const f of this.listeners[k]||[])await f({preventDefault(){},target:this});}
 focus(){}
 showModal(){this.open=true;}
 close(){this.open=false;for(const f of this.listeners.close||[])f();}
}
function fixture(surface){
 const identity=defer(),library=defer(),body=new Element('body'),host=new Element('header'),nav=new Element('div');
 host.className=surface==='reader'?'topbar':surface==='catalog'?'catalog-topbar':'member-header';nav.setAttribute('data-member-nav','');host.append(nav);body.append(host);
 let root=null;if(['account','favorites'].includes(surface)){root=new Element('main');root.dataset.memberPage=surface;body.append(root);}
 const document={body,currentScript:{src:'http://navigation.test/member-system/members.js'},activeElement:null,createElement:tag=>new Element(tag),createTextNode:text=>new Element('text',text),querySelector:s=>body.querySelector(s),querySelectorAll:s=>body.querySelectorAll(s),addEventListener(){},dispatchEvent(){}};
 let reloads=0;
 const context={document,URL,URLSearchParams,AbortSignal,structuredClone,setTimeout,clearTimeout,CustomEvent:class{},location:{origin:'http://navigation.test',href:'http://navigation.test/',pathname:surface==='reader'?'/read.html':'/',search:'',reload(){reloads++;}},localStorage:{getItem:()=>'{"role":"admin","user":{"id":"cached","role":"admin"},"favorites":[],"annotations":[]}'},addEventListener(){},requestAnimationFrame:fn=>fn(),fetch:async url=>{
  let data;if(String(url).includes('/reader-context'))data={session:await identity.promise,favorites:[],notes:[],progress:null};
  else if(String(url).endsWith('/session'))data=await identity.promise;
  else if(/\/(notes|favorites)$/.test(String(url))){await library.promise;data={items:[]};}
  else if(String(url).endsWith('catalog.json'))data={articles:[]};
  else throw Error('Unexpected request '+url);
  return {ok:true,status:200,json:async()=>data};
 }};
 context.window=context;vm.createContext(context);vm.runInContext(source,context);
 return {context,members:context.ReadMembers,identity,library,nav,root,body,reloads:()=>reloads};
}
const named=(node,label)=>node.querySelectorAll('a').filter(n=>n.textContent===label);

for(const surface of ['catalog','favorites','account','reader'])test(surface+': delayed admin is restored before private library and survives repeated/late menu mounts',async()=>{
 const h=fixture(surface);assert.equal(named(h.nav,'审稿').length,0);assert.equal(named(h.nav,'登录 / 注册').length,1);
 h.identity.resolve({configured:true,user:{id:'server-admin',email:'reader@example.invalid',role:'admin'},csrfToken:'csrf'});await tick();
 assert.equal(h.members.state.libraryReady,['reader','favorites'].includes(surface));assert.equal(named(h.nav,'审稿').length,1);assert.match(named(h.nav,'审稿')[0].href,/member-system\/admin.html$/);
 await named(h.nav,'我的账户')[0].emit('click');assert.equal(named(h.body.querySelector('dialog'),'稿件审核').length,1);
 if(surface==='account')assert.equal(named(h.root,'稿件审核').length,1);
 const late=new Element('div');late.setAttribute('data-member-nav','');h.body.append(late);h.members.mountNavigation(late);h.members.mountNavigation(late);
 assert.equal(late.querySelectorAll('.member-navigation').length,1);assert.equal(named(late,'审稿').length,1);
 h.library.resolve();await h.members.ready;
 await h.members.checkSession(async()=>({user:{id:'server-admin',role:'user'},csrfToken:'new'}));
 assert.equal(h.reloads(),1);assert.equal(h.body.querySelectorAll('[data-member-admin]').length,0);assert.equal(named(h.nav,'登录 / 注册').length,1);assert.equal(named(late,'登录 / 注册').length,1);
});
for(const role of [null,'user'])for(const surface of ['catalog','favorites','account','reader'])test(surface+': '+(role||'guest')+' cached claims never grant review entry',async()=>{
 const h=fixture(surface);h.identity.resolve({configured:true,user:role?{id:'server-reader',role,email:'reader@example.invalid'}:null,csrfToken:'csrf'});h.library.resolve();await h.members.ready;
 assert.equal(h.body.querySelectorAll('[data-member-admin]').length,0);const label=role?'我的账户':'登录 / 注册';assert.equal(named(h.nav,label).length,1);
 await named(h.nav,label)[0].emit('click');assert.ok(h.body.querySelector('dialog')?.open);assert.equal(h.body.querySelectorAll('[data-member-admin]').length,0);
});
test('identity request failure never promotes browser cache and still renders navigation',async()=>{const h=fixture('catalog');h.identity.reject(Error('offline'));await h.members.ready;assert.equal(h.members.state.authStatus,'error');assert.equal(h.members.state.user,null);assert.equal(h.body.querySelectorAll('[data-member-admin]').length,0);assert.equal(named(h.nav,'登录 / 注册').length,1);});
test('session refresh updates all mounted menus and expiry removes stale administrator links',async()=>{const h=fixture('catalog');h.identity.resolve({configured:true,user:null,csrfToken:'guest'});await h.members.ready;await h.members.refreshAuthSession(async()=>({configured:true,user:{id:'verified',role:'admin'},csrfToken:'fresh'}));assert.equal(named(h.nav,'审稿').length,1);await h.members.checkSession(async()=>{throw Error('session unavailable');});assert.equal(named(h.nav,'审稿').length,1);await h.members.checkSession(async()=>({user:null}));assert.equal(h.body.querySelectorAll('[data-member-admin]').length,0);assert.equal(named(h.nav,'登录 / 注册').length,1);});
