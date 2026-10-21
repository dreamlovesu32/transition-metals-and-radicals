const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
exports.create=function({count=39,review=false,wraps=[]}={}){
 const source=fs.readFileSync(path.join(__dirname,'../reader-core.js'),'utf8');
 const requests=[],decoded=[],cleared=[],timers=new Map();let timerId=0,active=0,maxActive=0;
 class Image{
  constructor(){this.dataset={};this.listeners={};this.attrs={};this.complete=false;this.naturalWidth=0;this.isConnected=false;}
  getAttribute(k){return this.attrs[k]||null;}
  removeAttribute(k){delete this.attrs[k];if(k==='src'){cleared.push(this);if(!this.completed){this.completed=true;active--;}}}
  addEventListener(k,fn){(this.listeners[k]??=new Set()).add(fn);}
  removeEventListener(k,fn){this.listeners[k]?.delete(fn);}
  set src(value){this.attrs.src=value;requests.push({url:value,image:this});active++;maxActive=Math.max(maxActive,active);}
  get src(){return this.attrs.src;}
 }
 const ctx={requestPanelFigure:()=>{},Image,documentState:{version_hash:'fixture'},figureBlocks:Array.from({length:count},(_,i)=>({id:'f'+i,src:'figure-'+i})),currentFigureIndex:0,backgroundFigureImages:[],figurePreloadActive:false,reviewMode:review,reviewIdentity:{uid:'admin',epoch:1},assertReviewIdentity(){if(ctx.reviewIdentity.epoch!==1)throw Error('expired');},
  isDesktopLayout:()=>true,$:()=>({dataset:{imageState:'ready'}}),document:{querySelectorAll:()=>wraps},window:{ReadMedia:{reveal(image){image.revealed=true;}}},applyInlineFigureScale(){},articleAsset:x=>x,IMAGE_READY_TIMEOUT_MS:12000,
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},async decodeFigureImage(image){if(image.dataset.decoded==='true')return;decoded.push(image);image.dataset.decoded='true';}
 };
 ctx.window.ReadMedia.load=image=>{if(!image.getAttribute('src'))image.src=image.dataset.src;};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function waitForInlineImage('),source.indexOf('function preloadOtherFigures()'))+source.slice(source.indexOf('function preloadOtherFigures()'),source.indexOf('\nfunction showPreparationFailure')),ctx);
 async function complete(image,error=false){if(!image.completed){image.completed=true;active--;image.complete=true;image.naturalWidth=error?0:100;}for(const fn of [...(image.listeners[error?'error':'load']||[])])fn();await Promise.resolve();await Promise.resolve();}
 function runTimer(timeout=false){const entry=[...timers].find(([,x])=>timeout?x.ms===12000:x.ms<12000);if(!entry)return false;timers.delete(entry[0]);entry[1].fn();return true;}
 async function flush(){for(let i=0;i<count*5;i++){const pending=requests.find(r=>!r.image.completed);if(pending)await complete(pending.image);else if(!runTimer())break;await Promise.resolve();}}
 return {ctx,Image,requests,decoded,cleared,timers,complete,runTimer,flush,get maxActive(){return maxActive;}};
};
