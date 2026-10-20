const {test}=require('node:test');
const assert=require('node:assert/strict');
const path='../public-site/published-library.js';
const version='a'.repeat(64);
const snapshot={id:'new-paper',article:{id:'new-paper',title:{zh:'新文章'}},version_hash:version,review_version_hash:version,blocks:[{kind:'figure',src:'figure1'}],asset_map:{cover:'cover',figure1:'fig1'}};
function fresh(routes){
  delete require.cache[require.resolve(path)];
  global.fetch=async url=>({ok:Object.hasOwn(routes,url),json:async()=>routes[url]});
  return require(path);
}
test('cloud-only publication appears in catalog and can be read without static export',async()=>{
  const api=fresh({'/catalog.json':{articles:[]},'/api/member/public/articles':{items:[snapshot]},'/api/member/public/articles/new-paper':snapshot});
  const catalog=await api.catalog('/catalog.json');
  assert.equal(catalog.articles[0].id,'new-paper');
  assert.match(catalog.articles[0].cover,/assets\/cover\?v=/);
  assert.equal((await api.read('new-paper','/missing.json')).cloudPublished,true);
});
test('published cloud revision replaces static entry without duplicating it',()=>{
  const api=fresh({});
  const rows=api.merge([{id:'new-paper',title:'旧版',firstPublishedOn:'2026-01-01'}],[snapshot]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].title,'新文章');
  assert.equal(rows[0].firstPublishedOn,'2026-01-01');
});
test('static content remains available when cloud service fails',async()=>{
  const staticDoc={article:{id:'old-paper'},blocks:[]};
  const api=fresh({'/catalog.json':{articles:[{id:'old-paper'}]},'/old.json':staticDoc});
  assert.equal((await api.catalog('/catalog.json')).articles[0].id,'old-paper');
  assert.deepEqual(await api.read('old-paper','/old.json'),staticDoc);
  await assert.rejects(api.read('pending','/missing.json'));
});
test('wrong identities, unbound pictures and path traversal are rejected',()=>{
  const api=fresh({});
  assert.throws(()=>api.validate(snapshot,'different'));
  assert.throws(()=>api.validate({...snapshot,asset_map:{}},snapshot.id));
  assert.throws(()=>api.asset(snapshot.id,'../private',version));
  assert.throws(()=>api.asset(snapshot.id,'cover','stale'));
});
test('slow publication service does not block static reading and late revision is announced, not swapped',async()=>{
  delete require.cache[require.resolve(path)];
  let release;const events=[];
  const base={article:{id:snapshot.id},blocks:[],version_hash:'b'.repeat(64)};
  global.fetch=async url=>url==='/static.json'?{ok:true,json:async()=>base}:
    new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>snapshot});});
  global.dispatchEvent=event=>events.push(event);
  try{
    const api=require(path);
    const shown=await api.read(snapshot.id,'/static.json');
    assert.equal(shown,base);
    release();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(shown.version_hash,'b'.repeat(64));
    assert.equal(events.length,1);assert.equal(events[0].type,'read-public-update');
    assert.equal(events[0].detail.id,snapshot.id);
  }finally{delete global.dispatchEvent;}
});


test('same-version live validation preserves static originals across navigation without another static fetch',async()=>{
 const values=new Map();global.sessionStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
 const base={article:{id:snapshot.id},blocks:[],version_hash:version};let urls=[];
 try{
  const api=fresh({'/static.json':base,'/api/member/public/articles/new-paper':snapshot});
  assert.equal(await api.read(snapshot.id,'/static.json'),base);await new Promise(r=>setImmediate(r));
  global.fetch=async url=>{urls.push(url);if(url==='/static.json')throw Error('must be cached');return {ok:true,json:async()=>snapshot};};
  const next=await api.read(snapshot.id,'/static.json');assert(!next.cloudPublished);assert.equal(next.version_hash,version);assert.deepEqual(urls,['/api/member/public/articles/new-paper']);
 }finally{delete global.sessionStorage;}
});

test('newly published cloud version wins over an older static cache and private or missing articles never become static',async()=>{
 const values=new Map();global.sessionStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
 const old={article:{id:snapshot.id},blocks:[],version_hash:'b'.repeat(64)};
 values.set('read-public-static-v1:'+snapshot.id,JSON.stringify(old));values.set('read-public-v1:'+snapshot.id,JSON.stringify(snapshot));
 try{
  const api=fresh({'/static.json':old,'/api/member/public/articles/new-paper':snapshot});
  assert.equal((await api.read(snapshot.id,'/static.json')).cloudPublished,true);
  await assert.rejects(api.read('pending-private','/missing.json'));
  assert(!values.has('read-public-static-v1:pending-private'));
 }finally{delete global.sessionStorage;}
});


test('late live revision is cached for the next visit without replacing a current static document',async()=>{
 const values=new Map();global.sessionStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
 const old={article:{id:snapshot.id},blocks:[],version_hash:'b'.repeat(64)};const events=[];
 values.set('read-public-static-v1:'+snapshot.id,JSON.stringify(old));
 global.dispatchEvent=e=>events.push(e);
 try{
  const api=fresh({'/old.json':old,'/api/member/public/articles/new-paper':snapshot});
  const shown=await api.read(snapshot.id,'/old.json');assert.equal(shown.version_hash,old.version_hash);assert(!shown.cloudPublished);
  await new Promise(r=>setImmediate(r));assert.equal(events[0].type,'read-public-update');
  const next=await api.read(snapshot.id,'/old.json');assert.equal(next.version_hash,version);assert.equal(next.cloudPublished,true);
  assert.equal(shown.version_hash,old.version_hash);
 }finally{delete global.sessionStorage;delete global.dispatchEvent;}
});
