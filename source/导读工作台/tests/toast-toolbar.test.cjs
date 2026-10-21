const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const toast=require('../toast.js');
function fakeClock(){let time=0,id=0;const jobs=new Map();return {now:()=>time,setTimeout(fn,ms){const key=++id;jobs.set(key,{at:time+ms,fn});return key;},clearTimeout(key){jobs.delete(key);},advance(ms){const end=time+ms;for(;;){const next=[...jobs].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;time=next[1].at;jobs.delete(next[0]);next[1].fn();}time=end;},get jobs(){return jobs.size;}};}
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.handlers={};this.dataset={};this.attrs={};this.hidden=false;this.disabled=false;this.style={setProperty:(k,v)=>this.style[k]=v};}
 append(...items){this.children.push(...items);}
 setAttribute(k,v){this.attrs[k]=v;}
 addEventListener(k,fn){(this.handlers[k]||=[]).push(fn);}
 fire(type,event={}){return Promise.all((this.handlers[type]||[]).map(fn=>fn(event)));}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 getBoundingClientRect(){return {width:360};}
 focus(){throw Error('Toast must not focus itself');}
}
function harness(){const clock=fakeClock(),body=new Element('body'),handlers={},blockers=[];const env={...clock,now:clock.now,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,innerWidth:1000,innerHeight:800,document:{body,createElement:tag=>new Element(tag),addEventListener:(k,fn)=>handlers[k]=fn,querySelectorAll:()=>blockers},addEventListener(){}};return {clock,body,handlers,blockers,manager:toast.createToastManager(env)};}

test('toast timer pauses without losing remaining time and cancellation clears old pointer/focus reasons',()=>{const env=fakeClock();let expired=0;const timer=toast.createToastClock(env,()=>expired++);timer.reset(3000);env.advance(1000);timer.pause('hover');assert.equal(timer.remaining,2000);env.advance(10000);assert.equal(expired,0);timer.pause('focus');timer.resume('hover');env.advance(5000);assert.equal(expired,0);timer.resume('focus');env.advance(1999);assert.equal(expired,0);env.advance(1);assert.equal(expired,1);timer.reset(1000);timer.pause('touch');timer.cancel();timer.reset(500);env.advance(500);assert.equal(expired,2);});

test('one toast card merges updates, escapes text by construction, and uses success/resume/pending durations',()=>{const h=harness();const first=h.manager.show({kind:'success',key:'save',message:'<script>not markup</script>'});assert.equal(h.body.children.length,1);assert.equal(h.manager.element.children[0].children[0].textContent,'<script>not markup</script>');h.clock.advance(2999);assert.equal(h.manager.element.hidden,false);first.update({message:'Saved once'});assert.equal(h.body.children.length,1);h.clock.advance(3000);assert.equal(h.manager.element.hidden,true);h.manager.show({kind:'resume',message:'Last chapter',action:{label:'Continue',onClick(){}}});h.clock.advance(7999);assert.equal(h.manager.element.hidden,false);h.clock.advance(1);assert.equal(h.manager.element.hidden,true);h.manager.show({kind:'pending',message:'Saved locally; awaiting sync'});h.clock.advance(5000);assert.equal(h.manager.element.hidden,true);h.manager.show({kind:'error',message:'Still unsaved'});h.clock.advance(7999);assert.equal(h.manager.element.hidden,false);h.manager.element.children[1].fire('click');assert.equal(h.manager.element.hidden,true);});

test('hover, keyboard focus and touch each pause dismissal; hidden close never steals focus',async()=>{const h=harness();h.manager.show({kind:'success',message:'Saved'});const card=h.manager.element;h.clock.advance(1000);await card.fire('pointerenter',{pointerType:'mouse'});h.clock.advance(10000);assert.equal(card.hidden,false);await card.fire('focusin');await card.fire('pointerleave');h.clock.advance(10000);assert.equal(card.hidden,false);await card.fire('focusout',{relatedTarget:null});h.clock.advance(1000);await card.fire('pointerdown',{pointerType:'touch'});h.clock.advance(10000);assert.equal(card.hidden,false);h.handlers.pointerup();h.clock.advance(999);assert.equal(card.hidden,false);h.clock.advance(1);assert.equal(card.hidden,true);});

test('resume action is explicit, single-flight, and failed actions retain a visible error',async()=>{const h=harness();let calls=0,finish;h.manager.show({kind:'resume',message:'Chapter 2',action:{label:'Continue',onClick(){calls++;return new Promise(resolve=>finish=resolve);}}});assert.equal(calls,0);const action=h.manager.element.children[0].children[1],first=action.fire('click');await action.fire('click');assert.equal(calls,1);h.clock.advance(30000);assert.equal(h.manager.element.hidden,false);finish();await first;assert.equal(h.manager.element.hidden,true);h.manager.show({message:'Retry',action:{label:'Retry',onClick(){throw Error('Not saved');}}});await action.fire('click');assert.equal(h.manager.current.kind,'error');assert.equal(h.manager.current.message,'Not saved');h.clock.advance(7999);assert.equal(h.manager.element.hidden,false);h.clock.advance(1);assert.equal(h.manager.element.hidden,true);});

