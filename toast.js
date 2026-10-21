/* One non-modal status card. Messages never move content or claim a save themselves. */
(function(global){
 'use strict';
 const durations={success:3000,resume:8000,pending:5000,error:8000,info:4000};
 function createToastClock(env,expire){
  let timer=null,remaining=0,started=0;const pauses=new Set();
  const now=()=>env.now?env.now():Date.now();
  function stop(){if(timer!==null){env.clearTimeout(timer);timer=null;remaining=Math.max(0,remaining-(now()-started));}}
  function run(){if(timer!==null||pauses.size||remaining<=0)return;started=now();timer=env.setTimeout(()=>{timer=null;remaining=0;expire();},remaining);}
  return {reset(ms){stop();remaining=ms;run();},pause(reason){stop();pauses.add(reason);},resume(reason){pauses.delete(reason);run();},cancel(){stop();remaining=0;pauses.clear();},get remaining(){return timer===null?remaining:Math.max(0,remaining-(now()-started));}};
 }
 function createToastManager(env){
  const doc=env.document;let host=null,current=null,currentAction=null,message,action,closeButton;
  const clock=createToastClock(env,()=>dismiss());
  function position(){
   if(!host||host.hidden)return;let bottom=16;
   const width=host.getBoundingClientRect?.().width||360;
   for(const node of doc.querySelectorAll?.('.member-review-editor:not([hidden]),[data-toast-obstacle]:not([hidden])')||[]){
    const rect=node.getBoundingClientRect();if(rect.width&&rect.height&&rect.left<(env.innerWidth||1024)-16&&rect.right>(env.innerWidth||1024)-width-24&&rect.bottom>(env.innerHeight||800)-300)bottom=Math.max(bottom,(env.innerHeight||800)-rect.top+12);
   }
   host.style.setProperty('--read-toast-obstacle',Math.max(16,Math.min(bottom,(env.innerHeight||800)-150))+'px');
  }
  function ensure(){
   if(host)return;host=doc.createElement('section');host.className='read-toast';host.hidden=true;host.setAttribute('aria-atomic','true');host.setAttribute('aria-live','polite');host.setAttribute('role','status');
   const content=doc.createElement('div');content.className='read-toast-content';message=doc.createElement('p');message.className='read-toast-message';action=doc.createElement('button');action.type='button';action.className='read-toast-action';action.hidden=true;
   action.addEventListener('click',async()=>{if(!current||action.disabled)return;const item=current,token={};currentAction=token;action.disabled=true;clock.pause('action');try{await item.action?.onClick?.();if(current===item&&currentAction===token)dismiss();}catch(error){if(current===item&&currentAction===token)(env.console?.warn?.('Read action diagnostic',{category:'application',code:'toast_action_failed'}),show({key:item.key,kind:'info',message:'内容仍保留在当前页面。'}));}finally{if(current===item&&currentAction===token){currentAction=null;action.disabled=false;clock.resume('action');}}});
   closeButton=doc.createElement('button');closeButton.type='button';closeButton.className='read-toast-close';closeButton.setAttribute('aria-label','关闭提示');closeButton.textContent='×';closeButton.addEventListener('click',dismiss);content.append(message,action);host.append(content,closeButton);doc.body.append(host);
   host.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')clock.pause('hover');});host.addEventListener('pointerleave',()=>clock.resume('hover'));
   host.addEventListener('focusin',()=>clock.pause('focus'));host.addEventListener('focusout',e=>{if(!host.contains(e.relatedTarget))clock.resume('focus');});
   host.addEventListener('pointerdown',e=>{if(e.pointerType==='touch')clock.pause('touch');});doc.addEventListener('pointerup',()=>clock.resume('touch'));doc.addEventListener('pointercancel',()=>clock.resume('touch'));
   env.addEventListener?.('resize',position);if(env.MutationObserver)new env.MutationObserver(position).observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class']});
  }
  function dismiss(){clock.cancel();if(host)host.hidden=true;current=null;currentAction=null;}
  function show(value){
   const item=typeof value==='string'?{message:value}:value;if(!item||typeof item.message!=='string'||!item.message.trim())throw Error('Toast message is required');
   ensure();const kind=Object.hasOwn(durations,item.kind)?item.kind:'info',key=item.key||kind;
   currentAction=null;clock.resume('action');current={...item,key,kind};host.dataset.kind=kind;host.dataset.key=key;message.textContent=item.message;action.textContent=item.action?.label||'';action.hidden=!item.action?.onClick;action.disabled=false;host.hidden=false;
   clock.reset(Number.isFinite(item.duration)&&item.duration>=0?item.duration:(item.action&&kind!=='error'?8000:durations[kind]));position();
   return {close(){if(current?.key===key)dismiss();},update(next){if(current?.key===key)return show({...item,...next,key});}};
  }
  return {show,close:dismiss,get current(){return current;},get element(){return host;}};
 }
 let singleton;
 const api={durations,createToastClock,createToastManager,show(value){if(!global.document)return {close(){},update(){}};singleton||=createToastManager(global);return singleton.show(value);},close(){singleton?.close();}};
 global.ReadToast=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
