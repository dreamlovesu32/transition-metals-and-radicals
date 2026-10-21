const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const tool=require('../member-system/article-export.js');
const sample=[{id:'t',kind:'title',text:'Title'},{id:'p',kind:'paragraph',text:'产物 **1** 与 **L*6** 在 25 °C、10 mol% 条件下转化。原DOI [10.1/example](https://doi.org/10.1/example)'},{id:'f1',kind:'figure',src:'figures/scheme-1.png',text:'图式2：原文衍生化。'},{id:'h',kind:'heading',text:'第二节'},{id:'f2',kind:'figure',src:'figures/figure-2A.png',text:'图2A：转化。'},{id:'f3',kind:'figure',src:'figures/scheme-1.png',text:'图式2：重复便于阅读。'}];

test('rich export has explicit dark prose and inline chemistry, only links use a reserved link color',()=>{
 const html=tool.render(sample,new Map(),{placeholders:true,footer:true});
 assert(html.includes('color:#20262d'));assert(html.includes('text-align:justify'));assert(html.includes('text-autospace:no-autospace'));
 for(const match of html.matchAll(/<(p|h[234]|strong|em|sub|sup|code)(\s[^>]*)?>/g))assert(match[2]?.includes('color:#20262d')||match[2]?.includes('color:#444')||match[2]?.includes('color:#536579'),match[0]);
 assert(html.includes('href="https://doi.org/10.1/example"'));assert(!html.includes('<h1'));assert.equal(tool.plainText(html).split(tool.SLOGAN).length-1,1);
 const plain=tool.plainText(html);assert(plain.includes('L*6'));assert(plain.includes('25 °C'));assert(plain.includes('10 mol%'));assert(!plain.includes('Title'));
});

test('figure insertion order is independent of original and caption numbering, including repeat images and per-part reset',()=>{
 const plan=tool.figurePlan(sample);assert.deepEqual(plan.map(x=>x.number),['01','02','03']);assert.equal(plan[0].reference,'原文图式1｜文中图式2');assert.equal(plan[0].stem,'01-图式1');assert.equal(plan[2].stem,'03-图式1');
 const parts=tool.split(sample.slice(1),['h']);assert.deepEqual(tool.figurePlan(parts[1].blocks).map(x=>x.number),['01','02']);
 const html=tool.render(sample,new Map(),{placeholders:true});assert.equal((html.match(/data-export-placeholder=/g)||[]).length,3);assert(!html.includes('<img'));assert(html.includes('01-图式1'));assert(html.includes('原文图式1｜文中图式2'));
 const unknown=tool.figurePlan([{src:'figures/scheme-mechanism.png',kind:'figure',text:'图式1：机理'}])[0];assert.equal(unknown.reference,'文中图式1');assert(!unknown.reference.includes('原文'));
});

test('canonical reading URL has no publisher, review token or historical query; pending exports retain a future URL hint',()=>{
 const url=tool.readingUrl('sample-paper');assert.equal(url,'https://metalradical.xyz/read.html?article=sample-paper');assert.throws(()=>tool.readingUrl('../private'));
 const html=tool.documentHtml('标题',tool.render(sample,new Map(),{placeholders:true,footer:true}),{url,published:false});
 assert(html.includes('本文尚未发布，链接发布后可访问'));assert(html.includes('复制阅读原文链接'));assert(!html.includes('Ctrl+C'));assert(!html.includes('canvas'));
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1],ctx={};vm.createContext(ctx);vm.runInContext(script+';this.saved=exportData;',ctx);
 assert.equal(ctx.saved.url,url);assert(ctx.saved.body.html.includes('<p'));assert(ctx.saved.body.text.endsWith(tool.SLOGAN));assert(ctx.saved.body.text.includes('L*6'));
 const attack=tool.documentHtml('</script><img src=x>','<p>safe</p>');assert.equal((attack.match(/<script>/g)||[]).length,1);
});

