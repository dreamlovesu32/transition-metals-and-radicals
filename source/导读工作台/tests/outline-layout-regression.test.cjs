const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),core=fs.readFileSync(path.join(root,'reader-core.js'),'utf8'),chrome=fs.readFileSync(path.join(root,'reader-chrome.js'),'utf8');
function section(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert(a>=0&&b>a);return source.slice(a,b);}
function layoutHarness({headingTop=135,atBottom=false}={}){
 let mode='single';const moves=[],positions={single:{intro:100,p:3500,h:3854.5,after:4300},desktop:{intro:100,p:2318.5,h:2576.3359,after:3000}};
 const ctx={window:{scrollY:3854.5-headingTop,ReadOutlineOpen:true},innerHeight:800,changingLayout:false,restoringReadingState:false,readingPrepared:true,layoutPreference:'auto',paneSide:'right',readingBottomIntent:atBottom,paneRatio:.45,currentFigureIndex:2,figureAuto:true,figureFillPane:false,figureScale:1,documentState:{article:{id:'review'},version_hash:'v'},articleId:()=> 'review',readingSectionId:()=> 'h',readingSectionInset:()=>128,readingMode:()=>mode,localStorage:{setItem(){}},saveReadingState(){},storedReadingState:()=>null,scrollFraction:()=>0,restoreScrollFraction(){},animationFrame:async()=>{},applyPaneRatio(){},applyFigureScale(){},applyAllInlineFigureScales(){},showFigure(){},resetAutoFigureTracking(){},scheduleReadingSave(){},isDesktopLayout:()=>mode==='desktop',applyLayoutPreference(){mode='desktop';},$:()=>({}),document:{documentElement:{scrollHeight:6000},querySelectorAll(selector){if(selector.includes('[data-figure-index]')&&!selector.includes(':not('))return [];return ['intro','p','h','after'].map(id=>({dataset:{blockId:id},getBoundingClientRect:()=>({top:positions[mode][id]-ctx.window.scrollY}),querySelector:()=>id==='h'?{getBoundingClientRect:()=>({top:positions[mode][id]-ctx.window.scrollY})}:null}));}}};
 ctx.documentState.blocks=['intro','p','h','after'].map(id=>({id,kind:id==='h'?'heading':'paragraph'}));
 ctx.document.querySelector=selector=>({getBoundingClientRect:()=>({bottom:selector==='.reader-toolbar'?112:60})});
 ctx.syncFigureToScroll=()=>{};ctx.window.scrollTo=({top})=>{moves.push(top);ctx.window.scrollY=top;};vm.createContext(ctx);
 vm.runInContext(section(core,'function readingSectionInset()','function resumeHeading('),ctx);
 vm.runInContext(section(core,'function readingAnchor()','function saveReadingState()')+section(core,'function restoreArticleScroll(','async function restoreReadingState(')+section(core,'async function reflowReaderLayout(','function readingMode()'),ctx);
 return {ctx,moves,positions,get mode(){return mode;}};
}
test('outline heading at 135px stays below toolbar when single-column text reflows to double',async()=>{
 const h=layoutHarness();await h.ctx.reflowReaderLayout();assert.equal(h.mode,'desktop');assert.equal(h.positions.desktop.h-h.ctx.window.scrollY,135);assert.equal(h.ctx.captureReadingState().scroll.blockId,'h');assert.equal(h.ctx.captureReadingState().sectionId,'h','saved resume section must match the visible outline heading');
});
test('manual scrolling within a paragraph keeps its exact block offset during layout change',async()=>{
 const h=layoutHarness({headingTop:400});const before=h.ctx.readingAnchor();assert.equal(before.blockId,'p');await h.ctx.reflowReaderLayout();assert.equal(h.positions.desktop.p-h.ctx.window.scrollY,-before.offset);
});
test('layout reflow keeps explicit bottom intent at the new document bottom',async()=>{
 const h=layoutHarness({atBottom:true});await h.ctx.reflowReaderLayout();assert.equal(h.ctx.window.scrollY,5200);
});
for(const opening of [false,true])test(`outline ${opening?'open':'close'} captures geometry before its CSS width changes`,async()=>{
 let outlineClass=!opening,captured=null;const classes={add(name){if(name==='reader-outline-open')outlineClass=true;},remove(name){if(name==='reader-outline-open')outlineClass=false;},toggle(name,on){if(name==='reader-outline-open')outlineClass=on;}};
 const panel={hidden:opening,dataset:{outline:'true'},classList:{contains:()=>false},querySelectorAll:()=>[],querySelector:()=>({focus(){}})},trigger={setAttribute(){}};
 const ctx={window:{ReadOutlineOpen:!opening,innerWidth:1265},openPanel:opening?null:panel,returnFocus:null,backdrop:{hidden:false},document:{body:{classList:classes,dataset:{readerLayout:opening?'desktop':'single'}},querySelectorAll:()=>[]},layoutPreference:'auto',paneSide:'right',$:()=>null};
 ctx.reflowReaderLayout=async()=>{captured=outlineClass;ctx.applyLayoutPreference();};vm.createContext(ctx);
 vm.runInContext(section(core,'function isDesktopLayout()','function loadLayoutPreference()')+section(chrome,'  async function closePanel()','  function panel('),ctx);
 if(opening)await ctx.showPanel(panel,trigger);else await ctx.closePanel();
 assert.equal(captured,!opening,'the snapshot must see the unchanged old width');assert.equal(outlineClass,opening);assert.equal(ctx.document.body.dataset.readerLayout,opening?'single':'desktop');
});