test('toast sits above an overlapping fixed annotation editor and the stylesheet reserves mobile safe areas',()=>{const h=harness();h.blockers.push({getBoundingClientRect:()=>({left:650,right:990,top:520,bottom:790,width:340,height:270})});h.manager.show({message:'Status'});assert.equal(h.manager.element.style['--read-toast-obstacle'],'292px');const css=fs.readFileSync(path.join(__dirname,'../toast.css'),'utf8');assert(css.includes('position:fixed'));assert(css.includes('env(safe-area-inset-bottom)'));assert(css.includes('calc(100vw - 32px)'));assert(css.includes('font:14px/1.65'));});

test('reading record reopens only its validated callback and never runs it on presentation',()=>{const source=fs.readFileSync(path.join(__dirname,'../reader-chrome.js'),'utf8'),at=source.indexOf('  function openResume()'),end=source.indexOf('  const resumeButton=',at);let shown,calls=0;const ctx={resumeOffer:{key:'verified-v2',caption:'Last read chapter',label:'Chapter 2',onResume:()=>calls++},resumeNotice:null,ReadToast:{show:value=>{shown=value;return {close(){}};}}};vm.createContext(ctx);vm.runInContext(source.slice(at,end),ctx);ctx.openResume();assert.equal(calls,0);assert.equal(shown.action.label,'继续阅读 →');shown.action.onClick();assert.equal(calls,1);ctx.resumeOffer=null;shown=null;ctx.openResume();assert.equal(shown,null);});

test('toolbar keeps adjacent articles beside global navigation, puts mobile extras in one menu, and pen cursor excludes touch and links',()=>{const source=fs.readFileSync(path.join(__dirname,'../reader-chrome.js'),'utf8'),css=fs.readFileSync(path.join(__dirname,'../reader-chrome.css'),'utf8');assert(source.includes("catalogGroup.append(dress(q('#'+id),key,label))"));assert(source.includes('moreBody.append(resumeButton,jumps,actions)'));assert(source.includes('resumeButton.disabled=true'));assert(source.includes("more.open=false;if(annotationButton?.getAttribute('aria-pressed')==='true')annotationButton.click()"));assert(css.includes('@media(hover:hover) and (pointer:fine)'));assert(css.includes('body.read-highlighter-on #article :is(a,a *'));assert(css.includes('.block:not([data-figure-index])'));assert(!css.includes('.block:not(.figure)'));assert(css.includes('.reader-jump-button .reader-tool-label{display:inline'));assert(css.includes("fill='%23f3df83'"));assert(css.includes('.reader-tool[data-control-label="荧光笔"][aria-pressed=true]{background:#eaf2fa!important'));assert(css.includes('.reader-tool-label{display:none}'));});

test('an obsolete async action cannot replace, unlock, dismiss, or resume the timer of a newer action',async()=>{
 for(const obsoleteFails of [true,false]){
  const h=harness();let endA,endB;
  h.manager.show({key:'account-A',message:'A',action:{label:'Continue A',onClick:()=>new Promise((resolve,reject)=>endA=obsoleteFails?()=>reject(Error('Old A failed')):resolve)}});
  const action=h.manager.element.children[0].children[1],jobA=action.fire('click');
  h.manager.show({key:'account-B',message:'B',action:{label:'Continue B',onClick:()=>new Promise(resolve=>endB=resolve)}});
  const jobB=action.fire('click');assert.equal(action.disabled,true);endA();await jobA;
  assert.equal(h.manager.current.key,'account-B');assert.equal(h.manager.current.message,'B');assert.equal(action.disabled,true);
  h.clock.advance(30000);assert.equal(h.manager.element.hidden,false,'B action still owns the paused timer');
  endB();await jobB;assert.equal(h.manager.element.hidden,true);
 }
});

test('replacing a pending action starts the new card countdown even if the obsolete action never finishes',async()=>{
 const h=harness();let endA;h.manager.show({key:'A',message:'A',action:{label:'Wait',onClick:()=>new Promise(resolve=>endA=resolve)}});const action=h.manager.element.children[0].children[1],jobA=action.fire('click');
 h.manager.show({key:'B',kind:'success',message:'B saved'});h.clock.advance(2999);assert.equal(h.manager.element.hidden,false);h.clock.advance(1);assert.equal(h.manager.element.hidden,true);endA();await jobA;assert.equal(h.manager.current,null);
});
