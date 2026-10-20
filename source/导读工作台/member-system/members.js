/* Authentication is server-owned. This module never persists an identity or password. */
(function (global) {
  'use strict';
  const KEY = 'read-guest-library-v1';
  const staticMode=locationIsStatic();
  function locationIsStatic(){return typeof location!=='undefined'&&(location.pathname.endsWith('.html')||location.pathname.includes('/member-system/'));}
  function pageUrl(name){return new URL(name,document.currentScript?.src||new URL('/member-system/members.js',location.origin)).href;}
  const scriptRoot=typeof document!=='undefined' ? new URL('../',document.currentScript?.src||new URL('/member-system/members.js',location.origin)):null;
  function readUrl(id){return staticMode?new URL('read.html?article='+encodeURIComponent(id),scriptRoot).href:'/read?article='+encodeURIComponent(id);}
  function homeUrl(){return staticMode?new URL('index.html',scriptRoot).href:'/';}
  function memberUrl(page){return new URL('member-system/'+page+'.html',scriptRoot).href;}
  const state = {epoch:0,loaded:false,authStatus:'loading',libraryReady:false,configured:false,user:null,csrfToken:'',library:{favorites:[],annotations:[]},catalog:[]};
  const el = (tag,text,cls) => {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  function normalizeLibrary(input) {
    return {favorites:[...new Set((input?.favorites||[]).filter(x=>typeof x==='string'))],annotations:(input?.annotations||[]).filter(x=>x&&typeof x.id==='string'&&typeof x.articleId==='string'&&typeof x.quote==='string').map(x=>({...x}))};
  }
  function mergeLibraries(a,b) {a=normalizeLibrary(a);b=normalizeLibrary(b);const key=x=>x.clientId||x.id;const map=new Map(a.annotations.map(x=>[key(x),x]));for(const x of b.annotations){const old=map.get(key(x));if(!old||String(x.updatedAt)>String(old.updatedAt))map.set(key(x),x);}return {favorites:[...new Set([...a.favorites,...b.favorites])],annotations:[...map.values()]};}
  function presentationAnchor(text,legacy,start,end,quote){
    if(typeof legacy!=='string'||legacy.slice(start,end)!==quote)return null;
    const offsets=[0];let at=0;
    for(let i=0;i<legacy.length;i++){
      if(legacy[i]===text[at])at++;
      else if(!/[\t \u00a0\u3000]/u.test(legacy[i]))return null;
      offsets.push(at);
    }
    if(at!==text.length||offsets[end]<=offsets[start])return null;
    return {start:offsets[start],end:offsets[end]};
  }
  function legacyBlockText(snapshot,blockId){
    const block=snapshot?.blocks?.find(item=>item.id===blockId);
    if(!block||!global.ReadInline)return undefined;
    const node=el('span');node.innerHTML=global.ReadInline.html(block.text,{preserveSpacing:true});return node.textContent;
  }
  function resolveAnchor(anchor,context) {
    if(anchor.articleId!==context.articleId||String(anchor.revision)!==String(context.revision)||anchor.blockId!==context.blockId)return null;
    const text=context.text, start=anchor.offset?.start,end=anchor.offset?.end;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start)return null;
    const matches=value=>value.slice(start,end)===anchor.quote&&(!anchor.prefix||value.slice(Math.max(0,start-anchor.prefix.length),start)===anchor.prefix)&&(!anchor.suffix||value.slice(end,end+anchor.suffix.length)===anchor.suffix);
    if(matches(text))return {start,end};
    // Reconstruct the previous renderer from this exact immutable block. Never
    // search another occurrence, change stored notes, or cross a version boundary.
    const legacy=context.legacyText;
    if(typeof legacy!=='string'||!matches(legacy))return null;
    return presentationAnchor(text,legacy,start,end,anchor.quote);
  }
  function shouldExpireSession(path,status,code){return status===401&&(code==='authentication_required'||!['login','register','verify','reset-request','reset-password','verification','captcha','captcha/verify'].includes(path));}
  // Disk carries a short-lived presentation hint only: never roles, CSRF or tokens.
  function createSessionCache(storage,clock=()=>Date.now()) {
    const key='read-session-presentation-v2',hintKey='read-account-hint-v1',ttl=30000;
    let pending=null,memory=null,generation=0;
    const get=key=>{try{return storage?.getItem(key);}catch{return null;}};
    const put=(key,value)=>{try{storage?.setItem(key,value);}catch{}};
    const remove=key=>{try{storage?.removeItem(key);}catch{}};
    function hint(){return get(hintKey)==='1';}
    function invalidate(){generation++;pending=null;memory=null;remove(key);remove(hintKey);remove('read-anonymous-session-v1');}
    function peek(){
      const now=clock();
      if(memory&&now>=memory.at&&now-memory.at<ttl)return memory.value;
      try{const saved=JSON.parse(get(key)||'null');if(!saved||!Number.isFinite(saved.at)||now<saved.at||now-saved.at>=ttl||typeof saved.configured!=='boolean')return null;
        const user=saved.user&&typeof saved.user.id==='string'&&typeof saved.user.email==='string'?{id:saved.user.id,email:saved.user.email}:null;
        const favoriteIds=Array.isArray(saved.favoriteIds)?saved.favoriteIds.filter(id=>typeof id==='string'&&/^[\w-]+$/.test(id)):undefined;
        return {user,favoriteIds,adminNavHint:Boolean(user&&saved.adminNavHint),configured:saved.configured,csrfToken:'',cached:true,cacheRemainingMs:ttl-(now-saved.at)};
      }catch{return null;}
    }
    function remember(value){
      memory={at:clock(),value};
      const user=value.user?{id:value.user.id,email:value.user.email||''}:null;
      put(key,JSON.stringify({at:memory.at,user,adminNavHint:value.user?.role==='admin',configured:Boolean(value.configured)}));
      if(user)put(hintKey,'1');else remove(hintKey);
    }
    function rememberFavorites(ids,publicIds){
      if(!Array.isArray(publicIds)||!memory?.value.user)return;
      const allowed=new Set(publicIds),favorites=[...new Set(ids.filter(id=>allowed.has(id)))];
      memory.value.favoriteIds=favorites;
      try{const saved=JSON.parse(get(key)||'null');if(saved?.user?.id===memory.value.user.id){saved.favoriteIds=favorites;put(key,JSON.stringify(saved));}}catch{}
    }
    function read(request,{force=false}={}) {
      const cached=force?null:peek();if(cached)return Promise.resolve(cached);
      if(pending)return pending;
      const token=generation;
      const job=Promise.resolve().then(request).then(value=>{if(token===generation)remember(value);return value;}).finally(()=>{if(pending===job)pending=null;});
      pending=job;return job;
    }
    return {read,invalidate,hint,peek,remember,rememberFavorites,ttl};
  }
  let sessionStorageSafe;try{sessionStorageSafe=global.sessionStorage;}catch{}
  const sessionCache=createSessionCache(sessionStorageSafe);
  function api(path,body,method,options={}) {
    if(path==='session')return sessionCache.read(()=>memberRequest(path,body,method),options);
    if(!['GET','HEAD'].includes(method||(body===undefined?'GET':'POST'))&&(!state.csrfToken||state.authStatus==='cached')){const uid=state.user?.id||null,epoch=state.epoch;return refreshAuthSession().then(()=>{if((state.user?.id||null)!==uid||state.epoch!==epoch)throw Error('登录状态已变化，请重新打开页面后操作；本次内容未保存。');return api(path,body,method,options);});}
    return memberRequest(path,body,method).then(value=>{
      if(['login','register','verify','logout','reset-password'].includes(path))sessionCache.invalidate();
      return value;
    });
  }
  async function memberRequest(path,body,method) {
    const verb=method||(body===undefined?'GET':'POST');const headers={};if(!['GET','HEAD'].includes(verb))headers['X-CSRF-Token']=state.csrfToken;if(body!==undefined)headers['Content-Type']='application/json';const response=await fetch('/api/member/'+path,{method:verb,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(['verification','reset-request','register','verify','reset-password','login'].includes(path)?60000:15000),headers,body:body===undefined?undefined:JSON.stringify(body)});
    let data={};try{data=await response.json();}catch{}
    if(state.user&&shouldExpireSession(path,response.status,data.error)){clearAccountMemory();throw new Error('登录状态已失效，请重新登录；未保存的内容不会写入其他账号。');}if(!response.ok){if(data.error==='reauthentication_required')throw new Error('请先在账号页重新登录，再返回完成此版本审核。');const messages={invalid_input:'提交内容不完整或格式不正确，请刷新页面后重试；意见内容仍保留。',invalid_target:'请选择有效的整篇、段落或图片意见范围。',invalid_version:'稿件版本信息无效，请重新打开稿件后提交。',stale_feedback:'稿件已更新，请重新打开最新版本后填写意见。',feedback_conflict:'此批注已在其他窗口修改，请重新打开稿件后编辑。',feedback_owner_required:'只能修改本人保存的批注。',verification_response_invalid:'邮件可能已发送，但未取得有效验证凭据。请重新发送验证码，以最新一封为准。',verification_persistence_failed:'邮件可能已送达，但验证记录保存失败。请重新发送验证码后再提交。',csrf_rejected:'安全会话已失效，请刷新页面后重试。',auth_rejected:path==='login'?'邮箱或密码不正确，请检查后重试。':'验证未通过，请检查验证码是否正确、是否过期。',auth_unavailable:'邮箱认证服务暂时不可用，请稍后再试。',service_unavailable:'账号服务暂时不可用，请稍后再试。',rate_limited:'操作过于频繁，请稍后再试。',captcha_required:'请先完成图片安全验证。',captcha_expired_or_used:'图片验证码已过期或已使用，请重新获取。',verification_not_issued:'邮箱验证码已过期，请重新发送。',verification_already_used:'此邮箱验证码已使用，请重新发送。',password_too_short:'密码至少需要 12 位。',captcha_unconfigured:'安全验证尚未配置，请稍后重试。'};const error=new Error(messages[data.error]||data.message||'暂时无法完成，请稍后重试。');error.code=data.error;error.status=response.status;throw error;}return data;
  }
  function notify(message,source){
    const dialog=source?.closest?.('dialog[open]')||[...document.querySelectorAll('dialog[open]')].at(-1);
    const scope=dialog||source?.closest?.('[data-member-page]')||document;
    let targets=[...scope.querySelectorAll('[data-member-status]')];
    if(!targets.length){const status=el('p',undefined,'member-status member-action-status');status.setAttribute('data-member-status','');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');if(dialog)dialog.append(status);else if(source?.parentElement)source.parentElement.append(status);else(document.querySelector('[data-member-page]')||document.querySelector('main')||document.body).append(status);targets=[status];}
    targets.forEach(n=>{n.textContent=message;n.setAttribute('role',source?'alert':'status');n.setAttribute('aria-live',source?'assertive':'polite');});
  }
  function guestLoad(){try{return normalizeLibrary(JSON.parse(localStorage.getItem(KEY)||'{}'));}catch{return normalizeLibrary({});}}
  let serverLibrary={favorites:[],annotations:[]};
  function decodeNote(n){let anchor={};try{anchor=JSON.parse(n.anchor||'{}');}catch{}return {...anchor,id:n.id,clientId:n.client_id||n.id,articleId:n.article_id,revision:n.version_hash,quote:n.quote,note:n.text,updatedAt:n.created_at||''};}
  async function remoteLoad(){const [favorites,notes]=await Promise.all([api('favorites'),api('notes')]);serverLibrary={favorites:(favorites.items||favorites).map(x=>x.article_id),annotations:(notes.items||notes).map(decodeNote)};return structuredClone(serverLibrary);}
  let readerContextFlight=null;
  function loadReaderContext(){
    if(readerContextFlight)return readerContextFlight;
    const epoch=state.epoch,article=typeof location==='undefined'?'':new URLSearchParams(location.search).get('article')||'';
    const path='reader-context'+(article?'?article='+encodeURIComponent(article):'');
    readerContextFlight=api(path).catch(async error=>{
      // A rolling deployment can temporarily serve the previous backend.
      if(![401,404].includes(error.status))throw error;
      const session=await api('session',undefined,undefined,{force:true});
      return {session,article,normalizedLibrary:session.user?await remoteLoad():{favorites:[],annotations:[]}};
    }).then(context=>{
      if(state.epoch!==epoch)throw Error('登录状态已变化，请重新打开阅读页。');
      if(!context?.session||context.session.cached)throw Error('账号信息暂时无法确认。');
      sessionCache.remember(context.session);return context;
    }).catch(error=>{readerContextFlight=null;throw error;});
    return readerContextFlight;
  }
  function libraryFromContext(context){
    if(context.normalizedLibrary)return context.normalizedLibrary;
    const favorites=context.favorites?.items||context.favorites||[],notes=context.notes?.items||context.notes||[];
    serverLibrary={favorites:favorites.map(x=>x.article_id),annotations:notes.map(decodeNote)};
    return structuredClone(serverLibrary);
  }
  function cachePublicFavorites(){
    if(state.user&&state.authStatus==='ready'&&state.libraryReady&&Array.isArray(state.publicCatalogIds))sessionCache.rememberFavorites(state.library.favorites,state.publicCatalogIds);
  }
  function setPublicCatalog(articles){
    const allowed=new Set(['approved','proofreading','existing-public-baseline']);
    state.publicCatalogIds=(articles||[]).filter(a=>a.public===true&&allowed.has(a.reviewStatus)).map(a=>a.id);
    cachePublicFavorites();
  }
  let libraryReadyFlight=null;
  async function ensureLibraryReady(){
    await global.ReadMembers?.ready;
    if(state.libraryReady)return state;
    if(libraryReadyFlight)return libraryReadyFlight;
    const epoch=state.epoch,uid=state.user?.id||null;
    const job=(async()=>{
      const context=await loadReaderContext();if(state.epoch!==epoch)throw Error('登录状态已变化，请重试收藏。');
      const session=context.session,changed=uid!==(session.user?.id||null);
      if(changed){clearAccountMemory();sessionCache.remember(session);}
      state.user=session.user||null;state.csrfToken=session.csrfToken||'';state.authStatus='ready';state.expired=false;state.accountHint=Boolean(state.user);state.adminNavHint=state.user?.role==='admin';
      state.library=state.user?libraryFromContext(context):guestLoad();state.libraryReady=true;state.presentationFavoritesKnown=true;state.readerContext=context;cachePublicFavorites();refreshNavigation();document.dispatchEvent(new CustomEvent('read-members-change'));
      if(changed)throw Error('登录账号已变化，请确认当前账号后再次点击收藏。');return state;
    })().finally(()=>{if(libraryReadyFlight===job)libraryReadyFlight=null;});
    libraryReadyFlight=job;return job;
  }
  function sameNote(a,b){return a.id===b.id||Boolean(a.clientId&&b.clientId&&a.clientId===b.clientId);}
  async function syncLibrary(desired,confirmed,request,assertCurrent=()=>{}){
    const checked=async(path,body,method)=>{assertCurrent();const result=await request(path,body,method);assertCurrent();return result;};
    for(const id of desired.favorites.filter(x=>!confirmed.favorites.includes(x))){await checked('favorites/'+encodeURIComponent(id),{},'PUT');confirmed.favorites.push(id);}
    for(const id of confirmed.favorites.filter(x=>!desired.favorites.includes(x))){await checked('favorites/'+encodeURIComponent(id),undefined,'DELETE');confirmed.favorites=confirmed.favorites.filter(x=>x!==id);}
    for(const note of desired.annotations.filter(x=>!confirmed.annotations.some(y=>sameNote(x,y)))){
      note.clientId=note.clientId||note.id;note.syncPending=true;
      const saved=await checked('notes',{client_id:note.clientId,article_id:note.articleId,version_hash:note.revision,anchor:JSON.stringify({blockId:note.blockId,prefix:note.prefix,suffix:note.suffix,offset:note.offset}),quote:note.quote,text:note.note});
      note.id=saved.id;note.syncPending=false;confirmed.annotations.push(structuredClone(note));
    }
    for(const note of confirmed.annotations.filter(x=>!desired.annotations.some(y=>sameNote(x,y)))){
      try{await checked('notes/'+encodeURIComponent(note.id),undefined,'DELETE');}catch(error){assertCurrent();if(error.status!==404)throw error;}
      confirmed.annotations=confirmed.annotations.filter(x=>!sameNote(x,note));
    }
    return confirmed;
  }
  let persistQueue=Promise.resolve();
  function persist(){if(!state.libraryReady)return Promise.reject(new Error('收藏与笔记尚未载入，请刷新后重试，当前不会覆盖账号数据。'));const epoch=state.epoch,uid=state.user?.id,desired=state.library;const assertCurrent=()=>{if(state.expired||state.epoch!==epoch||state.user?.id!==uid)throw new Error('登录状态已变化，同步已停止，请重新打开阅读页。');};const run=async()=>{assertCurrent();if(uid)await syncLibrary(desired,serverLibrary,api,assertCurrent);else{try{localStorage.setItem(KEY,JSON.stringify(desired));}catch{throw new Error('浏览器无法保存，请检查存储空间或隐私设置。');}}assertCurrent();document.dispatchEvent(new CustomEvent('read-members-change'));};const result=persistQueue.then(run,run);persistQueue=result.catch(()=>{});return result;}
  async function toggleFavorite(id){
    await global.ReadMembers?.ready;const epoch=state.epoch,uid=state.user?.id||null;
    if(!state.libraryReady)await ensureLibraryReady();
    if(state.epoch!==epoch||(state.user?.id||null)!==uid)throw Error('登录状态已变化，请确认后再次收藏。');
    const had=state.library.favorites.includes(id);state.library.favorites=had?state.library.favorites.filter(x=>x!==id):[...state.library.favorites,id];
    try{await persist();cachePublicFavorites();return !had;}catch(error){if(state.epoch===epoch&&!state.expired)state.library.favorites=had?[...new Set([...state.library.favorites,id])]:state.library.favorites.filter(x=>x!==id);throw error;}
  }
  function button(text,action){const n=el('button',text);n.type='button';n.addEventListener('click',async()=>{n.disabled=true;try{await action();}catch(e){if(n.isConnected)notify(e?.message||'操作未完成，请稍后重试。',n);}finally{n.disabled=false;}});return n;}
  function isAdministrator(){return state.authStatus==='ready'&&!state.expired&&state.user?.role==='admin';}
  function administratorLink(label='审稿'){const link=el('a',label);link.href=memberUrl('admin');link.setAttribute('data-member-admin','');return link;}
  function mountNavigation(container){
    const nav=el('nav',undefined,'member-navigation');nav.setAttribute('aria-label','阅读与账号');
    for(const [text,href] of [['文献导航',homeUrl()],['我的收藏',memberUrl('favorites')]]){if(container.closest('.topbar')&&text==='文献导航')continue;const a=el('a',text);a.href=href;nav.append(a);}
    const a=el('a',state.user||state.accountHint?'我的账户':'登录 / 注册');a.href=memberUrl('account');a.addEventListener('click',event=>{event.preventDefault();openAccountEntry();});nav.append(a);
    if(isAdministrator()||(state.authStatus==='cached'&&!state.expired&&state.adminNavHint))nav.append(administratorLink());
    container.querySelectorAll('.member-navigation').forEach(n=>n.remove());container.append(nav);return nav;
  }
  let resolveAccountEntry=null;
  function refreshNavigation(){if(typeof document!=='undefined')document.querySelectorAll('[data-member-nav]').forEach(mountNavigation);resolveAccountEntry?.();}
  function openAccountEntry(){
    if(state.authStatus==='ready'&&state.csrfToken){openAccount(state.user?'account':'login');return;}
    if(resolveAccountEntry)return;
    const modal=el('dialog',undefined,'member-auth member-main'),prior=document.activeElement,close=button('×',()=>modal.close()),title=el('h1','账号'),body=el('div');
    close.className='member-auth-close';close.setAttribute('aria-label','关闭账号窗口');title.id='member-pending-title';modal.setAttribute('aria-labelledby',title.id);modal.append(close,title,body);
    const update=()=>{if(!modal.isConnected)return;if(state.authStatus==='ready'&&state.csrfToken){resolveAccountEntry=null;modal.close();openAccount(state.user?'account':'login');return;}body.replaceChildren();const status=el('p',state.authStatus==='error'?'账号暂时无法载入，请重试。':'正在恢复登录状态，请稍候。');status.setAttribute('role','status');body.append(status);if(state.authStatus==='error')body.append(button('重试',()=>location.reload()));};
    resolveAccountEntry=update;modal.addEventListener('close',()=>{if(resolveAccountEntry===update)resolveAccountEntry=null;modal.remove();if(state.authStatus!=='ready')prior?.focus();});document.body.append(modal);modal.showModal();update();if(state.authStatus==='cached'||!state.csrfToken)refreshAuthSession().catch(()=>{state.authStatus='error';refreshNavigation();});
  }
  function closeAnnotationButton(action){const control=button('',action);control.className='member-annotation-close';control.setAttribute('aria-label','关闭批注');control.title='关闭';const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M6 6l12 12M18 6L6 18');svg.append(path);control.append(svg);return control;}
  function annotationPopupPosition(anchor,box,viewport){
    const margin=12,left=viewport.left||0,top=viewport.top||0,width=Math.min(420,viewport.width-margin*2),height=Math.min(box.height,viewport.height-margin*2);
    let x=anchor.right+12,y=anchor.top;
    if(x+width>left+viewport.width-margin){x=anchor.left-width-12;if(x<left+margin){x=left+margin;y=anchor.bottom+10;if(y+height>top+viewport.height-margin)y=anchor.top-height-10;}}
    return {left:Math.max(left+margin,Math.min(x,left+viewport.width-width-margin)),top:Math.max(top+margin,Math.min(y,top+viewport.height-height-margin)),width,maxHeight:viewport.height-margin*2};
  }
  function positionAnnotationPopup(popup,range){
    if(!popup?.style)return;
    if(range)popup._annotationAnchor=range.cloneRange?.()||range;
    const visual=global.visualViewport,viewport={left:visual?.offsetLeft||0,top:visual?.offsetTop||0,width:visual?.width||global.innerWidth||1024,height:visual?.height||global.innerHeight||768};
    popup.style.width=Math.min(420,viewport.width-24)+'px';popup.style.maxHeight=(viewport.height-24)+'px';
    let anchor;try{const rects=[...(popup._annotationAnchor?.getClientRects?.()||[])];anchor=rects.filter(r=>r.bottom>viewport.top&&r.top<viewport.top+viewport.height).at(-1)||popup._annotationAnchor?.getBoundingClientRect?.();}catch{}
    anchor=anchor||{left:viewport.left+viewport.width/2,right:viewport.left+viewport.width/2,top:viewport.top+viewport.height/3,bottom:viewport.top+viewport.height/3};
    const next=annotationPopupPosition(anchor,popup.getBoundingClientRect(),viewport);popup.style.left=next.left+'px';popup.style.top=next.top+'px';popup.style.right='auto';popup.style.bottom='auto';
  }
  let exportLoader;
  function mountArticleExport(context){
    if(state.user?.role!=='admin'||!context.snapshot)return;
    const epoch=state.epoch,uid=state.user.id;
    if(!exportLoader)exportLoader=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=new URL('member-system/article-export.js',scriptRoot).href;script.onload=()=>resolve(global.ReadArticleExport);script.onerror=()=>{exportLoader=null;reject(Error('导出工具加载失败，请刷新重试。'));};document.head.append(script);});
    exportLoader.then(tool=>{if(state.epoch!==epoch||state.user?.id!==uid)return;tool.mount({...context,api,isCurrent:()=>state.epoch===epoch&&state.user?.id===uid&&state.user?.role==='admin'&&!state.expired,coverUrl:new URL(`covers/${context.articleId}.png`,scriptRoot).href});}).catch(error=>notify(error.message));
  }
  function versionReaderUrl(articleId,version){const url=new URL(readUrl(articleId),location.href);url.searchParams.set('review','1');if(version)url.searchParams.set('version',version);return url.href;}
  function mountVersionHistory({articleId,revision,toolbar}){
    if(state.user?.role!=='admin'||!toolbar)return;
    const epoch=state.epoch,uid=state.user.id,current=()=>state.epoch===epoch&&state.user?.id===uid&&!state.expired;
    const detail=el('details',undefined,'member-version-panel');detail.append(el('summary','版本'));const list=el('div',undefined,'reader-version-list');detail.append(list);toolbar.append(detail);
    let loaded=false;
    detail.addEventListener('toggle',async()=>{if(!detail.open||loaded)return;list.replaceChildren(el('p','正在读取版本记录…'));try{const result=await api('admin/drafts/'+encodeURIComponent(articleId)+'/versions');if(!current())return;list.replaceChildren();for(const item of result.items||[]){const card=el('a',undefined,'reader-version-card');card.href=versionReaderUrl(articleId,item.is_current?null:item.version_hash);const viewing=item.version_hash===revision||item.content_hash===revision;card.dataset.current=String(!!item.is_current);card.dataset.viewing=String(viewing);if(viewing)card.setAttribute('aria-current','page');const heading=el('div',undefined,'reader-version-card-heading');heading.append(el('strong','版本 '+item.version_number));if(viewing)heading.append(el('span','正在查看','reader-version-tag'));if(item.is_current)heading.append(el('span','最新版','reader-version-tag'));const savedTime=el('time','保存时间未记录');if(item.created_at){const date=new Date(item.created_at);if(Number.isFinite(date.getTime())){savedTime.dateTime=item.created_at;savedTime.textContent=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}).format(date);}}card.append(heading,savedTime,el('p',item.summary||item.note||'此版本未附修改说明'),el('small',String(item.feedback_count||0)+' 条批注'));list.append(card);}if(!list.children.length)list.append(el('p','尚无版本记录。'));loaded=true;}catch(error){list.replaceChildren(el('p',error.message||'版本记录暂时无法载入。'),button('重试',()=>{loaded=false;detail.open=false;detail.open=true;}));}});
    document.addEventListener('read-members-expired',()=>detail.remove(),{once:true});return detail;
  }
  function mountHistoricReader({articleId,revision,snapshot,assetUrl,root,toolbar,draft}){
    const badge=el('div',undefined,'reader-historical-banner');badge.setAttribute('role','status');const back=el('a','返回最新版');back.href=versionReaderUrl(articleId);badge.append(el('strong','历史版本 · 只读'),back);toolbar.append(badge);
    mountVersionHistory({articleId,revision,toolbar});mountArticleExport({articleId,revision,snapshot,assetUrl,toolbar,source:'history'});
    const detail=el('details',undefined,'member-notes-panel'),list=el('div');detail.append(el('summary','此版本的批注'),list);toolbar.append(detail);const entries=[];
    for(const record of draft.feedback||[]){if(record.version_hash!==revision)continue;list.append(el('blockquote',record.quote||'整篇意见'),el('p',record.comment));if(record.source_label)list.append(el('small',record.source_label));let id=record.target_id;try{id=JSON.parse(id).blockId;}catch{}const block=[...root.querySelectorAll('[data-block-id]')].find(n=>n.dataset.blockId===id),anchor=block?reviewLocation(record,revision,block.textContent,legacyBlockText(snapshot,block.dataset.blockId)):null;if(!anchor)continue;const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let n,offset=0,start,end;while(n=walker.nextNode()){const next=offset+n.textContent.length;if(!start&&anchor.start>=offset&&anchor.start<next)start=[n,anchor.start-offset];if(anchor.end>offset&&anchor.end<=next){end=[n,anchor.end-offset];break;}offset=next;}if(start&&end){const range=document.createRange();range.setStart(...start);range.setEnd(...end);entries.push({range,quote:record.quote,note:record.comment});}}
    if(!list.children.length)list.append(el('p','此版本没有批注。'));if(global.CSS?.highlights&&global.Highlight)CSS.highlights.set('read-review-notes',new Highlight(...entries.map(e=>e.range)));const dispose=mountHighlightNotes(root,()=>entries,()=>{});const destroy=()=>{dispose();badge.remove();detail.remove();global.CSS?.highlights?.delete('read-review-notes');};document.addEventListener('read-members-expired',destroy,{once:true});return {destroy,refresh(){}};
  }
  function mountReader({articleId,revision,snapshot,assetUrl,metadata,root,toolbar,figureRoot}) {
    mountVersionHistory({articleId,revision:snapshot?.review_version_hash||revision,toolbar});
    mountArticleExport({articleId,revision,snapshot,assetUrl,metadata,toolbar:toolbar||root.parentElement,source:'published'});
    if(!state.libraryReady){const notice=el('span',undefined,'member-reader-connection');notice.setAttribute('role','status');notice.append(el('span','收藏与笔记暂未连接'),button('重试连接',()=>location.reload()));const host=document.querySelector('[data-member-nav]')||toolbar;host?.append(notice);return {refresh(){},destroy(){notice.remove();}};}
    let pending=null,pendingItem=null,highlightEnabled=false;document.addEventListener('read-members-expired',()=>{disposeHighlightNotes();pending=null;pendingItem=null;textarea.value='';quote.textContent='';quote.hidden=true;collect.disabled=true;});const bar=el('div',undefined,'member-reader-actions');const status=el('span');status.setAttribute('data-member-status','');
    const favorite=button('',async()=>{await toggleFavorite(articleId);refresh();});function refresh(){favorite.textContent=state.library.favorites.includes(articleId)?'已收藏':'收藏本文';}refresh();bar.append(favorite);const marker=button('荧光笔',()=>{highlightEnabled=!highlightEnabled;marker.setAttribute('aria-pressed',String(highlightEnabled));if(highlightEnabled)capture();else{clearTimeout(selectionTimer);pending=null;editor.hidden=true;}});marker.setAttribute('aria-pressed','false');bar.append(marker);const collect=button('保存所选文字',async()=>{if(!pending)throw new Error('请先在正文中选择文字。');const note=textarea.value.trim();const item=pendingItem||{...pending,id:crypto.randomUUID(),note,updatedAt:new Date().toISOString()};pendingItem=item;if(!state.library.annotations.includes(item))state.library.annotations.push(item);try{await persist();pending=null;pendingItem=null;collect.disabled=true;quote.hidden=true;textarea.value='';global.getSelection()?.removeAllRanges();editor.hidden=true;notify('已保存到阅读笔记。');paint();}catch(error){if(!state.expired){item.syncPending=true;paint();}throw error;}});collect.disabled=true;
    const textarea=el('textarea');textarea.placeholder='给所选文字写笔记（可留空）';textarea.maxLength=10000;textarea.setAttribute('aria-label','所选文字笔记');textarea.rows=2;const quote=el('p',undefined,'member-selection');quote.hidden=true;bar.append(status);const editor=el('section',undefined,'member-review-editor');editor.hidden=true;const editorHeading=el('strong','阅读批注'),markOnly=button('仅标黄',()=>{textarea.value='';collect.click();}),allNotes=button('全部批注',()=>{if(global.ReadChrome?.openNotes)global.ReadChrome.openNotes(allNotes);else panel.open=true;});allNotes.className='member-all-notes';editor.append(editorHeading,quote,textarea,collect,markOnly,allNotes,closeAnnotationButton(()=>{editor.hidden=true;pending=null;pendingItem=null;collect.disabled=true;global.getSelection()?.removeAllRanges();}));document.body.append(editor);const panel=el('details',undefined,'member-notes-panel');panel.append(el('summary','划句与笔记'));const list=el('div');panel.append(list);(toolbar||root.parentElement).append(bar,panel);
    function capture(){if(!highlightEnabled)return;const sel=global.getSelection();if(!sel||sel.isCollapsed||sel.rangeCount!==1)return;const range=sel.getRangeAt(0);const node=range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;const block=node.closest('[data-block-id]');if(!block||!root.contains(block)||block.querySelector('figure')||figureRoot?.contains(block))return;const endBlock=(range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement).closest('[data-block-id]');if(endBlock!==block)return;const before=range.cloneRange();before.selectNodeContents(block);before.setEnd(range.startContainer,range.startOffset);const start=before.toString().length,text=block.textContent,selected=range.toString();if(!selected.trim()||selected.length>2000)return;if(textarea.readOnly||!pending||pending.blockId!==block.dataset.blockId||pending.quote!==selected||pending.offset.start!==start)textarea.value='';pendingItem=null;pending={articleId,revision:String(revision),blockId:block.dataset.blockId,quote:selected,prefix:text.slice(Math.max(0,start-32),start),suffix:text.slice(start+selected.length,start+selected.length+32),offset:{start,end:start+selected.length}};quote.textContent=selected;quote.hidden=false;editorHeading.textContent='阅读批注';textarea.readOnly=false;collect.hidden=markOnly.hidden=false;collect.disabled=false;void global.ReadChrome?.closePanel();editor.hidden=false;positionAnnotationPopup(editor,range);}
    let selectionTimer,selecting=false;const selectionChanged=()=>{clearTimeout(selectionTimer);if(highlightEnabled&&!selecting)selectionTimer=setTimeout(capture,250);};const beginSelection=()=>{selecting=true;clearTimeout(selectionTimer);};const endSelection=()=>{selecting=false;selectionChanged();};root.addEventListener('pointerdown',beginSelection);document.addEventListener('pointerup',endSelection);document.addEventListener('pointercancel',endSelection);root.addEventListener('keyup',selectionChanged);document.addEventListener('selectionchange',selectionChanged);
    let highlightedNotes=[];const disposeHighlightNotes=mountHighlightNotes(root,()=>highlightedNotes,()=>{clearTimeout(selectionTimer);editor.hidden=true;},hits=>{const hit=hits[0];pending=null;quote.textContent=hit.quote;quote.hidden=false;textarea.value=hit.note||'';textarea.readOnly=true;collect.hidden=markOnly.hidden=true;editorHeading.textContent='已保存的批注';void global.ReadChrome?.closePanel();editor.hidden=false;positionAnnotationPopup(editor,hit.range);});
    function paint(){list.replaceChildren();highlightedNotes=[];const highlights=[];for(const item of state.library.annotations.filter(x=>x.articleId===articleId)){const row=el('div',undefined,'member-note');row.append(el('blockquote',item.quote),el('p',item.note||'未写笔记'));if(item.syncPending)row.append(el('small','同步尚未完成，重试会继续保存同一条笔记。'),button('重试同步',async()=>{await persist();paint();}));const block=[...root.querySelectorAll('[data-block-id]')].find(n=>n.dataset.blockId===item.blockId);const anchor=block?resolveAnchor(item,{articleId,revision,blockId:item.blockId,text:block.textContent,legacyText:legacyBlockText(snapshot,item.blockId)}):null;if(!anchor)row.append(el('small','原文版本或位置已变化，保留笔记，未自动贴回。'));else if(global.CSS?.highlights&&global.Highlight){const walk=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let p=0,s=null,e=null;while(walk.nextNode()){const n=walk.currentNode,next=p+n.length;if(s===null&&anchor.start>=p&&anchor.start<next)s=[n,anchor.start-p];if(anchor.end>p&&anchor.end<=next){e=[n,anchor.end-p];break;}p=next;}if(s&&e){const r=document.createRange();r.setStart(...s);r.setEnd(...e);highlights.push(r);highlightedNotes.push({range:r,quote:item.quote,note:item.note});}}row.append(button('删除笔记',async()=>{const old=state.library.annotations;state.library.annotations=old.filter(x=>x.id!==item.id);try{await persist();paint();}catch(error){if(!state.expired&&!state.library.annotations.some(x=>sameNote(x,item)))state.library.annotations.push(item);throw error;}}));list.append(row);}if(global.CSS?.highlights&&global.Highlight)CSS.highlights.set('read-member-notes',new Highlight(...highlights));if(!list.children.length)list.append(el('p','还没有笔记。选择正文中的一句话即可开始。'));}paint();return {refresh:paint,destroy(){disposeHighlightNotes();clearTimeout(selectionTimer);root.removeEventListener('pointerdown',beginSelection);document.removeEventListener('pointerup',endSelection);document.removeEventListener('pointercancel',endSelection);root.removeEventListener('keyup',selectionChanged);document.removeEventListener('selectionchange',selectionChanged);editor.remove();bar.remove();panel.remove();}};
  }
  function field(form,label,name,type='text',required=true){const wrap=el('label',label),input=el('input');input.name=name;input.type=type;input.required=required;input.autocomplete=type==='password'?(name==='password'?'current-password':'new-password'):'email';wrap.append(input);form.append(wrap);return input;}
  let authRefresh=null;
  function refreshAuthSession(request=api){
    if(authRefresh)return authRefresh;
    const epoch=state.epoch;
    const job=(async()=>{
      const session=await request('session',undefined,undefined,{force:true});
      if(state.epoch!==epoch)throw new Error('登录状态已变化，请重试当前操作。');
      const identityChanged=(state.user?.id||null)!==(session.user?.id||null);
      const roleChanged=Boolean(state.user?.role&&state.user.role!==session.user?.role);
      if(identityChanged||roleChanged){if(typeof document!=='undefined')clearAccountMemory();else{state.epoch++;state.libraryReady=false;state.readerContext=null;state.library={favorites:[],annotations:[]};sessionCache.invalidate();}sessionCache.remember(session);}
      state.csrfToken=session.csrfToken||'';state.user=session.user||null;state.accountHint=Boolean(session.user);state.adminNavHint=session.user?.role==='admin';state.configured=Boolean(session.configured);state.authStatus='ready';state.expired=false;refreshNavigation();return session;
    })().finally(()=>{if(authRefresh===job)authRefresh=null;});
    authRefresh=job;return job;
  }

  function validCaptchaReply(event,expected){return Boolean(event&&event.source===expected.source&&event.origin===expected.origin&&event.data?.state===expected.state&&typeof event.data.captcha_token==='string'&&event.data.captcha_token.length>0&&Date.now()<expected.expiresAt);}
  function validateImageChallenge(value,now=Date.now()){if(!value||typeof value.image_data!=='string'||value.image_data.length>1500000||!/^data:image\/(gif|png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value.image_data)||typeof value.state!=='string'||!value.state||!Number.isFinite(value.expires_in)||value.expires_in<=0)throw new Error('安全验证暂时无法启用，请稍后重试。');return {src:value.image_data,state:value.state,expiresAt:now+Math.min(600,value.expires_in)*1000};}
  async function captcha(){
    let challenge;
    return new Promise((resolve,reject)=>{
      const modal=el('dialog',undefined,'member-captcha'),heading=el('h2','邮箱安全验证'),image=el('img'),imageRefresh=el('button',undefined,'member-captcha-image'),input=el('input'),message=el('p'),controls=el('div');
      image.alt='图片验证码，点击换一张';imageRefresh.type='button';imageRefresh.setAttribute('aria-label','刷新图片验证码');imageRefresh.append(image);input.placeholder='图片中的字符';input.maxLength=4;input.autocomplete='off';input.setAttribute('aria-label','图片验证码');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
      let timer,slowTimer,finished=false,busy=false;
      function finish(error,value){if(finished)return;finished=true;clearTimeout(timer);clearTimeout(slowTimer);modal.close();modal.remove();if(error)reject(error);else resolve(value);}
      function lock(value){busy=value;imageRefresh.disabled=value;input.disabled=value||!challenge;controls.querySelectorAll('button').forEach(n=>n.disabled=value&&n.dataset.cancel!=='true');if(controls.firstElementChild)controls.firstElementChild.disabled=value||!challenge;modal.setAttribute('aria-busy',String(value));}function progress(text,slowText){clearTimeout(slowTimer);message.textContent=text;slowTimer=setTimeout(()=>{if(!finished&&busy)message.textContent=slowText;},4000);}
      function update(){image.src=challenge.src;input.value='';clearTimeout(timer);timer=setTimeout(()=>finish(new Error('图片安全验证已过期，请重新发送邮箱验证码。')),Math.max(0,challenge.expiresAt-Date.now()));}
      async function refreshImage(){if(busy||finished)return;lock(true);progress(challenge?'正在刷新图片…':'正在加载安全验证图片…','图片仍在加载，请稍候；网络较慢时可能需要十几秒。');try{const next=validateImageChallenge(await api('captcha',{}));if(finished)return;challenge=next;imageRefresh.hidden=false;update();message.textContent='请输入图片中的字符，点击图片可换一张。';}catch(error){if(!finished)message.textContent=error.message;}finally{clearTimeout(slowTimer);if(!finished){lock(false);if(challenge)input.focus();}}}
      async function verifyImage(){if(busy||finished||!challenge)return;if(!input.value.trim()){message.textContent='请填写图片中的字符。';input.focus();return;}lock(true);progress('正在核对图片验证码…','仍在核对图片验证码，请稍候，不需要重复点击。');try{const result=await api('captcha/verify',{state:challenge.state,key:input.value.trim()});if(finished)return;if(result.ok!==true)throw new Error('验证未完成，请重试。');finish(null,{captcha_state:challenge.state});}catch(error){if(!finished)message.textContent=error.message;}finally{clearTimeout(slowTimer);if(!finished)lock(false);}}
      imageRefresh.addEventListener('click',refreshImage);input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();verifyImage();}});const cancel=button('取消',()=>finish(new Error('安全验证已取消。')));cancel.dataset.cancel='true';controls.append(button('确认',verifyImage),button('换一张',refreshImage),cancel);modal.append(heading,el('p','点击图片可以换一张。请输入图片中的字符。'),imageRefresh,input,message,controls);modal.addEventListener('cancel',event=>{event.preventDefault();finish(new Error('安全验证已取消。'));});document.body.append(modal);imageRefresh.hidden=true;modal.showModal();refreshImage();
    });
  }
  function passwordStrength(value){const n=value.length,types=[/[a-z]/,/[A-Z]/,/[0-9]/,/[^a-zA-Z0-9]/].filter(r=>r.test(value)).length;return n<12?{level:0,text:'至少 12 位；建议使用较长的独特密码。'}:n>=16&&types>=3?{level:3,text:'强：长度与字符组合较充分。'}:types>=2?{level:2,text:'良好：增加长度可进一步增强。'}:{level:1,text:'可用：建议增加长度并混合字符。'};}
  function authenticationPayload(mode,values,verification){const payload={...values,remember:values.remember!==false};delete payload.confirmPassword;if(mode==='login'){payload.username=payload.email;delete payload.email;}if(['register','verify','reset-password'].includes(mode)){if(!verification.id||verification.email!==payload.email)throw new Error('请先向当前邮箱发送验证码。');payload.verification_id=verification.id;payload.verification_code=payload.code;delete payload.code;}if(mode==='reset-password'){payload.new_password=payload.newPassword;delete payload.newPassword;}return payload;}
  let authDialog=null;
  function openAccount(mode='login',reauth=false){
    if(authDialog?.isConnected){authDialog.showModal();return;}
    const accountEmail=['account','change-password'].includes(mode)?state.user?.email||'':'',prior=document.activeElement,modal=el('dialog',undefined,'member-auth member-main');authDialog=modal;
    const close=button('×',()=>modal.close()),heading=el('h1',reauth?'重新认证':'欢迎回来'),intro=el('p','登录后同步收藏与笔记，随时继续阅读。'),area=el('div'),tabs=el('div',undefined,'member-tabs'),brand=el('div','R· / 过渡金属与自由基','member-auth-brand');
    close.className='member-auth-close';close.setAttribute('aria-label','关闭账号窗口');heading.id='member-auth-title';modal.setAttribute('aria-labelledby',heading.id);intro.className='member-auth-intro';
    modal.append(close,brand,heading,intro,tabs,area);
    const modes=[['login','登录'],['register','注册']],verifications=new Map();
    function draw(current){
      area.replaceChildren();heading.textContent=reauth?'重新认证':current==='register'?'创建阅读账号':current==='reset-password'?(accountEmail?'修改密码':'找回密码'):current==='verify'?'邮箱验证码登录':'欢迎回来';
      tabs.hidden=Boolean(accountEmail&&current==='reset-password');[...tabs.children].forEach(n=>n.setAttribute('aria-selected',String(n.dataset.mode===current)));
      const form=el('form'),status=el('p',undefined,'member-auth-status'),verification=verifications.get(current)||{id:'',email:''};verifications.set(current,verification);let busy=false,loginChallenge=false;
      status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('data-auth-status','');
      const email=field(form,'邮箱地址','email','email');email.placeholder='you@example.com';email.autocomplete='email';email.spellcheck=false;if(accountEmail&&current==='reset-password'){email.value=accountEmail;email.readOnly=true;email.dataset.locked='true';form.append(el('small','验证码将发送至当前账号邮箱。修改密码后，所有设备都需要重新登录。','member-password-hint'));}
      let password,confirm;
      if(['login','register','reset-password'].includes(current)){
        const fresh=current!=='login';password=field(form,fresh?'设置密码':'密码',current==='reset-password'?'newPassword':'password','password');password.minLength=fresh?12:1;password.autocomplete=fresh?'new-password':'current-password';
        if(fresh){const strength=el('small',passwordStrength('').text,'member-password-hint');strength.setAttribute('aria-live','polite');password.addEventListener('input',()=>{const info=passwordStrength(password.value);strength.textContent=info.text;strength.dataset.level=info.level;confirm?.setCustomValidity('');});form.append(strength);confirm=field(form,'确认密码','confirmPassword','password');confirm.autocomplete='new-password';confirm.addEventListener('input',()=>confirm.setCustomValidity(''));}
      }
      function message(text,error=false){status.textContent=text;status.dataset.tone=error?'error':'info';status.setAttribute('role',error?'alert':'status');}
      function lock(value){busy=value;form.setAttribute('aria-busy',String(value));form.querySelectorAll('input').forEach(input=>{input.readOnly=value||input.dataset.locked==='true';});form.querySelectorAll('button').forEach(b=>b.disabled=value||!state.configured);tabs.querySelectorAll('button').forEach(b=>b.disabled=value);}
      if(['verify','register','reset-password'].includes(current)){
        const codeRow=el('div',undefined,'member-code-row'),code=field(form,'邮箱验证码','code');code.autocomplete='one-time-code';code.inputMode='numeric';code.maxLength=12;code.placeholder='输入邮件中的验证码';
        const send=button('发送验证码',async()=>{if(busy||!email.reportValidity())return;lock(true);message('正在准备图片验证…');try{const token=await captcha();message('图片验证已通过，正在发送邮箱验证码，请稍候…');const result=await api(current==='reset-password'?'reset-request':'verification',{email:email.value.trim().toLowerCase(),...token});if(!modal.isConnected)return;if(typeof result.verification_id!=='string'||!result.verification_id)throw new Error('未取得邮箱验证凭据，请重新发送验证码。');verification.id=result.verification_id;verification.email=email.value.trim().toLowerCase();message('验证码已发送，请查看收件箱和垃圾邮件。');send.textContent='重新发送';code.focus();}catch(error){message(error.message,true);}finally{lock(false);}});codeRow.append(send);form.append(codeRow);email.addEventListener('input',()=>{if(verification.id&&email.value.trim().toLowerCase()!==verification.email)message('邮箱已更改，请向当前邮箱重新发送验证码。',true);});
      }
      if(current==='login'){const label=el('label',undefined,'member-checkbox'),check=el('input');check.type='checkbox';check.name='remember';check.checked=true;label.append(check,document.createTextNode('保持登录'));form.append(label);}
      form.addEventListener('invalid',event=>{message(event.target.validationMessage||'请检查填写内容后重试。',true);},true);
      const label=current==='reset-password'?'重设密码':current==='register'?'创建账号':current==='verify'?'验证并登录':'登录',submit=el('button',label,'member-auth-submit');submit.type='submit';form.append(submit,status);
      form.addEventListener('submit',async event=>{event.preventDefault();if(busy)return;if(confirm&&password.value!==confirm.value){confirm.setCustomValidity('两次输入的密码不一致。');confirm.reportValidity();message('两次输入的密码不一致，请重新确认。',true);return;}lock(true);submit.textContent='正在处理…';message(current==='register'?'正在验证邮箱并创建账号…':'正在提交，请稍候…');try{const values=Object.fromEntries(new FormData(form));values.email=values.email.trim().toLowerCase();values.remember=form.querySelector('[name=remember]')?.checked??true;const payload=authenticationPayload(current,values,verification);if(current==='login'&&loginChallenge)Object.assign(payload,await captcha());await api(current,payload);if(!modal.isConnected)return;if(current==='reset-password'){clearAccountMemory();await refreshAuthSession();broadcastSession();draw('login');area.querySelector('[data-auth-status]').textContent='密码已更新，所有设备的登录会话已退出。请使用新密码重新登录。';return;}const fresh=await refreshAuthSession();if(!modal.isConnected)return;if(!fresh.user)throw new Error('验证请求已处理，但尚未建立登录会话，请尝试登录。');broadcastSession();modal.close();location.reload();}catch(error){if(current==='login'&&error.code==='captcha_required'){loginChallenge=true;message('需要图片安全验证，请再次点击登录以完成验证。',true);}else message(error.name==='TimeoutError'?'请求超时，请检查网络后重试。':error.message,true);}finally{submit.textContent=label;lock(false);}});
      const links=el('div',undefined,'member-auth-links');if(current==='login'){links.append(button('邮箱验证码登录',()=>draw('verify')),button('忘记密码？',()=>draw('reset-password')));}else if(current!=='register')links.append(button('返回密码登录',()=>draw('login')));area.append(form,links);lock(false);if(!state.configured)message('账号服务暂时不可用，可以关闭窗口继续阅读。',true);email.focus();
    }
    for(const [value,label]of modes){const tab=button(label,()=>draw(value));tab.dataset.mode=value;tab.setAttribute('role','tab');tabs.append(tab);}tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','登录或注册');
    modal.addEventListener('click',event=>{if(event.target===modal){const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modal.close();}});
    modal.addEventListener('close',()=>{modal.remove();authDialog=null;prior?.focus();});document.body.append(modal);if(mode==='account'&&state.user){tabs.hidden=true;heading.textContent='我的账号';intro.textContent='管理你的阅读账号与登录安全。';if(isAdministrator())area.append(administratorLink('稿件审核'));area.append(el('p',state.user.email,'member-account-email'),button('修改密码',()=>draw('reset-password')),button('退出登录',async()=>{await api('logout',{});clearAccountMemory();broadcastSession();modal.close();location.reload();}));}else draw(mode==='change-password'?'reset-password':mode);modal.showModal();area.querySelector('input')?.focus();
  }
  function accountPage(root){const reauth=new URLSearchParams(location.search).has('reauth');root.append(el('h1',state.user?'我的账号':'阅读，从这里继续'),el('p','收藏喜欢的文章，记录阅读中的想法。'));if(state.user&&!reauth){if(isAdministrator())root.append(administratorLink('稿件审核'));root.append(el('p',state.user.email),button('修改密码',()=>openAccount('change-password')),button('退出登录',async()=>{await api('logout',{});clearAccountMemory();broadcastSession();location.reload();}));return;}root.append(button('登录 / 注册',()=>openAccount()),el('p','无需登录，也可以继续浏览全部公开导读。'));const back=el('a','继续阅读');back.href=homeUrl();root.append(back);openAccount('login',reauth);}
  function safeAsset(value){try{const u=new URL(value,location.origin);return u.origin===location.origin&&/^https?:$/.test(u.protocol)?u.href:'';}catch{return '';}}
  function favoritesPage(root){root.append(el('h1','我的收藏'));const note=el('p',state.user?'收藏和笔记已连接账号。':'游客数据只保存在此浏览器，清理站点数据后会丢失。登录后可主动合并到账号。');root.append(note);const select=el('select');select.setAttribute('aria-label','收藏排序');for(const [value,label]of [['favorited','收藏时间'],['updated','更新时间'],['published','发表时间']]){const o=el('option',label);o.value=value;select.append(o);}root.append(select);const body=el('div');root.append(body);function render(){body.replaceChildren();for(const kind of ['research','review']){const rows=state.catalog.filter(a=>a.kind===kind&&state.library.favorites.includes(a.id)).sort((a,b)=>select.value==='favorited'?state.library.favorites.indexOf(b.id)-state.library.favorites.indexOf(a.id):String(select.value==='published'?b.firstPublishedOn:b.updatedAt).localeCompare(String(select.value==='published'?a.firstPublishedOn:a.updatedAt)));const section=el('section',undefined,'member-section'),head=el('div',undefined,'member-section-head'),track=el('div',undefined,'member-track');const count=el('span',`${rows.length} 篇`);head.append(el('h2',kind==='research'?'研究论文':'综述'),count);head.append(button('展开全部',()=>{const expanded=section.classList.toggle('is-expanded');expand.textContent=expanded?'收起':'展开全部';expand.setAttribute('aria-expanded',String(expanded));}));const expand=head.lastChild;expand.setAttribute('aria-expanded','false');const controls=el('div',undefined,'member-track-controls');for(const [direction,label]of [[-1,'上一组'],[1,'下一组']])controls.append(button(label,()=>track.scrollBy({left:direction*track.clientWidth,behavior:'smooth'})));const updateArrows=()=>{controls.children[0].disabled=track.scrollLeft<=2;controls.children[1].disabled=track.scrollLeft>=Math.max(0,track.scrollWidth-track.clientWidth)-2;};track.addEventListener('scroll',updateArrows,{passive:true});window.addEventListener('resize',updateArrows);requestAnimationFrame(updateArrows);section.append(head,controls,track);if(!rows.length)section.append(el('p','还没有收藏这类文章。'));for(const a of rows){const card=el('article',undefined,'member-card'),link=el('a');link.href=readUrl(a.id);link.target='_blank';link.rel='noopener';const src=safeAsset(a.cover);if(src){const img=el('img');img.alt='论文首页';img.loading='lazy';const media=el('div',undefined,'member-cover');media.append(img);link.append(media);if(global.ReadMedia){global.ReadMedia.cover(img,a);}else img.src=src;}link.append(el('small',`${a.journal||''} · ${a.published||''}`),el('h3',a.title),el('small',a.doi));link.className='member-main-link';card.append(link);const removeCard=()=>{if(!card.isConnected)return;card.remove();count.textContent=`${track.children.length} 篇`;updateArrows();if(!track.children.length&&!section.querySelector('.member-empty-favorites'))section.append(el('p','还没有收藏这类文章。','member-empty-favorites'));};if(global.ReadCardActions)global.ReadCardActions.mount(card,a,{onRemoved:removeCard});else card.append(button('取消收藏',async()=>{await toggleFavorite(a.id);removeCard();}));track.append(card);}body.append(section);if(global.ReadMedia)requestAnimationFrame(()=>global.ReadMedia.prepare(track));}}select.addEventListener('change',render);render();}
  function inlineNodes(text){const out=el('span');if(global.ReadInline)out.innerHTML=global.ReadInline.html(text);else out.textContent=text;return out;}
  function draftSelection(sel,body){
    if(!sel||sel.isCollapsed||!sel.rangeCount)return null;
    const range=sel.getRangeAt(0),node=range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;
    const block=node?.closest?.('[data-block-id]');
    if(!block||!body.contains(block))return null;
    const quote=range.toString().slice(0,2000);if(!quote.trim())return null;
    return {id:block.dataset.blockId,quote};
  }
  async function showDraft(item,host){host.disposeSelection?.();const epoch=state.epoch;const uid=state.user?.id;host.replaceChildren(el('p','正在读取私有稿件…'));const draft=await api('admin/drafts/'+encodeURIComponent(item.id));if(epoch!==state.epoch||uid!==state.user?.id)return;let content;try{content=JSON.parse(draft.body);}catch{content={blocks:[{id:'raw-body',kind:'paragraph',text:draft.body}]};}if(!Array.isArray(content.blocks))throw new Error('稿件格式不支持，请联系编辑核对。');host.replaceChildren();const title=el('h2',draft.title);const version=el('details',undefined,'member-version-details');version.append(el('summary','当前稿件版本'),el('code',draft.version_hash));const shell=el('div',undefined,'member-draft-layout'),body=el('div',undefined,'member-draft-body'),figures=el('div',undefined,'member-draft-figures'),form=el('div',undefined,'member-draft-feedback');const feedbackDetails=el('details',undefined,'member-feedback-details');feedbackDetails.append(el('summary','写审核意见 / 审核此版本'),form);let target={type:'article',id:item.id},selectedQuote='';const selection=el('p','意见范围：整篇');const comment=el('textarea');comment.placeholder='审核意见';comment.maxLength=10000;const status=el('p');status.setAttribute('data-member-status','');status.setAttribute('role','status');const recent=el('p','当前管理员登录有效，可连续审稿。审核结果仅对应当前版本，不会自动发布。');form.append(selection,comment,status,button('整篇意见',()=>{target={type:'article',id:item.id};selectedQuote='';selection.textContent='意见范围：整篇';}));form.append(button('保存意见',async()=>{if(!comment.value.trim())throw new Error('请先填写审核意见。');await api('admin/drafts/'+encodeURIComponent(item.id)+'/feedback',{version_hash:draft.version_hash,target,quote:selectedQuote,comment:comment.value});notify('意见已保存。');}));for(const [decision,label]of [['changes_requested','退回修改'],['approved','审核通过']])form.append(button(label,async()=>{await api('admin/drafts/'+encodeURIComponent(item.id)+'/reviews',{version_hash:draft.version_hash,decision,comment:comment.value});host.onReview?.(item.id,decision);notify('已记录此版本审核结果，未触发网站发布。');}));form.append(recent);
    const assets=new Map((draft.assets||[]).map(x=>[x.id,x]));for(const block of content.blocks){if(block.kind==='title')continue;const wrap=el('section',undefined,'block');wrap.dataset.blockId=block.id;let text;if(block.kind==='title')text=el('h1');else if(block.kind==='heading')text=el('h'+Math.min(4,Math.max(2,block.level||2)));else text=el('p');text.append(inlineNodes(block.text||''));wrap.append(text);if(block.kind==='figure'){const aid=content.asset_map?.[block.src];if(aid&&assets.has(aid)){const box=el('figure',undefined,'member-draft-figure'),img=el('img');img.src='/api/member/admin/drafts/'+encodeURIComponent(item.id)+'/assets/'+encodeURIComponent(aid);img.alt=block.text||'待审原图';box.append(img,el('figcaption',block.text||''),button('给这张图写意见',()=>{target={type:'figure',id:aid};selectedQuote='';selection.textContent='意见范围：图片 '+aid;feedbackDetails.open=true;comment.focus();}));figures.append(box);}else figures.append(el('p','图片尚未就绪：'+(block.src||'')));}body.append(wrap);}const captureSelection=()=>{if(epoch!==state.epoch||uid!==state.user?.id)return;const picked=draftSelection(getSelection(),body);if(!picked)return;selectedQuote=picked.quote;target={type:'paragraph',id:picked.id};selection.textContent='所选句子：'+selectedQuote;feedbackDetails.open=true;};let selectionTimer;const scheduleSelection=()=>{clearTimeout(selectionTimer);selectionTimer=setTimeout(captureSelection,200);};body.addEventListener('pointerup',scheduleSelection);body.addEventListener('keyup',scheduleSelection);document.addEventListener('selectionchange',scheduleSelection);host.disposeSelection=()=>{clearTimeout(selectionTimer);body.removeEventListener('pointerup',scheduleSelection);body.removeEventListener('keyup',scheduleSelection);document.removeEventListener('selectionchange',scheduleSelection);};const history=el('details');history.append(el('summary','已保存的审核意见'));for(const record of draft.feedback||[]){const note=el('div',undefined,'member-note');note.append(el('small',record.target_type+' · '+record.created_at),el('blockquote',record.quote||''),el('p',record.comment));history.append(note);}shell.append(body,figures);host.append(title,version,feedbackDetails,shell,history);host.scrollIntoView({block:"start",behavior:"smooth"});}
  function reviewAnchor(sel,root){
    if(!sel||sel.isCollapsed||!sel.rangeCount)return null;
    const range=sel.getRangeAt(0),node=range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement,block=node?.closest?.('[data-block-id]');
    if(!block||!root.contains(block)||block.querySelector('figure'))return null;
    const quote=range.toString();if(!quote.trim()||quote.length>2000)return null;
    const before=range.cloneRange();before.selectNodeContents(block);before.setEnd(range.startContainer,range.startOffset);const start=before.toString().length;
    return {blockId:block.dataset.blockId,start,end:start+quote.length,quote};
  }
  function reviewLocation(record,version,text,legacyText){
    if(record.version_hash!==version||record.target_type!=='paragraph'||!record.quote)return null;
    let anchor,legacy=false;try{anchor=JSON.parse(record.target_id);}catch{anchor={blockId:record.target_id};legacy=true;}
    if(!anchor||typeof anchor.blockId!=='string'||!anchor.blockId)return null;
    if(!legacy&&(!Number.isInteger(anchor.start)||!Number.isInteger(anchor.end)||anchor.start<0||anchor.end<=anchor.start))return null;
    if(Number.isInteger(anchor.start)&&Number.isInteger(anchor.end)&&anchor.start>=0&&anchor.end>anchor.start&&text.slice(anchor.start,anchor.end)===record.quote)return anchor;
    if(!legacy){const mapped=presentationAnchor(text,legacyText,anchor.start,anchor.end,record.quote);if(mapped)return {blockId:anchor.blockId,...mapped};}
    if(!legacy&&!/[*∗]/u.test(record.quote))return null;
    const exact=text.indexOf(record.quote);if(exact>=0&&text.indexOf(record.quote,exact+1)<0)return {blockId:anchor.blockId,start:exact,end:exact+record.quote.length};
    // A renderer repair can move literal Markdown/ligand stars. Only these marks
    // and whitespace may differ; stay in the same paragraph and require uniqueness.
    function normalized(value){const chars=[],positions=[];for(let i=0;i<value.length;i++){const c=value[i];if(/[\s*∗]/u.test(c))continue;chars.push(c);positions.push(i);}return {value:chars.join(''),positions};}
    const body=normalized(text),quote=normalized(record.quote);if(!quote.value)return null;
    const start=body.value.indexOf(quote.value);if(start<0||body.value.indexOf(quote.value,start+1)>=0)return null;
    return {blockId:anchor.blockId,start:body.positions[start],end:body.positions[start+quote.value.length-1]+1};
  }
  // CSS highlights do not create DOM elements; hit-test their visible rectangles.
  function mountHighlightNotes(root,getEntries,beforeOpen,onOpen){
    let down=null,viewer=null;
    const start=event=>{down={x:event.clientX,y:event.clientY};};
    const click=event=>{
      if(!down||Math.hypot(event.clientX-down.x,event.clientY-down.y)>6)return;
      const selection=global.getSelection?.();if(selection&&!selection.isCollapsed)return;
      const hits=getEntries().filter(({range})=>[...range.getClientRects()].some(r=>event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom));
      if(!hits.length)return;
      beforeOpen();if(onOpen){onOpen(hits);return;}viewer?.remove();viewer=el('section',undefined,'member-review-editor');viewer.setAttribute('aria-label','已保存的批注');
      viewer.append(el('strong','已保存的批注'));for(const hit of hits)viewer.append(el('blockquote',hit.quote),el('p',hit.note||'荧光笔标记'));
      viewer.append(closeAnnotationButton(()=>{viewer?.remove();viewer=null;}));document.body.append(viewer);positionAnnotationPopup(viewer,hits[0]?.range);
    };
    root.addEventListener('pointerdown',start);root.addEventListener('click',click);
    return ()=>{root.removeEventListener('pointerdown',start);root.removeEventListener('click',click);viewer?.remove();};
  }
  function mountReviewReader({articleId,revision,snapshot,assetUrl,root,toolbar,figureRoot,draft}){
    if(new URLSearchParams(location.search).has('version'))return mountHistoricReader({articleId,revision,snapshot,assetUrl,root,toolbar,draft});
    mountVersionHistory({articleId,revision,toolbar});
    mountArticleExport({articleId,revision,snapshot,assetUrl,toolbar,source:'draft'});
    const epoch=state.epoch,uid=state.user?.id,current=()=>state.epoch===epoch&&state.user?.id===uid&&!state.expired;
    const panel=el('section',undefined,'member-review-tools'),bar=el('div',undefined,'member-reader-actions'),details=el('section',undefined,'member-review-editor'),quote=el('blockquote'),input=el('textarea'),status=el('p'),list=el('div'),heading=el('strong','审核批注');
    list.className='member-review-history';input.placeholder='填写审核批注';input.setAttribute('aria-label','审核批注');input.maxLength=10000;status.setAttribute('data-member-status','');status.setAttribute('role','status');details.hidden=true;details.setAttribute('aria-label','审核批注');details.append(heading,quote,input,status);const history=el('details',undefined,'member-notes-panel');history.append(el('summary','已保存的审核批注'),list);panel.append(bar,history);toolbar.append(panel);document.body.append(details);
    let highlightedNotes=[],selecting=false,selected=null,figureTarget=null,timer,editing=null,busy=false,highlightEnabled=false,records=[...(draft.feedback||[])];const highlightsName='read-review-notes';
    const editable=record=>record&&record.id&&record.uid===uid&&record.version_hash===revision;
    function reset(){clearTimeout(timer);selected=null;figureTarget=null;editing=null;input.value='';status.textContent='';details.hidden=true;panel.classList.remove('has-selection');global.getSelection()?.removeAllRanges();}
    function openEditor(){if(!current())return;void global.ReadChrome?.closePanel();document.querySelectorAll('.member-review-editor').forEach(n=>{if(n!==details)n.hidden=true;});details.hidden=false;panel.classList.add('has-selection');const selection=global.getSelection?.();const range=selection&&!selection.isCollapsed&&selection.rangeCount?selection.getRangeAt(0):null;if(!range)details._annotationAnchor=null;positionAnnotationPopup(details,range);}
    function openExisting(record){if(!current()||busy)return;clearTimeout(timer);selected=null;figureTarget=null;editing=record;global.getSelection()?.removeAllRanges();quote.textContent=record.quote||'意见范围：整篇';input.value=record.comment==='荧光笔标记'?'':record.comment||'';const canEdit=editable(record);input.readOnly=!canEdit;saveNote.hidden=markOnly.hidden=!canEdit;heading.textContent=canEdit?'修改审核批注':'审核批注 · 只读';status.textContent=canEdit?'':'此条批注由其他审核者保存。';openEditor();positionAnnotationPopup(details,highlightedNotes.find(hit=>hit.record===record)?.range);}
    const disposeHighlightNotes=mountHighlightNotes(root,()=>highlightedNotes,()=>clearTimeout(timer),hits=>openExisting(hits[0].record));
    function capture(){if(!current()||busy)return;const found=reviewAnchor(global.getSelection(),root);if(!found)return;if(editing||selected?.quote!==found.quote||selected?.start!==found.start||selected?.blockId!==found.blockId)input.value='';editing=null;selected=found;figureTarget=null;quote.textContent=found.quote;heading.textContent='审核批注';input.readOnly=false;saveNote.hidden=markOnly.hidden=false;status.textContent='';openEditor();}
    const schedule=()=>{clearTimeout(timer);if(highlightEnabled&&!selecting&&!busy)timer=setTimeout(capture,250);};const beginSelection=()=>{selecting=true;clearTimeout(timer);};const endSelection=()=>{selecting=false;schedule();};
    function rangeAt(block,anchor){const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);let n,offset=0,start,end;while(n=walker.nextNode()){const next=offset+n.textContent.length;if(!start&&anchor.start>=offset&&anchor.start<next)start=[n,anchor.start-offset];if(anchor.end>offset&&anchor.end<=next){end=[n,anchor.end-offset];break;}offset=next;}if(!start||!end)return null;const r=document.createRange();r.setStart(...start);r.setEnd(...end);return r;}
    function paint(){list.replaceChildren();highlightedNotes=[];const ranges=[];for(const record of records.filter(r=>r.version_hash===revision)){const row=el('div',undefined,'member-note');row.append(el('blockquote',record.quote||'整篇意见'),el('p',record.comment));row.append(button(editable(record)?'查看 / 修改批注':'查看批注',()=>openExisting(record)));let blockId=record.target_id;try{blockId=JSON.parse(record.target_id).blockId;}catch{}const block=[...root.querySelectorAll('[data-block-id]')].find(n=>n.dataset.blockId===blockId);const anchor=block?reviewLocation(record,revision,block.textContent,legacyBlockText(snapshot,block.dataset.blockId)):null;if(anchor){const r=rangeAt(block,anchor);if(r){ranges.push(r);highlightedNotes.push({range:r,quote:record.quote,note:record.comment,record});}row.append(button('定位原文',()=>block.scrollIntoView({block:'center',behavior:'smooth'})));}list.append(row);}if(global.CSS?.highlights&&global.Highlight)CSS.highlights.set(highlightsName,new Highlight(...ranges));if(!list.children.length)list.append(el('p','此版本还没有审核批注。'));}
    async function save(highlightOnly){clearTimeout(timer);if(!current())throw Error('登录状态已变化，请重新打开稿件。');if(busy)return;if(editing&&!editable(editing))throw Error('此条批注只读。');if(!editing&&!selected)capture();if(highlightOnly&&!selected&&editing?.target_type!=='paragraph')throw Error('请先选择需要标黄的正文文字。');const comment=highlightOnly?(input.value.trim()||'荧光笔标记'):input.value.trim();if(!comment)throw Error('请填写审核批注，或使用荧光笔只标黄。');busy=true;saveNote.disabled=markOnly.disabled=true;input.readOnly=true;try{
      if(editing){const changed=await api('admin/drafts/'+encodeURIComponent(articleId)+'/feedback/'+encodeURIComponent(editing.id),{version_hash:revision,comment,edit_revision:editing.edit_revision||0},'PUT');if(!current())return;Object.assign(editing,changed);}
      else{const target=selected?{type:'paragraph',id:JSON.stringify({blockId:selected.blockId,start:selected.start,end:selected.end})}:figureTarget?{type:'figure',id:figureTarget}:{type:'article',id:articleId};const payload={version_hash:revision,target,quote:selected?.quote||'',comment},created=await api('admin/drafts/'+encodeURIComponent(articleId)+'/feedback',payload);if(!current())return;records.push({...created,uid,version_hash:revision,target_type:target.type,target_id:target.id,quote:payload.quote,comment,edit_revision:0});}
      reset();paint();notify('审核批注已保存。');
    }finally{busy=false;saveNote.disabled=markOnly.disabled=false;input.readOnly=false;}}
    const marker=button('荧光笔',()=>{highlightEnabled=!highlightEnabled;marker.setAttribute('aria-pressed',String(highlightEnabled));if(highlightEnabled)capture();else{clearTimeout(timer);selected=null;editing=null;details.hidden=true;panel.classList.remove('has-selection');}}),saveNote=button('保存批注',()=>save(false)),markOnly=button('仅标黄',()=>save(true));marker.setAttribute('aria-pressed','false');
    function freshTarget(target){reset();figureTarget=target;heading.textContent='审核批注';input.readOnly=false;saveNote.hidden=markOnly.hidden=false;quote.textContent=target?'意见范围：当前原图':'意见范围：整篇';openEditor();}
    bar.append(el('strong','审稿模式'),marker,button('写批注',()=>{capture();if(details.hidden)freshTarget(null);openEditor();input.focus({preventScroll:true});}),button('当前图片意见',()=>{const src=figureRoot?.querySelector('img')?.getAttribute('src')||'',id=decodeURIComponent(src.split('/').pop()||'');if(!(draft.assets||[]).some(a=>a.id===id))throw Error('当前图片尚未载入。');freshTarget(id);}),button('整篇意见',()=>freshTarget(null)));const allNotes=button('全部批注',()=>{if(global.ReadChrome?.openNotes)global.ReadChrome.openNotes(allNotes);else history.open=true;});allNotes.className='member-all-notes';details.append(saveNote,markOnly,allNotes,closeAnnotationButton(reset));
    const decisions=el('details',undefined,'member-review-decisions');decisions.append(el('summary','提交审核结果'));for(const [decision,label]of [['changes_requested','退回修改'],['approved','审核通过']])decisions.append(button(label,async()=>{if(!current())throw Error('登录状态已变化，请重新打开稿件。');await api('admin/drafts/'+encodeURIComponent(articleId)+'/reviews',{version_hash:revision,decision,comment:input.value.trim()});notify('此版本审核结果已保存，不会自动发布。',status);}));const publishStatus=el('p');publishStatus.setAttribute('data-member-status','');publishStatus.setAttribute('role','status');decisions.append(publishStatus);decisions.append(button('审核通过并发布',async()=>{if(!current())throw Error('登录状态已变化，请重新打开稿件。');publishStatus.textContent='正在发布…';const result=await api('admin/drafts/'+encodeURIComponent(articleId)+'/publish',{version_hash:revision});if(!current())return;notify(result.already_published?'此版本已发布，无需重复发布。':'发布成功，所有读者现在都可以阅读。',publishStatus);const link=el('a','查看已发布文章');link.href=readUrl(articleId);decisions.append(link);}));panel.append(decisions);
    root.addEventListener('pointerdown',beginSelection);document.addEventListener('pointerup',endSelection);document.addEventListener('pointercancel',endSelection);root.addEventListener('keyup',schedule);document.addEventListener('selectionchange',schedule);paint();
    const expire=()=>{disposeHighlightNotes();selected=null;input.value='';details.remove();panel.replaceChildren(el('p','登录状态已失效，请重新登录后继续审稿。'));global.CSS?.highlights?.delete(highlightsName);};document.addEventListener('read-members-expired',expire);
    return {refresh:paint,destroy(){disposeHighlightNotes();clearTimeout(timer);root.removeEventListener('pointerdown',beginSelection);document.removeEventListener('pointerup',endSelection);document.removeEventListener('pointercancel',endSelection);root.removeEventListener('keyup',schedule);document.removeEventListener('selectionchange',schedule);document.removeEventListener('read-members-expired',expire);global.CSS?.highlights?.delete(highlightsName);details.remove();panel.remove();}};
  }
  function reviewBucket(item){return item.review_status==='approved'?'completed':item.review_status==='proofreading'?'proofreading':'pending';}
  function reviewLink(id){const link=el('a','审阅此稿');link.href=readUrl(id)+'&review=1';link.target='_blank';link.rel='noopener';return link;}
  async function adminPage(root){root.append(el('h1','稿件审核'));if(state.user?.role!=='admin'){root.append(el('p','请使用具有审核权限的账号登录。'));return;}const result=await api('admin/drafts'),items=result.items||result;const tabs=el('div',undefined,'member-track-controls'),list=el('div'),host=el('div',undefined,'member-draft-view');root.append(tabs,list,host);let selected='pending';function render(){list.replaceChildren();tabs.replaceChildren();for(const [key,label]of [['pending','待审核'],['proofreading','待校对']]){const count=items.filter(i=>reviewBucket(i)===key).length;const tab=button(`${label}（${count}）`,()=>{selected=key;host.disposeSelection?.();host.replaceChildren();render();});tab.setAttribute('aria-pressed',String(selected===key));tabs.append(tab);}const rows=items.filter(i=>reviewBucket(i)===selected);for(const item of rows){const card=el('section',undefined,'member-review');const label=item.review_status==='changes_requested'?'待修改':selected==='completed'?'已审核':selected==='proofreading'?'待校对':'待审核';card.append(el('h2',item.title||item.id),el('p',`${item.published?'已发布':'未发布'} · ${label}`),reviewLink(item.id));list.append(card);}if(!rows.length)list.append(el('p',selected==='pending'?'暂无待审核稿件。':selected==='proofreading'?'暂无待校对稿件。':'暂无已完成稿件。'));}host.onReview=(id,status)=>{const item=items.find(i=>i.id===id);if(item)item.review_status=status;render();};render();}
  let resolveAuthReady;
  const authReady=new Promise(resolve=>{resolveAuthReady=resolve;});
  async function waitForReaderContent(){
    if(!global.ReadContentReady&&document.body?.classList?.contains('reader-preparing'))await new Promise(resolve=>document.addEventListener('read-content-ready',resolve,{once:true}));
    // Let the browser paint the restored text before starting private I/O.
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  }
  async function init(){
    // Render static links before the first network request; identity only follows a server response.
    const root=document.querySelector('[data-member-page]');let pageTask;const initEpoch=state.epoch;
    state.library=guestLoad();state.libraryReady=false;state.authStatus='loading';state.accountHint=typeof sessionCache==='undefined'?false:sessionCache.hint();refreshNavigation();
    try{
      const reader=typeof location!=='undefined'&&/\/read(?:\.html)?$/.test(location.pathname);
      const forceSession=Boolean(root&&['admin','account'].includes(root.dataset.memberPage))||(typeof location!=='undefined'&&new URLSearchParams(location.search).get('review')==='1');
      // Public text paints first. Private review must establish permission before
      // requesting a draft, so it deliberately takes the authenticated path.
      if(reader&&!forceSession)await waitForReaderContent();
      const cached=typeof sessionCache==='undefined'?null:sessionCache.peek();
      const needsContext=!forceSession&&(reader||root?.dataset.memberPage==='favorites')&&(!cached||cached.user);
      const context=needsContext?await loadReaderContext():null;
      const session=context?.session||await api('session',undefined,undefined,{force:forceSession});if(state.epoch!==initEpoch){resolveAuthReady(state);state.loaded=true;return state;}state.configured=Boolean(session.configured);state.user=session.user||null;state.accountHint=Boolean(session.user);state.adminNavHint=Boolean(session.cached?session.adminNavHint:session.user?.role==='admin');state.csrfToken=session.csrfToken||'';state.authStatus=session.cached?'cached':'ready';refreshNavigation();resolveAuthReady(state);
      if(root?.dataset.memberPage==='account')accountPage(root);
      if(root?.dataset.memberPage==='admin')pageTask=adminPage(root).catch(error=>notify(error.message));
      state.presentationFavoritesKnown=Array.isArray(session.favoriteIds);
      if(state.user){state.library={favorites:session.favoriteIds||[],annotations:[]};try{const navigationOnly=typeof location!=='undefined'&&['/','/index.html','/catalog'].includes(location.pathname)&&!root;if(context){state.readerContext=context;state.library=libraryFromContext(context);state.libraryReady=true;}else if(!navigationOnly){state.library=await remoteLoad();state.libraryReady=true;}}catch(error){notify('账号收藏与笔记暂时无法载入，可以继续阅读；请刷新重试。当前不会覆盖账号数据。');}}
      else state.libraryReady=true;
      if(state.libraryReady){state.presentationFavoritesKnown=true;if(typeof cachePublicFavorites==='function')cachePublicFavorites();}
    }catch(error){if(state.epoch!==initEpoch){resolveAuthReady(state);state.loaded=true;return state;}state.authStatus='error';state.accountHint=false;state.adminNavHint=false;state.user=null;state.configured=false;refreshNavigation();resolveAuthReady(state);}
    if(root){if(root.dataset.memberPage==='account'&&state.authStatus!=='ready')accountPage(root);if(root.dataset.memberPage==='favorites'&&!state.libraryReady){root.append(el('p','收藏尚未载入，请重试连接后查看。'),button('重试连接',()=>location.reload()));}if(root.dataset.memberPage==='favorites'&&state.libraryReady){try{let catalog;if(staticMode&&global.ReadPublished){catalog=await global.ReadPublished.catalog(new URL('catalog.json',scriptRoot).href);}else{const response=await fetch(staticMode?new URL('catalog.json',scriptRoot).href:'/api/catalog');if(!response.ok)throw Error();catalog=await response.json();}state.catalog=catalog.articles||[];setPublicCatalog(state.catalog);favoritesPage(root);global.ReadCardActions?.hydrate();}catch{root.append(el('p','文献目录暂时无法载入，请稍后刷新。'));}}if(pageTask)await pageTask;else if(root.dataset.memberPage==='admin')await adminPage(root);const privacy=el('details',undefined,'member-privacy');privacy.append(el('summary','数据与隐私'),el('p','游客收藏和笔记保存在当前浏览器。登录后的同步内容保存在本站账号服务；密码不写入浏览器存储。阅读笔记可能包含私人研究想法，请避免记录未公开敏感资料。'));if(state.user&&guestLoad().favorites.length+guestLoad().annotations.length>0)privacy.append(button('将本机游客数据合并到账号',async()=>{const old=state.library;state.library=mergeLibraries(old,guestLoad());try{await persist();localStorage.removeItem(KEY);location.reload();}catch(error){throw error;}}));root.append(privacy);}state.loaded=true;if(typeof sessionCache!=='undefined'&&sessionCache.peek()?.cached){const timer=setTimeout(()=>checkSession(),Math.max(1000,sessionCache.peek().cacheRemainingMs||30000));timer?.unref?.();}return state;}
  // Serialize writes per article and retain only the newest waiting position.
  function createProgressQueue(write) {
    const entries=new Map();
    return async function enqueue(id,value) {
      const existing=entries.get(id);
      if(existing){existing.pending=value;return existing.promise;}
      const entry={pending:value,promise:null};entries.set(id,entry);
      entry.promise=(async()=>{
        try{while(entry.pending){const next=entry.pending;entry.pending=null;await write(id,next);}}
        finally{if(entries.get(id)===entry)entries.delete(id);}
      })();
      return entry.promise;
    };
  }
  const progressRevisions=new Map(),progressTimers=new Map(),progressBlocked=new Set();
  const progressQueue=createProgressQueue(async(id,job)=>{
    const current=()=>!state.expired&&state.user?.id===job.uid&&state.epoch===job.epoch;
    if(!current()||progressBlocked.has(id))return;
    try{
      const remote=await api('progress/'+encodeURIComponent(id),{version_hash:job.hash,revision:progressRevisions.get(id)||0,position:job.position},'PUT');
      if(current())progressRevisions.set(id,remote.revision);
    }catch(error){
      if(!current())return;
      progressBlocked.add(id);
      notify(error.code==='progress_conflict'?'另一设备已更新阅读位置，请刷新后继续同步。':'阅读位置同步未完成，当前设备仍会保存位置；请刷新后重试同步。');
    }
  });
  function clearAccountMemory(){sessionCache.invalidate();readerContextFlight=null;libraryReadyFlight=null;state.readerContext=null;state.presentationFavoritesKnown=false;state.accountHint=false;state.adminNavHint=false;state.csrfToken='';state.libraryReady=false;state.epoch++;state.expired=true;document.querySelectorAll('[data-member-page]').forEach(n=>{n.replaceChildren(el('p','登录状态已变化，请刷新页面后继续。'));const a=el('a','重新登录');a.href=memberUrl('account');n.append(a);});document.querySelectorAll('.member-draft-view').forEach(n=>{n.querySelectorAll('img').forEach(img=>img.removeAttribute('src'));n.replaceChildren();});document.dispatchEvent(new CustomEvent('read-members-expired'));for(const timer of progressTimers.values())clearTimeout(timer);progressTimers.clear();progressRevisions.clear();progressBlocked.clear();state.user=null;state.authStatus='ready';refreshNavigation();document.querySelectorAll('[data-member-admin]').forEach(n=>n.remove());state.library={favorites:[],annotations:[]};serverLibrary={favorites:[],annotations:[]};if(global.CSS?.highlights)CSS.highlights.delete('read-member-notes');document.querySelectorAll('.member-note').forEach(n=>n.remove());document.dispatchEvent(new CustomEvent('read-members-change'));}
  async function loadProgress(id,hash,local,mode){
    if(!state.user||!hash)return local;
    const uid=state.user.id,epoch=state.epoch;
    const current=()=>!state.expired&&state.user?.id===uid&&state.epoch===epoch;
    try{const context=state.readerContext,remote=context?.session?.user?.id===uid&&context.article===id&&Object.hasOwn(context,'progress')?context.progress:await api('progress/'+encodeURIComponent(id));if(!current())return local;progressRevisions.set(id,remote?.revision||0);if(remote?.version_hash===hash&&remote.position?.version===1&&remote.position.article===id)return {...remote.position,mode:mode||remote.position.mode};return local;}
    catch(error){if(current()){progressBlocked.add(id);notify('阅读位置暂未同步，继续使用当前设备的位置；请刷新后重试同步。');}return local;}
  }
  function saveProgress(id,hash,position){
    if(!state.user||!hash||state.expired||progressBlocked.has(id))return;
    const job={hash,position:structuredClone(position),uid:state.user.id,epoch:state.epoch};
    clearTimeout(progressTimers.get(id));
    progressTimers.set(id,setTimeout(()=>{progressTimers.delete(id);void progressQueue(id,job);},1000));
  }
  let sessionChannel;
  function broadcastSession(){if(sessionChannel)sessionChannel.postMessage('session-change');try{localStorage.setItem('read-session-change',String(Date.now()));}catch{}}
  let sessionCheck=null;
  function checkSession(request=api){
    if(!state.loaded)return Promise.resolve();
    const epoch=state.epoch,uid=state.user?.id||null;
    if(sessionCheck&&sessionCheck.epoch===epoch&&sessionCheck.uid===uid)return sessionCheck.promise;
    const current=()=>state.epoch===epoch&&(state.user?.id||null)===uid;
    const job={epoch,uid,promise:null};
    job.promise=(async()=>{
      try{const fresh=await Promise.resolve().then(()=>request('session'));if(!current())return;if((fresh.user?.id||null)!==uid||(state.authStatus!=='cached'&&fresh.user?.role!==state.user?.role)){clearAccountMemory();location.reload();return;}state.csrfToken=fresh.csrfToken||'';if(state.authStatus==='cached'&&!fresh.cached){state.user=fresh.user||null;state.adminNavHint=fresh.user?.role==='admin';state.authStatus='ready';refreshNavigation();}}
      catch{if(current()&&state.user)clearAccountMemory();}
      finally{if(sessionCheck===job)sessionCheck=null;}
    })();
    sessionCheck=job;return job.promise;
  }
  function handleSessionSignal(){clearAccountMemory();Promise.resolve(global.ReadMembers?.ready).then(()=>checkSession());}
  if(typeof document!=='undefined'){if(typeof BroadcastChannel!=='undefined'){sessionChannel=new BroadcastChannel('read-session');sessionChannel.onmessage=handleSessionSignal;}window.addEventListener('storage',e=>{if(e.key==='read-session-change')handleSessionSignal();});window.addEventListener('focus',()=>checkSession());document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkSession();});}
  let annotationPositionFrame=0;
  function scheduleAnnotationPosition(){if(annotationPositionFrame)return;annotationPositionFrame=requestAnimationFrame(()=>{annotationPositionFrame=0;document.querySelectorAll('.member-review-editor:not([hidden])').forEach(popup=>positionAnnotationPopup(popup));});}
  if(typeof document!=='undefined'){global.addEventListener?.('resize',scheduleAnnotationPosition);global.addEventListener?.('scroll',scheduleAnnotationPosition,{passive:true});global.visualViewport?.addEventListener('resize',scheduleAnnotationPosition);}
  const exported={annotationPopupPosition,setPublicCatalog,ensureLibraryReady,createSessionCache,authReady,mountReviewReader,reviewAnchor,reviewLocation,reviewBucket,draftSelection,createProgressQueue,state,init,mountReader,mountNavigation,toggleFavorite,normalizeLibrary,mergeLibraries,resolveAnchor,loadProgress,saveProgress,validCaptchaReply,syncLibrary,validateImageChallenge,refreshAuthSession,passwordStrength,authenticationPayload,openAccount,shouldExpireSession,checkSession};global.ReadMembers=exported;if(typeof module!=='undefined')module.exports=exported;if(typeof document!=='undefined')exported.ready=init().catch(e=>notify(e.message));
})(typeof window!=='undefined'?window:globalThis);

