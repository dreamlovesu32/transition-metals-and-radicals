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
 const previous={document:global.document,location:global.location,fetch:global.fetch,ClipboardItem:global.ClipboardItem,navigator:Object.getOwnPropertyDescriptor(global,'navigator')};
 const doc={createElement:tag=>new Element(tag),addEventListener(){},removeEventListener(){}};global.document=doc;global.location=new URL('https://example.org/read');global.fetch=()=>{throw Error('copy must not download images');};
 let written,valid=true;global.ClipboardItem=class{constructor(values){this.values=values;}};Object.defineProperty(global,'navigator',{configurable:true,value:{clipboard:{write:async items=>{written=items[0];},writeText:async text=>{written=text;}}}});
 const revision='a'.repeat(64),snapshot={article:{id:'sample-paper',title:{zh:'标题'},kind:'research'},blocks:sample,version_hash:'c'.repeat(64),review_version_hash:options.expectedReview},calls=[];
 const saved={...snapshot,content_hash:source==='draft-content'?'c'.repeat(64):revision,version_hash:options.serverReview||revision,title:'标题',plan:null};
 const toolbar=new Element('div');const api=async(path,body,method='GET')=>{calls.push({path,body,method});return saved;};
 const node=await tool.mount({articleId:'sample-paper',revision:source==='draft-content'?'c'.repeat(64):revision,snapshot,toolbar,source,api,isCurrent:()=>valid,metadata:{}});node.open=true;await node.fire('toggle');await new Promise(r=>setImmediate(r));
 const buttons=()=>node.querySelectorAll('button'),find=label=>buttons().find(b=>b.textContent===label);
 return {node,calls,find,saved,get written(){return written;},expire(){valid=false;},restore(){for(const [key,value]of Object.entries(previous)){if(key==='navigator'){if(value)Object.defineProperty(global,key,value);else delete global.navigator;}else if(value===undefined)delete global[key];else global[key]=value;}}};
}

test('actual mounted current/history/workbench export copies without save or image request and preserves the viewed source',async()=>{
 for(const source of ['draft','history','draft-content']){
  const h=await mountHarness(source);try{const button=h.find('复制排版正文');assert(button,'real copy control is mounted');await button.fire('click');assert(h.written?.values['text/html']);const html=await h.written.values['text/html'].text();assert(html.includes('data-export-placeholder'));assert(h.calls.every(c=>c.method==='GET'));assert(h.calls.every(c=>c.path.includes(source==='history'?'source=history':'source=draft')));if(source==='history')assert(!h.find('保存分篇方案'));h.expire();const old=h.written;await button.fire('click');assert.equal(h.written,old);assert(h.node.textContent.includes('身份已变化'));}finally{h.restore();}
 }
});

test('published review hash must match even when its body hash is unchanged, so new pictures cannot replace cached viewed pictures',async()=>{
 const h=await mountHarness('published',{expectedReview:'old-review',serverReview:'new-review'});try{assert(!h.find('复制排版正文'));assert(h.node.textContent.includes('刷新'));assert(h.node.textContent.includes('重新载入'));}finally{h.restore();}
});
