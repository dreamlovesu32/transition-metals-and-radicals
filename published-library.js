(function(global){
  'use strict';
  const endpoint='/api/member/public/articles';
  const validId=id=>typeof id==='string'&&/^[\w-]+$/.test(id);
  const validVersion=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  function asset(id,key,version){
    if(!validId(id)||!validId(key)||!validVersion(version))throw Error('公开图片信息无效');
    return `${endpoint}/${encodeURIComponent(id)}/assets/${encodeURIComponent(key)}?v=${version}`;
  }
  function failure(message,kind,code,status=0){return Object.assign(Error(message),{kind,code,status,publicMessage:message});}
  function failureMessage(error,fallback='内容暂时无法读取，当前页面已保留。'){
    if(typeof error?.publicMessage==='string')return error.publicMessage;
    if(error?.status===401||error?.kind==='identity')return '登录状态已变化，请使用当前账号完成验证。';
    if(error?.status===403)return '当前账号没有读取此内容的权限。';
    if(error?.kind==='version')return '内容版本已变化，本次读取已停止。';
    return fallback;
  }
  function reportReadFailure(error,scope='public-read'){
    const detail={scope,kind:error.kind||(error.status?'http':'application'),status:error.status||0,code:error.code||'unclassified'};
    if(global.CustomEvent&&typeof global.dispatchEvent==='function')global.dispatchEvent(new global.CustomEvent('read-operation-error',{detail}));
    global.console?.warn?.('Read request failed',detail);
  }
  async function retryRead(operation,current=()=>true,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
    for(let attempt=0;;attempt++){
      if(!current())throw failure('登录状态已变化，本次读取已停止。','identity','identity_changed');
      try{const value=await operation();if(!current())throw failure('登录状态已变化，本次读取已停止。','identity','identity_changed');return value;}
      catch(error){if(!current()||attempt>=2||!(['network','transport'].includes(error.kind)||[429,502,503,504].includes(error.status)))throw error;await wait([250,1000][attempt]);}
    }
  }
  async function json(url,timeout=6000,options={}){
    return retryRead(async()=>{
      let response;try{response=await fetch(url,{cache:'default',credentials:'omit',...options.fetchOptions,signal:AbortSignal.timeout(timeout)});}catch(error){if(['TypeError','AbortError','TimeoutError'].includes(error.name))error.kind=global.navigator?.onLine===false?'network':'transport';throw error;}
      if(!response.ok)throw failure(response.status===401?'请登录后读取此内容。':response.status===403?'当前账号没有读取此内容的权限。':'内容服务暂时无法完成读取，当前页面已保留。','http','read_http_'+response.status,response.status||0);
      try{return await response.json();}catch(error){throw failure('内容响应格式不正确，当前页面已保留。','application','invalid_json');}
    },options.current,options.wait);
  }
  function merge(base,live){
    const rows=new Map((base||[]).map(a=>[a.id,a]));
    for(const item of live||[]){
      if(!validId(item.id)||item.article?.id!==item.id||!validVersion(item.review_version_hash)||!item.asset_map?.cover)continue;
      const prior=rows.get(item.id)||{},a=item.article;
      const unchanged=prior.reviewVersion===item.review_version_hash;
      const media=unchanged?{}:{coverDisplay:undefined,coverPreview:undefined,coverWidth:undefined,coverHeight:undefined};
      rows.set(item.id,{...prior,...a,...media,public:true,title:a.title?.zh||item.title,cover:unchanged?prior.cover:asset(item.id,item.asset_map.cover,item.review_version_hash),reviewStatus:prior.reviewStatus==='proofreading'?'proofreading':'approved',updatedAt:unchanged?prior.updatedAt:item.published_at,firstPublishedOn:a.firstPublishedOn||prior.firstPublishedOn,version_hash:item.version_hash,reviewVersion:item.review_version_hash});
    }
    return [...rows.values()];
  }
  let catalogTask;
  function catalog(staticUrl,{refresh=false}={}){
    if(refresh)catalogTask=null;
    if(!catalogTask)catalogTask=Promise.allSettled([json(staticUrl),json(endpoint)]).then(([base,live])=>{
       if(base.status==='rejected'&&live.status==='rejected')throw live.reason;
      return {articles:merge(base.status==='fulfilled'?base.value.articles:[],live.status==='fulfilled'?live.value.items:[])};
    }).catch(e=>{catalogTask=null;throw e;});
    return catalogTask;
  }
  function validate(snapshot,id){
    if(snapshot?.id!==id||snapshot.article?.id!==id||!Array.isArray(snapshot.blocks)||!validVersion(snapshot.review_version_hash)||!validVersion(snapshot.version_hash))throw Error('公开文章信息无效');
    for(const b of snapshot.blocks)if(b.kind==='figure')asset(id,snapshot.asset_map?.[b.src],snapshot.review_version_hash);
    return {...snapshot,cloudPublished:true};
  }
  async function read(id,staticUrl){
    if(!validId(id))throw Error('文章编号无效');
    let cached;
    try{const stored=JSON.parse(global.sessionStorage?.getItem('read-public-v1:'+id)||'null');if(stored)cached=validate(stored,id);}catch{}
    let staticCached;
    try {
      const stored=JSON.parse(global.sessionStorage?.getItem('read-public-static-v1:'+id)||'null');
      if(stored?.article?.id===id && Array.isArray(stored.blocks) && validVersion(stored.version_hash) && !stored.cloudPublished)staticCached=stored;
    }catch{}
    const liveTask=json(`${endpoint}/${encodeURIComponent(id)}`).then(value=>{
      const checked=validate(value,id);
      try{global.sessionStorage?.setItem('read-public-v1:'+id,JSON.stringify(checked));}catch{}
      return checked;
    });
    // Attach rejection immediately; a static page can finish before the live request.
    const liveResult=liveTask.then(value=>({value}),error=>({value:null,error}));
    // Retain the static asset route for the same reviewed version. A live
    // background check must not turn the next visit into dynamic image requests.
    const sameStatic=staticCached&&(!cached||staticCached.version_hash===cached.version_hash);
    const baseTask=sameStatic?Promise.resolve(staticCached):json(staticUrl).then(value=>{
      if(value.article?.id!==id||!Array.isArray(value.blocks))throw Error('公开文章信息无效');
      if(cached && cached.version_hash!==value.version_hash)return cached;
      if(validVersion(value.version_hash))try{global.sessionStorage?.setItem('read-public-static-v1:'+id,JSON.stringify(value));}catch{}
      return value;
    }).catch(error=>{if(cached)return cached;throw error;});
    let base;
    let baseError;try{base=await baseTask;}catch(error){baseError=error;}
    if(!base){const live=await liveResult;if(live.value)return live.value;throw live.error||baseError||failure('文章尚未发布或暂时无法载入。','http','not_found',404);}
    // Immediately display verified cache/static content. Network revalidation is
    // independent of the reading path and never delays a warm page.
    // Never replace a document underneath an active selection or saved annotation.
    liveResult.then(({value})=>{
      if(value&&value.version_hash!==base.version_hash&&typeof global.dispatchEvent==='function'){
        global.dispatchEvent(new CustomEvent('read-public-update',{detail:{id}}));
      }
    });
    return base;
  }
  const api={asset,merge,catalog,read,validate,json,retryRead,failureMessage,reportReadFailure};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else global.ReadPublished=api;
})(typeof window==='undefined'?globalThis:window);
