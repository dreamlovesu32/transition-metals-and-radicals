(function(global){
  'use strict';
  const endpoint='/api/member/public/articles';
  const validId=id=>typeof id==='string'&&/^[\w-]+$/.test(id);
  const validVersion=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  function asset(id,key,version){
    if(!validId(id)||!validId(key)||!validVersion(version))throw Error('公开图片信息无效');
    return `${endpoint}/${encodeURIComponent(id)}/assets/${encodeURIComponent(key)}?v=${version}`;
  }
  async function json(url,timeout=6000){const response=await fetch(url,{cache:'default',credentials:'omit',signal:AbortSignal.timeout(timeout)});if(!response.ok)throw Error('内容暂时无法载入');return response.json();}
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
  function catalog(staticUrl){
    if(!catalogTask)catalogTask=Promise.allSettled([json(staticUrl),json(endpoint)]).then(([base,live])=>{
      if(base.status==='rejected'&&live.status==='rejected')throw Error('文献目录暂时无法载入');
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
    const liveResult=liveTask.then(value=>({value}),()=>({value:null}));
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
    try{base=await baseTask;}catch{}
    if(!base){const live=await liveResult;if(live.value)return live.value;throw Error('文章尚未发布或暂时无法载入');}
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
  const api={asset,merge,catalog,read,validate};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else global.ReadPublished=api;
})(typeof window==='undefined'?globalThis:window);
