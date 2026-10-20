/* A shared, dependency-free image queue for navigation and reading. */
(function(global){
  'use strict';
  const idle = callback => global.requestIdleCallback ? requestIdleCallback(callback,{timeout:1800}) : setTimeout(callback,80);
  function reveal(image){
    image.classList.add('media-sharp');
    image.closest('.progressive-media')?.classList.add('media-ready');
  }
  function load(image,priority='auto'){
    if(!image || image.getAttribute('src'))return;
    const host=image.closest('.progressive-media');
    if(image.dataset.preview&&host&&!host.querySelector('.media-preview')){
      const small=new Image();small.className='media-preview';small.alt='';small.setAttribute('aria-hidden','true');small.decoding='async';small.src=image.dataset.preview;host.append(small);
    }
    image.fetchPriority=priority;image.loading='eager';
    image.addEventListener('load',()=>reveal(image),{once:true});
    image.addEventListener('error',()=>{
      if(!host)return;host.classList.add('media-failed');
      if(host.querySelector('.media-error'))return;
      const notice=document.createElement('div');notice.className='media-error';notice.textContent='图片暂时无法载入';notice.setAttribute('role','status');
      const retry=document.createElement('button');retry.type='button';retry.textContent='重试图片';
      retry.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();notice.remove();host.classList.remove('media-failed');image.removeAttribute('src');load(image,'high');});notice.append(retry);host.append(notice);
    },{once:true});
    image.src=image.dataset.src;
    if(image.complete&&image.naturalWidth)reveal(image);
  }
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
