const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'members.js'),'utf8');
test('whole-article feedback carries the draft ID and exact reviewed version, including after changing target',async()=>{
  const nodes=[],calls=[];
  class Node{constructor(tag,text){this.tag=tag;this.textContent=text;this.children=[];this.dataset={};this.value='';nodes.push(this);}append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}setAttribute(){}addEventListener(){}scrollIntoView(){}focus(){}}
  const draft={title:'Test',version_hash:'version-123',body:JSON.stringify({blocks:[{id:'fig-1',kind:'figure',src:'image',text:'Figure'}],asset_map:{image:'asset-1'}}),assets:[{id:'asset-1'}],feedback:[]};
  const context={document:{addEventListener(){},removeEventListener(){}},state:{epoch:1,user:{id:'admin'}},el:(t,s)=>new Node(t,s),button:(t,fn)=>{const n=new Node('button',t);n.run=fn;return n;},inlineNodes:()=>new Node('span'),memberUrl:()=>'/account',notify:()=>{},api:async(url,body)=>{if(body){calls.push({url,body});return {};}return draft;}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  async function showDraft('),source.indexOf('  async function adminPage('))+';this.show=showDraft;',context);
  await context.show({id:'draft-test'},new Node('div'));
  nodes.find(n=>n.tag==='textarea').value='test comment';
  const click=t=>nodes.find(n=>n.tag==='button'&&n.textContent===t).run();
  await click('保存意见');await click('给这张图写意见');await click('整篇意见');await click('保存意见');
  assert.equal(calls.length,2);
  for(const {url,body} of calls){assert.equal(url,'admin/drafts/draft-test/feedback');assert.equal(body.target.type,'article');assert.equal(body.target.id,'draft-test');assert.equal(body.version_hash,'version-123');assert.equal(body.comment,'test comment');}
});
