const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../reader-core.js'),'utf8');
function harness(){
 const listeners={},nodes=new Map(),events=[],timers=new Map(),image={complete:false,naturalWidth:0},wrap={dataset:{figureIndex:'0'},querySelector:()=>image};let result='error',timerId=0;
 const classes=new Set(['reader-preparing']);const node=s=>{if(!nodes.has(s))nodes.set(s,{hidden:false,inert:true,textContent:''});return nodes.get(s);};
 const ctx={$:node,documentState:{article:{}},readingPrepared:false,readingPreparationSaved:null,preparationAttempt:0,currentFigureIndex:0,reviewMode:false,CustomEvent:class{constructor(type){this.type=type;}},document:{body:{classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}},addEventListener:(type,fn)=>listeners[type]=fn,dispatchEvent:event=>events.push(event.type)},window:{ReadMedia:{inline(){},reveal(){}}},isDesktopLayout:()=>false,currentInlineFigure:()=>wrap,waitForInlineImage:async()=>result,applyInlineFigureScale(){},preloadOtherFigures(){},assertReviewIdentity(){throw Error('expired');}};
 ctx.setTimeout=(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;};ctx.clearTimeout=id=>timers.delete(id);
 vm.createContext(ctx);const start=source.indexOf('async function recoverReadingPreparationImage('),fallback=source.indexOf('function showPreparationFailure('),end=source.indexOf('// Resume uses stable section IDs');vm.runInContext(source.slice(start<0?fallback:start,end),ctx);
 return {ctx,listeners,image,events,classes,node,timers,ready(){result='ready';image.complete=true;image.naturalWidth=640;}};
}
test('a recovered current inline image automatically releases preparation and the deferred member gate exactly once',async()=>{
 const h=harness();await h.ctx.finishReadingPreparation();assert(h.classes.has('reader-preparing'));assert.equal(typeof h.listeners.load,'function','failed preparation must watch the actual recovered image');
 assert.equal(h.node('#reading-preparation-retry').hidden,true);assert.equal(h.node('#reading-preparation-message').textContent,'正在准备阅读…');assert.equal([...h.timers.values()][0].ms,8000);
 h.ready();await h.listeners.load({target:{complete:true,naturalWidth:640}});assert.equal(h.ctx.readingPrepared,false,'another image cannot unlock this reader');
 await h.listeners.load({target:h.image});assert.equal(h.ctx.readingPrepared,true);assert.equal(h.ctx.window.ReadContentReady,true);assert.equal(h.node('#reading-preparation').hidden,true);assert.deepEqual(h.events,['read-content-ready']);assert.equal(h.timers.size,0);
 await h.listeners.load({target:h.image});assert.deepEqual(h.events,['read-content-ready'],'later load events cannot repeat account/tool mounting');
});
test('a persistent image delay offers text after eight seconds without prematurely telling the reader to retry',async()=>{const h=harness();await h.ctx.finishReadingPreparation();const timer=[...h.timers.values()][0];assert.equal(h.node('#reading-preparation-continue').hidden,true);timer.fn();assert.equal(h.node('#reading-preparation-message').textContent,'正文已就绪，可先阅读正文。');assert.equal(h.node('#reading-preparation-continue').hidden,false);});
test('an obsolete document, superseded attempt or expired private identity cannot be revealed by a late image recovery',async()=>{
 for(const change of ['document','attempt','identity']){const h=harness();await h.ctx.finishReadingPreparation();h.ready();if(change==='document')h.ctx.documentState={article:{id:'new'}};else if(change==='attempt')h.ctx.preparationAttempt++;else h.ctx.reviewMode=true;assert.equal(typeof h.listeners.load,'function');await h.listeners.load({target:h.image});assert.equal(h.ctx.readingPrepared,false);assert.equal(h.events.length,0);}
});
