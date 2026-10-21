/* Independent controls: never nest actions inside the article link. */
(function(global){
  'use strict';
  function updatedToday(value,now=new Date()){
    if(typeof value!=='string'||!/[T ].*(?:Z|[+-]\d{2}:\d{2})$/.test(value))return false;
    const date=new Date(value);if(!Number.isFinite(date.getTime()))return false;
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
    return day.format(date)===day.format(now);
  }
  function sourceUrl(article){
    if(typeof article.sourceUrl==='string'){try{const url=new URL(article.sourceUrl);if(url.protocol==='https:')return url.href;}catch{}}
    const doi=String(article.doi||'').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'');
    return /^10\.\d{4,9}\/\S+$/.test(doi)?'https://doi.org/'+doi.split('/').map(encodeURIComponent).join('/'):null;
  }
  const svg=(path)=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  const star='m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z';
  const arrow='M7 17 18 6M7 6h11v11';
  function failureMessage(error){
    if(typeof error.publicMessage==='string')return error.publicMessage;
    if(error.kind==='identity'||error.status===401)return '登录状态已变化，本次收藏未继续。';
    if(error.status===403)return '当前账号没有完成此收藏操作的权限。';
    if(error.kind==='resource')return '收藏工具尚未准备好。';
    return '收藏尚未完成，当前状态已保留。';
  }
  function report(error){
    global.ReadToast?.show({key:'card-favorite',kind:'error',message:failureMessage(error)});
    const detail={scope:'favorite',kind:error.kind||(error.status?'http':'application'),status:error.status||0,code:error.code||'unclassified'};
    if(global.CustomEvent&&typeof document!=='undefined'&&typeof document.dispatchEvent==='function')document.dispatchEvent(new global.CustomEvent('read-operation-error',{detail}));
    if(detail.kind!=='network')global.console?.error?.('Favorite operation failed',detail);
  }
  function refresh(){
    if(typeof document==='undefined')return;
    const state=global.ReadMembers?.state;
    document.querySelectorAll('[data-favorite-article]').forEach(button=>{
      const active=Boolean(state?.library?.favorites.includes(button.dataset.favoriteArticle));
      const was=button.getAttribute('aria-pressed')==='true';button.setAttribute('aria-pressed',String(active));
      button.setAttribute('aria-label',active?'取消收藏':'收藏文章');button.title=active?'取消收藏':'收藏文章';
      if(was&&!active)button.favoriteRemoved?.();
    });
  }
  function mount(card,article,{onRemoved}={}){
    const actions=document.createElement('div');actions.className='card-actions';
    const favorite=document.createElement('button');favorite.type='button';favorite.className='card-favorite';favorite.dataset.favoriteArticle=article.id;
    favorite.setAttribute('aria-pressed','false');favorite.setAttribute('aria-label','收藏文章');favorite.title='收藏文章';favorite.innerHTML=svg(star);favorite.favoriteRemoved=onRemoved;
    if(article.public===false){favorite.disabled=true;favorite.title='未公开稿件不加入收藏';favorite.setAttribute('aria-label',favorite.title);}
    favorite.addEventListener('click',async event=>{
      event.preventDefault();event.stopPropagation();if(favorite.disabled)return;favorite.disabled=true;favorite.setAttribute('aria-busy','true');
      card.querySelector('.card-action-error')?.remove();
      try{
        if(!global.ReadMembers&&document.readyState!=='complete')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
        const members=global.ReadMembers;if(!members)throw Object.assign(Error('收藏工具尚未准备好。'),{code:'member_script_unavailable',kind:'resource'});
        await members.ready;
        const epoch=members.state?.epoch,uid=members.state?.user?.id||null;
        // Confirm the initial library before the one non-replayable toggle. Its
        // owner handles durable pending writes and automatic outbox recovery.
        if(members.ensureLibraryReady)await members.ensureLibraryReady();
        if(global.ReadMembers!==members||members.state?.epoch!==epoch||(members.state?.user?.id||null)!==uid)throw Object.assign(Error('登录状态已变化，本次收藏未继续。'),{kind:'identity',code:'identity_changed'});
        await members.toggleFavorite(article.id);refresh();
      }catch(error){report(error);refresh();}
      finally{favorite.disabled=favorite.dataset.public==='false';favorite.removeAttribute('aria-busy');}
    });
    actions.append(favorite);
    const original=sourceUrl(article);
    if(original){const link=document.createElement('a');link.className='card-source-link';link.href=original;link.target='_blank';link.rel='noopener';link.title='查看原文';link.setAttribute('aria-label','查看原文');link.innerHTML=svg(arrow);link.addEventListener('click',event=>event.stopPropagation());actions.append(link);}
    (card.querySelector('.card-meta-row')||card).append(actions);
    update(card,article);
    return favorite;
  }
  function update(card,article){
    const favorite=card.querySelector('.card-favorite');
    if(favorite){favorite.dataset.public=String(article.public!==false);if(favorite.getAttribute('aria-busy')!=='true')favorite.disabled=article.public===false;}
    const actions=card.querySelector('.card-actions'),url=sourceUrl(article);
    let source=card.querySelector('.card-source-link');
    if(!source&&url&&actions){source=document.createElement('a');source.className='card-source-link';source.target='_blank';source.rel='noopener';source.title='查看原文';source.setAttribute('aria-label','查看原文');source.innerHTML=svg(arrow);source.addEventListener('click',event=>event.stopPropagation());actions.append(source);}
    if(source){source.hidden=!url;if(url)source.href=url;}
    const meta=card.querySelector('.catalog-meta')||card.querySelector('.card-meta-text');
    if(!meta)return;
    let date=meta.querySelector('.card-date');
    if(!date){
      const value=meta.children[1];if(!value)return;
      date=document.createElement('span');date.className='card-date';
      value.replaceWith(date);date.append(value);
    }
    let badge=date.querySelector('.card-new');const show=updatedToday(article.updatedAt);
    if(show&&!badge){badge=document.createElement('span');badge.className='card-new';badge.textContent='New!';badge.setAttribute('aria-label','北京时间今天更新');date.append(badge);}
    if(!show&&badge)badge.remove();
  }
  let catalogRows=null;
  function hydrate(articles){
    if(Array.isArray(articles))catalogRows=articles;
    refresh();const members=global.ReadMembers;if(!members){if(document.readyState!=='complete')document.addEventListener('DOMContentLoaded',hydrate,{once:true});return;}
    members.ready?.then(()=>{
      if(catalogRows)members.setPublicCatalog(catalogRows);
      refresh();
      if(members.state.user&&!members.state.presentationFavoritesKnown&&!members.state.libraryReady)members.ensureLibraryReady().then(refresh).catch(report);
    }).catch(report);
  }
  const api={mount,update,refresh,hydrate,sourceUrl,updatedToday};
  if(typeof module!=='undefined')module.exports=api;
  global.ReadCardActions=api;
  if(typeof document!=='undefined'){document.addEventListener('read-members-change',refresh);document.addEventListener('read-members-sync',refresh);document.addEventListener('read-members-ready',()=>hydrate());}
})(typeof window==='undefined'?globalThis:window);