test('ClipboardItem write starts synchronously in the user click and carries both HTML and true plaintext',async()=>{
 let calls=0,resolve;const pending=new Promise(r=>resolve=r);let item;
 const env={Blob,ClipboardItem:class{constructor(values){this.values=values;}},navigator:{clipboard:{write:items=>{calls++;item=items[0];return pending;}}}};
 const html=tool.render(sample,new Map(),{placeholders:true,footer:true}),text=tool.plainText(html),job=tool.copyPayload({html,text},env);
 assert.equal(calls,1);assert.equal(await item.values['text/html'].text(),html);assert.equal(await item.values['text/plain'].text(),text);resolve();assert.equal(await job,'rich');
});

test('clipboard refusal never reports plaintext as rich success and identity loss is rejected before writing',async()=>{
 let calls=0;const env={Blob,ClipboardItem:class{},navigator:{clipboard:{write:async()=>{calls++;throw Error('denied');}}}};
 await assert.rejects(tool.copyPayload({html:'<p>x</p>',text:'x'},env),/复制未完成/);assert.equal(calls,1);
 await assert.rejects(tool.copyPayload({html:'<p>x</p>',text:'x',isCurrent:()=>false},env),/身份/);assert.equal(calls,1);
 let text='';assert.equal(await tool.copyPayload({text:'L*6 25 °C'}, {navigator:{clipboard:{writeText:async value=>{text=value;}}}}),'text');assert.equal(text,'L*6 25 °C');
});

test('automatic copy-event fallback succeeds only after it writes both rich and plain MIME data',async()=>{
 const saved={};let listener;
 const node={style:{},setAttribute(){},focus(){},remove(){}};
 const doc={body:{append(){}},createElement:()=>node,createRange:()=>({selectNodeContents(){}}),addEventListener:(type,fn)=>listener=fn,removeEventListener(){},execCommand(){listener({preventDefault(){},clipboardData:{setData:(type,value)=>saved[type]=value}});return true;}};
 const env={document:doc};assert.equal(await tool.copyPayload({html:'<p>L*6</p>',text:'L*6'},env),'rich-fallback');assert.deepEqual(saved,{'text/html':'<p>L*6</p>','text/plain':'L*6'});
 doc.execCommand=()=>true;await assert.rejects(tool.copyPayload({html:'<p>x</p>',text:'x'},env),/复制未完成/);
});

test('UTF8 image filenames are exact ZIP entries and paths outside the editorial bundle remain blocked',async()=>{
 const blob=tool.zip([['day-01/images/01-图式1.png',new Uint8Array([1,2,3])],['day-01/cover.png',new Uint8Array([4])]]),bytes=new Uint8Array(await blob.arrayBuffer());
 assert.equal(new DataView(bytes.buffer).getUint16(6,true),0x800);assert(new TextDecoder().decode(bytes).includes('day-01/images/01-图式1.png'));
 for(const name of ['../private.pdf','day-01/../../private.pdf','source/notes.json','day-01/images/01-图式1.png/child'])assert.throws(()=>tool.zip([[name,'x']]));
});

