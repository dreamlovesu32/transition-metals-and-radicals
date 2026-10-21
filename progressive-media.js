/* A shared, dependency-free image queue for navigation and reading. */
(function(global){
  'use strict';
  const idle = callback => global.requestIdleCallback ? requestIdleCallback(callback,{timeout:1800}) : setTimeout(callback,80);
  function reveal(image){
    image.classList.add('media-sharp');
    image.closest('.progressive-media')?.classList.add('media-ready');
  }
  const imageLoads=new WeakMap(),failedImages=new Set();
  function discardLoad(state){clearTimeout(state.timer);state.cleanup?.();failedImages.delete(state);}
  function ownsLoad(state){return imageLoads.get(state.image)===state&&state.image.dataset.src===state.source&&state.image.isConnected;}
  function recoveryNotice(state,message){
    const host=state.image.closest('.progressive-media');if(!host)return;
    host.classList.add('media-failed');let notice=host.querySelector('.media-error');
    if(!notice){notice=document.createElement('div');notice.className='media-error';notice.setAttribute('role','status');const text=document.createElement('span');text.className='media-error-text';notice.append(text);const retry=document.createElement('button');retry.type='button';retry.textContent='重试图片';retry.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(!ownsLoad(state))return;state.blocked=false;state.attempt=0;clearTimeout(state.timer);startImage(state,true);});notice.append(retry);host.append(notice);}
    notice.querySelector('.media-error-text').textContent=message;
  }
  function scheduleRecovery(state,delay){
    if(!ownsLoad(state)){discardLoad(state);return;}failedImages.add(state);clearTimeout(state.timer);
    state.timer=setTimeout(()=>{state.timer=null;void recoverImage(state);},Math.max(1000,delay??Math.min(300000,1000*2**Math.min(state.attempt-1,9))));state.timer?.unref?.();
  }
  async function recoverImage(state){
    if(state.checking||state.loading||state.blocked)return;if(!ownsLoad(state)){discardLoad(state);return;}
    state.checking=true;
    try{
      const response=await global.fetch(state.source,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});
      try{await response.body?.cancel();}catch{}
      if(!ownsLoad(state)){discardLoad(state);return;}
      if(response.ok&&/^image\//i.test(response.headers.get('Content-Type')||'')){startImage(state,true);return;}
      if(response.ok||![408,425,429,502,503,504].includes(response.status)){state.blocked=true;recoveryNotice(state,'图片服务暂时无法完成读取。');return;}
      state.attempt++;scheduleRecovery(state,Math.min(300000,Math.max(0,Number(response.headers.get('Retry-After'))||0)*1000)||undefined);
    }catch{if(ownsLoad(state)){state.attempt++;scheduleRecovery(state);}}
    finally{state.checking=false;}
  }
  function startImage(state,retry=false){
    if(!ownsLoad(state)){discardLoad(state);return;}state.cleanup?.();state.failed=false;state.loading=true;
    const image=state.image,success=()=>{
      if(!ownsLoad(state))return;discardLoad(state);state.attempt=0;state.failed=false;state.loading=false;
      const host=image.closest('.progressive-media');host?.classList.remove('media-failed');host?.querySelector('.media-error')?.remove();reveal(image);
    },failure=()=>{if(!ownsLoad(state))return;state.cleanup?.();state.loading=false;state.failed=true;state.attempt++;recoveryNotice(state,'图片暂时无法载入，正在自动恢复…');scheduleRecovery(state);};
    state.cleanup=()=>{image.removeEventListener('load',success);image.removeEventListener('error',failure);};image.addEventListener('load',success);image.addEventListener('error',failure);
    image.fetchPriority=state.priority;image.loading='eager';
    if(retry){const url=new URL(state.source,global.location.href);url.searchParams.set('read-image-recovery',String(state.attempt));image.src=url.href;}else image.src=state.source;
    if(image.complete&&image.naturalWidth)success();
  }
  function load(image,priority='auto'){
    if(!image)return;const source=image.dataset.src;if(!source)return;let state=imageLoads.get(image);
    if(state?.source!==source){if(state)discardLoad(state);state={image,source,priority,attempt:0,timer:null,blocked:false};imageLoads.set(image,state);}
    state.priority=priority;if(image.getAttribute('src'))return;
    const host=image.closest('.progressive-media');
    if(image.dataset.preview&&host&&!host.querySelector('.media-preview')){
      const small=new Image();small.className='media-preview';small.alt='';small.setAttribute('aria-hidden','true');small.decoding='async';small.src=image.dataset.preview;host.append(small);
    }
    startImage(state);
  }
  const wakeImages=()=>{for(const state of failedImages){if(!ownsLoad(state)){discardLoad(state);continue;}if(!state.blocked&&!state.loading&&!state.checking){clearTimeout(state.timer);void recoverImage(state);}}};global.addEventListener?.('online',wakeImages);global.addEventListener?.('focus',wakeImages);
  function cover(image,article){
    image.dataset.src=article.coverDisplay || article.cover;
    const host=image.parentElement;host.classList.add('progressive-media');
    if(article.coverWidth&&article.coverHeight){image.width=article.coverWidth;image.height=article.coverHeight;}
    if(article.coverPreview){const small=new Image();small.className='media-preview';small.alt='';small.setAttribute('aria-hidden','true');small.decoding='async';small.src=article.coverPreview;host.prepend(small);}
  }
  const prepared=new WeakMap();
  function prepare(track){
    prepared.get(track)?.();
    const images=[...track.querySelectorAll('img[data-src]')];
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries)if(entry.isIntersecting){load(entry.target,'high');observer.unobserve(entry.target);}
    },{root:null,rootMargin:'0px',threshold:.01});
    images.forEach(image=>observer.observe(image));
    let queued=false;
    const warm=()=>{
      if(queued)return;queued=true;
      idle(async()=>{
        queued=false;if(!track.isConnected)return;
        const bounds=track.getBoundingClientRect();
        if(bounds.bottom<0||bounds.top>innerHeight)return;
        // Only the immediately following group, in display order, is warmed.
        const next=images.filter(image=>{const b=image.getBoundingClientRect();return b.left>=bounds.right-1&&b.left<bounds.right+bounds.width;});
        for(const image of next){if(!image.isConnected)break;load(image,'low');await Promise.race([image.decode().catch(()=>{}),new Promise(r=>setTimeout(r,8000))]);}
      });
    };
    track.addEventListener('scroll',warm,{passive:true});warm();
    prepared.set(track,()=>{observer.disconnect();track.removeEventListener('scroll',warm);});
  }
  function inline(root){
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries)if(entry.isIntersecting){load(entry.target,'high');observer.unobserve(entry.target);}
    },{rootMargin:'0px',threshold:.01});
    root.querySelectorAll('img[data-src]').forEach(image=>observer.observe(image));return observer;
  }
  global.ReadMedia={load,cover,prepare,inline,idle,reveal};
})(window);