class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.handlers={};this.style={};this._text='';this._html='';this.disabled=false;this.checked=false;}
 append(...nodes){this.children.push(...nodes);nodes.forEach(n=>{if(n&&typeof n==='object')n.parentElement=this;});}
 replaceChildren(...nodes){this.children=[];this._text='';this._html='';this.append(...nodes);}
 set textContent(value){this._text=String(value);this._html='';this.children=[];}
 get textContent(){return this._text+this._html.replace(/<[^>]*>/g,'').replace(/&quot;/g,'"').replace(/&#42;/g,'*').replace(/&amp;/g,'&')+this.children.map(n=>n.textContent||'').join('');}
 set innerHTML(value){this._html=value;this._text='';this.children=[];}
 get innerHTML(){return this._html;}
 setAttribute(k,v){this.attrs[k]=String(v);}
 addEventListener(k,fn){(this.handlers[k]||=[]).push(fn);}
 async fire(type){for(const fn of this.handlers[type]||[])await fn({currentTarget:this});}
 querySelectorAll(selector){const choices=selector.split(',');const all=[];const visit=node=>{for(const child of node.children){if(choices.some(q=>q==='button'&&child.tagName==='button'||q==='input'&&child.tagName==='input'||q==='input:checked'&&child.tagName==='input'&&child.checked||q==='[data-export-status]'&&Object.hasOwn(child.dataset,'exportStatus')))all.push(child);visit(child);}};visit(this);return all;}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
}
async function mountHarness(source='draft',options={}){
 const previous={document:global.document,location:global.location,fetch:global.fetch,ClipboardItem:global.ClipboardItem,setTimeout:global.setTimeout,ReadToast:global.ReadToast,navigator:Object.getOwnPropertyDescriptor(global,'navigator')},oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
 const doc={createElement:tag=>new Element(tag),addEventListener(){},removeEventListener(){}};global.document=doc;global.location=new URL('https://example.org/read');global.fetch=()=>{throw Error('copy must not download images');};
 let written,valid=true,downloadBlob,downloadName;const imageRequests=[],notices=[];global.ReadToast={show:value=>notices.push(value)};if(options.downloads){global.setTimeout=fn=>{fn();return 0;};URL.createObjectURL=blob=>{downloadBlob=blob;return 'blob:fixture';};URL.revokeObjectURL=()=>{};global.fetch=async url=>{imageRequests.push(String(url));if(options.assetStatus&&imageRequests.length===1)return {ok:false,status:options.assetStatus};return {ok:true,headers:{get:()=> 'image/png'},arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer};};doc.createElement=tag=>{const element=new Element(tag);if(tag==='a')element.click=()=>{downloadName=element.download;};return element;};}global.ClipboardItem=class{constructor(values){this.values=values;}};Object.defineProperty(global,'navigator',{configurable:true,value:{clipboard:{write:async items=>{written=items[0];},writeText:async text=>{written=text;}}}});
 const revision='a'.repeat(64),snapshot={article:{id:'sample-paper',title:{zh:'标题'},kind:'research'},blocks:sample,version_hash:'c'.repeat(64),review_version_hash:options.expectedReview},calls=[];
 const saved={...snapshot,content_hash:source==='draft-content'?'c'.repeat(64):revision,version_hash:options.serverReview||revision,title:'标题',plan:options.plan||null,asset_map:{cover:'cover.png','figures/scheme-1.png':'scheme.png','figures/figure-2A.png':'figure.png'}};
 const toolbar=new Element('div');const api=async(path,body,method='GET')=>{calls.push({path,body,method});if(options.saveFailure&&method==='PUT')throw Object.assign(Error('内部应用错误'),{kind:'http',status:500,code:'internal_error'});if(options.readFailure&&method==='GET')throw options.readFailure;return options.finalMismatch&&imageRequests.length?{...saved,version_hash:'changed'}:saved;};
 const node=await tool.mount({articleId:'sample-paper',revision:source==='draft-content'?'c'.repeat(64):revision,snapshot,toolbar,source,api,isCurrent:()=>valid,metadata:{},assetUrl:src=>'/'+src,coverUrl:'/cover.png'});node.open=true;await node.fire('toggle');await new Promise(r=>setImmediate(r));
 const buttons=()=>node.querySelectorAll('button'),find=label=>buttons().find(b=>b.textContent===label);
 return {node,calls,find,saved,imageRequests,notices,get downloadBlob(){return downloadBlob;},get downloadName(){return downloadName;},get written(){return written;},expire(){valid=false;},restore(){URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;for(const [key,value]of Object.entries(previous)){if(key==='navigator'){if(value)Object.defineProperty(global,key,value);else delete global.navigator;}else if(value===undefined)delete global[key];else global[key]=value;}}};
}

test('actual mounted current/history/workbench export has one download action and keeps copying inside the package',async()=>{
 for(const source of ['draft','history','draft-content']){
  const h=await mountHarness(source);try{
   assert(h.find('下载素材包'));assert(!h.find('复制排版正文'));assert(!h.find('复制纯文本'));assert(!h.find('复制标题'));assert(!h.find('复制阅读原文链接'));
   assert(h.calls.every(c=>c.method==='GET'));assert(h.calls.every(c=>c.path.includes(source==='history'?'source=history':'source=draft')));
   if(source==='history')assert(!h.find('保存分篇方案'));
   h.expire();await h.find('下载素材包').fire('click');assert(h.notices.some(n=>n.message.includes('身份已变化')));assert.equal(h.written,undefined);
  }finally{h.restore();}
 }
});

function unzipStored(blob){return blob.arrayBuffer().then(buffer=>{const bytes=new Uint8Array(buffer),view=new DataView(buffer),files=new Map();let offset=0;while(view.getUint32(offset,true)===0x04034b50){const size=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extra=view.getUint16(offset+28,true),start=offset+30+nameLength+extra;files.set(new TextDecoder().decode(bytes.slice(offset+30,offset+30+nameLength)),bytes.slice(start,start+size));offset=start+size;}return files;});}

test('real download creates complete full or selected-part bundles with independent covers and final version checks',async()=>{
 for(const source of ['draft','history','draft-content']){
  const h=await mountHarness(source,{downloads:true,plan:{starts:['h']}});try{
   await h.find('下载素材包').fire('click');assert(h.downloadBlob);assert.equal(h.downloadName,'sample-paper-full.zip');
   const files=await unzipStored(h.downloadBlob),decode=name=>new TextDecoder().decode(files.get(name));
   assert(files.has('day-01/cover.png'));assert(files.has('day-01/images/01-图式1.png'));assert(files.has('day-01/images/03-图式1.png'));
   const full=decode('day-01/body.html');assert(full.includes('复制排版正文'));assert(full.includes('复制标题'));assert(full.includes('复制阅读原文链接'));assert(full.includes('data-export-placeholder'));assert(full.includes('font-size:12pt;'));assert(full.includes('25 °C'));assert(full.includes('10 mol%'));
   assert.equal(h.imageRequests.length,3,'two unique figure assets plus cover');assert.equal(JSON.parse(decode('manifest.json')).parts.length,1);
   const second=h.node.querySelectorAll('button').find(b=>b.textContent.startsWith('第2篇 /'));assert(second);await second.fire('click');await h.find('下载素材包').fire('click');
   assert.equal(h.downloadName,'sample-paper-part-02.zip');const secondFiles=await unzipStored(h.downloadBlob),secondHtml=new TextDecoder().decode(secondFiles.get('day-02/body.html'));
   assert(!secondHtml.includes('data-export-citation'),'part 2 first prose is not the original citation');assert(secondHtml.includes('（2/2）'));assert(secondFiles.has('day-02/cover.png'));assert(!secondFiles.has('day-01/body.html'));
   const puts=h.calls.filter(c=>c.method==='PUT');assert.equal(puts.length,source==='history'?0:2);
  }finally{h.restore();}
 }
 const h=await mountHarness('draft',{downloads:true,finalMismatch:true});try{await h.find('下载素材包').fire('click');assert.equal(h.downloadBlob,undefined);assert(h.notices.some(n=>n.message.includes('已停止导出')));}finally{h.restore();}
});

test('published review hash must match even when its body hash is unchanged, so new pictures cannot replace cached viewed pictures',async()=>{
 const h=await mountHarness('published',{expectedReview:'old-review',serverReview:'new-review'});try{assert(!h.find('复制排版正文'));assert(h.notices.some(n=>n.message.includes('版本已更新')));assert(!h.find('重新载入'));assert.equal(h.calls.length,1);}finally{h.restore();}
});

test('12pt citation styling follows only original opening ids across whole and chapter exports',()=>{
 const blocks=[{id:'title',kind:'title',text:'Title'},{id:'citation',kind:'paragraph',text:'Authors. Journal 2026. Verified citation.'},{id:'doi',kind:'paragraph',text:'DOI: 10.1234/test'},{id:'intro',kind:'paragraph',text:'Normal introduction.'},{id:'section',kind:'heading',text:'Later section'},{id:'later',kind:'paragraph',text:'Later first paragraph.'}];
 const frozen=JSON.stringify(blocks),ids=tool.citationBlockIds(blocks);assert.deepEqual(ids,['citation','doi']);
 const full=tool.render(blocks,new Map(),{citationIds:ids});assert.equal((full.match(/data-export-citation/g)||[]).length,2);assert.equal((full.match(/font-size:12pt/g)||[]).length,2);assert(full.includes('font-size:16px;">Normal introduction.'));
 const parts=tool.split(blocks,['section']);assert.equal((tool.render(parts[0].blocks,new Map(),{citationIds:ids}).match(/data-export-citation/g)||[]).length,2);assert(!tool.render(parts[1].blocks,new Map(),{citationIds:ids}).includes('font-size:12pt'));
 assert.deepEqual(tool.exportGroups(blocks,['section'],'parts').map(g=>g.index),[0,1]);assert.equal(tool.exportGroups(blocks,['section'],'1')[0].part.blocks.at(-1).id,'later');assert.throws(()=>tool.exportGroups(blocks,['section'],'9'));
 assert.equal(JSON.stringify(blocks),frozen);
});

test('read-only recovery is bounded and classifies transport, service, permission, and application failures exactly',async()=>{
 for(const error of [Object.assign(Error('offline'),{kind:'network'}),Object.assign(Error('busy'),{kind:'http',status:503})]){let calls=0;const waits=[];assert.equal(await tool.recoverRead(()=>{if(++calls<3)throw error;return 'ok';},()=>true,async ms=>waits.push(ms)),'ok');assert.equal(calls,3);assert.deepEqual(waits,[250,1000]);}
 for(const error of [Object.assign(Error('server bug'),{status:500,kind:'http'}),Object.assign(Error('forbidden'),{status:403,kind:'http'}),Object.assign(Error('version'),{kind:'version'}),new TypeError('programming error')]){let calls=0;await assert.rejects(tool.recoverRead(()=>{calls++;throw error;},()=>true,async()=>{}),e=>e===error);assert.equal(calls,1);}
 let calls=0;await assert.rejects(tool.recoverRead(()=>{calls++;throw Object.assign(Error('offline'),{kind:'network'});},()=>true,async()=>{}));assert.equal(calls,3);
 let current=true;calls=0;await assert.rejects(tool.recoverRead(()=>{calls++;throw Object.assign(Error('offline'),{kind:'network'});},()=>current,async()=>{current=false;}),/身份已变化/);assert.equal(calls,1);
});

test('a temporary asset service failure recovers in place while a 500 plan write preserves user input without replay',async()=>{
 const h=await mountHarness('draft',{downloads:true,assetStatus:503});try{const title=h.node.querySelectorAll('input')[0];title.value='保留用户标题';await h.find('下载素材包').fire('click');assert(h.downloadBlob);assert.equal(h.imageRequests.length,4);assert.equal(h.node.querySelectorAll('input')[0],title);assert.equal(title.value,'保留用户标题');assert(h.notices.some(n=>n.message.startsWith('已下载')));}finally{h.restore();}
 const failed=await mountHarness('draft',{downloads:true,saveFailure:true});try{const title=failed.node.querySelectorAll('input')[0];title.value='不丢失的标题';await failed.find('下载素材包').fire('click');assert.equal(failed.calls.filter(c=>c.method==='PUT').length,1);assert.equal(failed.imageRequests.length,0);assert.equal(failed.downloadBlob,undefined);assert.equal(title.value,'不丢失的标题');assert.equal(failed.node.querySelectorAll('input')[0],title);assert(failed.notices.some(n=>n.kind==='error'&&n.message.includes('分篇设置仍保留')&&!n.message.includes('内部应用错误')));assert(!failed.node.textContent.includes('内部应用错误'));}finally{failed.restore();}
 const forbidden=await mountHarness('published',{readFailure:Object.assign(Error('没有权限'),{kind:'http',status:403,code:'forbidden'})});try{assert.equal(forbidden.calls.length,1);assert(!forbidden.find('下载素材包'));assert(forbidden.notices.some(n=>n.message.includes('没有导出此内容的权限')));assert(!forbidden.calls.some(c=>c.path.includes('source=static')));}finally{forbidden.restore();}
});

test.skip('browser E2E deliberately skipped: no external browser execution authorized for this recovery task',()=>{});

test('an HTTP 500 image response is not called offline, not retried, and cannot create a partial ZIP',async()=>{
 const h=await mountHarness('draft',{downloads:true,assetStatus:500});try{const input=h.node.querySelectorAll('input')[0];input.value='题名仍在';await h.find('下载素材包').fire('click');assert.equal(h.imageRequests.length,1);assert.equal(h.downloadBlob,undefined);assert.equal(h.node.querySelectorAll('input')[0],input);assert.equal(input.value,'题名仍在');assert(h.notices.some(n=>n.kind==='error'&&n.message.includes('HTTP 500')));assert(!h.notices.some(n=>n.message.includes('网络')));}finally{h.restore();}
});
