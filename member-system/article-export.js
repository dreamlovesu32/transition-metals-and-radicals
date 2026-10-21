/* Editorial exports consume the displayed snapshot; they never fetch a newer draft for a public page. */
(function(global){
 'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const formatter=global.ReadInline||(typeof require==='function'?require('../inline-format.js'):null);
 function inline(s){const active=global.ReadInline||formatter;if(!active)throw Object.assign(Error('排版工具尚未准备好。'),{kind:'resource',code:'inline_script_unavailable'});return active.html(s);}
 const readDelay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 function retryableRead(error){return ['network','transport'].includes(error?.kind)||[429,502,503,504].includes(error?.status);}
 function failureMessage(error){
  if(typeof error?.publicMessage==='string')return error.publicMessage;
  if(error.kind==='identity'||error.status===401)return '管理员身份已变化，已停止本次导出。';
  if(error.status===403)return '当前账号没有导出此内容的权限。';
  if(error.kind==='version')return '文章版本已更新，已停止导出；当前阅读内容不会被替换。';
  if(/^asset_http_\d{3}$/.test(error.code||''))return `素材服务返回错误（HTTP ${error.status}），本次导出未完成。`;
  const known=new Set(['分篇起点已失效，请重新保存方案。','分篇范围已变化，请重新选择。','配图缺失，已停止导出。','导出文件路径重复','导出文件名无效','文章编号无效。','导出图片必须来自本站。','素材响应不是图片，已停止导出。','图片总量超过本次导出容量，请缩小分篇。']);
  return known.has(error.message)?error.message:'导出尚未完成，标题与分篇设置仍保留。';
 }
 async function recoverRead(operation,current=()=>true,wait=readDelay){
  for(let attempt=0;;attempt++){
   if(!current())throw Object.assign(Error('管理员身份已变化，本次读取已停止。'),{kind:'identity',code:'identity_changed'});
   try{const result=await operation();if(!current())throw Object.assign(Error('管理员身份已变化，本次读取已停止。'),{kind:'identity',code:'identity_changed'});return result;}
   catch(error){if(!current()||!retryableRead(error)||attempt>=2)throw error;await wait([250,1000][attempt]);}
  }
 }
 function exportFault(error){
  const detail={scope:'article-export',kind:error.kind||(error.status?'http':'application'),status:error.status||0,code:error.code||'unclassified'};
  if(global.CustomEvent&&global.document&&typeof document.dispatchEvent==='function')document.dispatchEvent(new global.CustomEvent('read-operation-error',{detail}));
  if(detail.kind!=='network')global.console?.error?.('Article export operation failed',detail);
 }
 function visible(s){return String(s||'').replace(/<\/?sub>/g,'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[*`\s]/g,'');}
 function stats(blocks){return {characters:blocks.reduce((n,b)=>n+visible(b.text).length,0),figures:blocks.filter(b=>b.kind==='figure').length};}
 function split(blocks,starts){
  const positions=starts.map(id=>blocks.findIndex(b=>b.id===id));
  if(positions.some((p,i)=>p<1||blocks[p].kind!=='heading'||i&&p<=positions[i-1]))throw Error('分篇起点已失效，请重新保存方案。');
  const cuts=[0,...positions,blocks.length];
  return cuts.slice(0,-1).map((from,i)=>{const to=cuts[i+1],original=blocks.slice(from,to);let context=[];
   if(i&&original[0]?.kind==='heading'&&Number(original[0].level||2)>2){let parents=[];for(const b of blocks.slice(0,from)){if(b.kind==='heading'){const l=Number(b.level||2);parents=parents.filter(p=>Number(p.level||2)<l);parents.push(b);}}context=parents.filter(p=>Number(p.level||2)<Number(original[0].level||2)).map(p=>({...p,context:true}));}
   return {blocks:[...context,...original],original,stats:stats(original)};});
 }
 function suggest(blocks,target=4000,maxFigures=8){
  // Keep leading citation/background together and keep consecutive parent/child headings together.
  const boundaries=[];let seenHeading=false;
  for(let i=0;i<blocks.length;i++){if(blocks[i].kind!=='heading')continue;
   if(!seenHeading){seenHeading=true;continue;}
   if(i>0&&blocks[i-1].kind!=='heading')boundaries.push(i);
  }
  const cuts=[0,...boundaries,blocks.length],starts=[];let total={characters:0,figures:0};
  for(let i=0;i<cuts.length-1;i++){const unit=stats(blocks.slice(cuts[i],cuts[i+1]));
   if(i>0&&(total.characters>=500||total.figures>0)&&(total.characters+unit.characters>target||total.figures+unit.figures>maxFigures)){
    starts.push(blocks[cuts[i]].id);total={characters:0,figures:0};
   }
   total.characters+=unit.characters;total.figures+=unit.figures;
  }
  return starts;
 }
 const utf8=s=>new TextEncoder().encode(s);
 const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
 function crc(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
 function zip(entries){let offset=0,parts=[],central=[],names=new Set();for(const [name,value]of entries){if(names.has(name))throw Error("导出文件路径重复");names.add(name);if(!/^(?:day-\d{2}\/)?(?:images\/)?[\p{Script=Han}A-Za-z0-9_.-]+$/u.test(name)||name.includes('..'))throw Error('导出文件名无效');const n=utf8(name),data=typeof value==='string'?utf8(value):value,c=crc(data),header=new Uint8Array(30+n.length),v=new DataView(header.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,c,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,n.length,true);header.set(n,30);parts.push(header,data);const h=new Uint8Array(46+n.length),w=new DataView(h.buffer);w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);w.setUint16(8,0x800,true);w.setUint32(16,c,true);w.setUint32(20,data.length,true);w.setUint32(24,data.length,true);w.setUint16(28,n.length,true);w.setUint32(42,offset,true);h.set(n,46);central.push(h);offset+=header.length+data.length;}const size=central.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,size,true);e.setUint32(16,offset,true);return new Blob([...parts,...central,end],{type:'application/zip'});}
 const FONT='"Microsoft YaHei","PingFang SC",Arial,sans-serif';
 const INK='#20262d';
 const SLOGAN='更好的图文阅读体验，欢迎访问 metalradical.xyz，或点击下方“阅读原文”。';
 const TEXT_STYLE=`color:${INK};font-family:${FONT};text-align:justify;text-autospace:no-autospace;line-height:1.85;margin:14px 0;font-size:16px;`;
 function exportInline(value){
  return inline(value).replace(/<(a|strong|em|sub|sup|code|span)(\s[^>]*?)?>/g,(all,tag,attrs='')=>{
   const style=`color:${tag==='a'?'#315f8b':INK};font-family:${FONT};`+(tag==='a'?'text-decoration:underline;':'');
   return `<${tag}${/\sstyle="/.test(attrs)?attrs.replace(/style="([^"]*)"/,(_,old)=>`style="${old};${esc(style)}"`):attrs+` style="${esc(style)}"`}>`;
  });
 }
 function readingUrl(id){if(typeof id!=='string'||!/^[-\w]+$/.test(id))throw Error('文章编号无效。');return 'https://metalradical.xyz/read.html?article='+encodeURIComponent(id);}
 function figurePlan(blocks,sourceLabels={}){
  const types='扩展图式|扩展图|扩展表|图式|图|表';
  const canonical=match=>match[1]+match[2].replace(/^0+(?=\d)/,'').toUpperCase();
  return blocks.filter(b=>b.kind==='figure').map((block,index)=>{
   const file=String(block.src||'').split('/').pop(),legacy=/^(figure|fig|table|scheme)[-_]?(\d+[a-z]?)(?:[-_.]|$)/i.exec(file);
   const caption=String(block.text||'').replace(/[*`]/g,''),labelMatch=new RegExp('('+types+')\\s*(\\d+[A-Za-z]{0,3})').exec(caption);
   // The standard guide caption explicitly identifies its figure with a leading
   // type/number and a vertical separator. Asset sequence numbers are not paper IDs.
   const explicit=new RegExp('^(?:原文\\s*)?('+types+')\\s*(\\d+[A-Za-z]{0,3})\\s*[｜|]').exec(caption.trim());
   const raw=Object.hasOwn(sourceLabels,block.id)?sourceLabels[block.id]:Object.hasOwn(sourceLabels,block.src)?sourceLabels[block.src]:block.sourceLabel;
   const metadata=typeof raw==='string'?new RegExp('^('+types+')\\s*(\\d+[A-Za-z]{0,3})([（(](?:局部|上|中|下)[）)])?$').exec(raw.trim()):null;
   const known=metadata||(Object.keys(sourceLabels).length?explicit:null),label=known?canonical(known):legacy?({figure:'图',fig:'图',table:'表',scheme:'图式'}[legacy[1].toLowerCase()]+legacy[2].toUpperCase()):labelMatch?labelMatch[1]+labelMatch[2]:'配图';
   // Keep existing legacy origin wording and deliberate guide/source renumbering.
   const origin=metadata||legacy?'原文':'文中',reference=label==='配图'?'本段配图':origin+label+(metadata?.[3]?metadata[3].replace('(','（').replace(')','）'):'')+(!known&&legacy&&labelMatch&&labelMatch[1]+labelMatch[2]!==label?'｜文中'+labelMatch[1]+labelMatch[2]:'');
   const number=String(index+1).padStart(2,'0'),stem=number+'-'+label.replace(/[^\p{Script=Han}A-Za-z0-9_-]/gu,'');
   return {key:block.id||'figure-'+index,src:block.src,number,label,reference,stem};
  });
 }

 function citationBlockIds(blocks){
  // Determine this once from the complete original snapshot, never from each part.
  const content=blocks.filter(b=>b.kind!=='title'),first=content[0];
  if(first?.kind!=='paragraph'||!first.id)return [];
  const ids=[first.id];
  for(const block of content.slice(1)){
   if(block.kind!=='paragraph'||!/^DOI\s*[：:]/i.test(String(block.text||'').trim()))break;
   if(block.id)ids.push(block.id);
  }
  return ids;
 }
 function exportGroups(blocks,starts,selection='whole'){
  const parts=split(blocks,starts);
  if(selection==='whole')return [{part:{blocks,original:blocks,stats:stats(blocks)},index:0,count:1}];
  if(selection==='parts')return parts.map((part,index)=>({part,index,count:parts.length}));
  const index=Number(selection);
  if(!Number.isInteger(index)||index<0||!parts[index])throw Error('分篇范围已变化，请重新选择。');
  return [{part:parts[index],index,count:parts.length}];
 }
 function footer(){return `<p data-export-footer style="${esc(TEXT_STYLE)}margin-top:28px;padding-top:16px;border-top:1px solid #dce5ee">更好的图文阅读体验，欢迎访问 <a href="https://metalradical.xyz" style="color:#315f8b;text-decoration:underline;font-family:${esc(FONT)}">metalradical.xyz</a>，或点击下方“阅读原文”。</p>`;}
 function render(blocks,images=new Map(),options={}){
  const figures=options.figures||figurePlan(blocks,options.sourceLabels),citationIds=new Set(options.citationIds||[]);let n=0;
  const body=blocks.filter(b=>b.kind!=='title').map(b=>{
   const t=exportInline(b.text),citation=citationIds.has(b.id)&&b.kind==='paragraph',style=esc(TEXT_STYLE+(citation?'font-size:12pt;':''));
   if(b.kind==='figure'){
    const slot=figures[n++],image=images.get(slot.key)||images.get(b.src);
    const placeholder=`【插入图片${slot.number}｜${slot.reference}】`;
    const mark=`<p data-export-placeholder="${slot.number}" style="${style}padding:12px 14px;border:1px dashed #b8c8d8;border-radius:6px;background:#f8fafc">${esc(placeholder)}<br><span style="color:#536579;font-family:${esc(FONT)};font-size:13px">对应文件：${esc(slot.fileName||slot.stem)}</span></p>`;
    if(!options.placeholders&&!image)throw Error('配图缺失，已停止导出。');
    return `<section style="${style}">${options.placeholders?mark:`<img src="${esc(image)}" style="max-width:100%;height:auto;display:block;margin:16px auto" alt="${esc(placeholder)}">`}<p style="${style}font-size:14px;color:#444">${t}</p></section>`;
   }
   if(b.kind==='heading'){const l=Math.max(2,Math.min(4,Number(b.level)||2));return `<h${l} style="${style}font-size:${l===2?22:19}px;line-height:1.6;font-weight:650;margin:24px 0 12px">${t}</h${l}>`;}
   if(b.kind==='bullet')return `<ul style="${style}"><li style="color:${INK};font-family:${esc(FONT)}">${t}</li></ul>`;
   if(b.kind==='quote')return `<blockquote style="${style}padding-left:16px;border-left:3px solid #c6d4e2">${t}</blockquote>`;
   return `<p${citation?' data-export-citation':''} style="${style}">${t}</p>`;
  }).join('\n');
  return body+(options.footer?footer():'');
 }
 function plainText(html,doc=global.document){
  const separated=html.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(?:p|h[1-6]|li|blockquote|section|ul)>/gi,'\n');
  if(doc){const node=doc.createElement('div');node.innerHTML=separated;return node.textContent.replace(/\n{3,}/g,'\n\n').trim();}
  return separated.replace(/<[^>]*>/g,'').replace(/&#(?:x([a-f0-9]+)|(\d+));/gi,(_,h,d)=>String.fromCodePoint(parseInt(h||d,h?16:10))).replace(/&(amp|lt|gt|quot|#39);/g,(_,n)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[n])).replace(/\n{3,}/g,'\n\n').trim();
 }
 function copyFallback(payload,env=globalThis){
  const doc=env.document;if(!doc?.execCommand)return false;
  const active=doc.activeElement,selection=env.getSelection?.(),ranges=[];
  if(selection)for(let i=0;i<selection.rangeCount;i++)ranges.push(selection.getRangeAt(i).cloneRange());
  const target=doc.createElement('div');target.contentEditable='true';target.setAttribute('aria-hidden','true');target.style.cssText='position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden';
  if(payload.html)target.innerHTML=payload.html;else target.textContent=payload.text;
  let wrote=false;const handler=event=>{if(!event.clipboardData)return;event.preventDefault();if(payload.html)event.clipboardData.setData('text/html',payload.html);event.clipboardData.setData('text/plain',payload.text);wrote=true;};
  try{doc.body.append(target);target.focus({preventScroll:true});const range=doc.createRange();range.selectNodeContents(target);selection?.removeAllRanges();selection?.addRange(range);doc.addEventListener('copy',handler);return doc.execCommand('copy')&&wrote;}
  catch{return false;}
  finally{doc.removeEventListener('copy',handler);target.remove();active?.focus?.({preventScroll:true});try{selection?.removeAllRanges();ranges.forEach(r=>selection.addRange(r));}catch{}}
 }
 async function copyPayload(payload,env=globalThis){
  // Called directly inside the click. Do not insert an API/image/save await here.
  if(payload.isCurrent&& !payload.isCurrent())throw Object.assign(Error('管理员身份已变化，已停止导出。'),{kind:'identity',code:'identity_changed'});
  try{
   if(payload.html&&env.navigator?.clipboard?.write&&env.ClipboardItem){
    const item=new env.ClipboardItem({'text/html':new env.Blob([payload.html],{type:'text/html'}),'text/plain':new env.Blob([payload.text],{type:'text/plain'})});
    await env.navigator.clipboard.write([item]);return 'rich';
   }
   if(!payload.html&&env.navigator?.clipboard?.writeText){await env.navigator.clipboard.writeText(payload.text);return 'text';}
  }catch{}
  if(payload.isCurrent&& !payload.isCurrent())throw Object.assign(Error('管理员身份已变化，已停止导出。'),{kind:'identity',code:'identity_changed'});
  if(copyFallback(payload,env))return payload.html?'rich-fallback':'text-fallback';
  throw Error('复制未完成。请允许浏览器使用剪贴板后重试，或尝试“复制纯文本”。');
 }
 const icons={copy:'M9 9h12v12H9ZM15 9V3H3v12h6',text:'M4 5h16M12 5v15m-4 0h8',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2m2 6a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',download:'M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5',save:'M5 3h12l4 4v14H3V3Zm2 0v6h10V3M7 21v-8h10v8',split:'M4 4h16M4 20h16M12 4v5m0 6v5m-5-9 5 4 5-4'};
 function icon(name){return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name]||icons.copy}"></path></svg>`;}
 function documentHtml(title,body,options={}){
  const copyHtml=options.copyHtml||body,payload={title,body:{html:copyHtml,text:plainText(copyHtml)},url:options.url||'',published:options.published!==false};
  const data=JSON.stringify(payload).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{max-width:760px;margin:32px auto;padding:0 20px;color:${INK};background:#fff;font-family:${FONT};text-autospace:no-autospace}h1{font-size:25px;line-height:1.5;color:${INK}}nav{display:flex;flex-wrap:wrap;gap:10px;padding:20px 0;border-bottom:1px solid #dce5ee}button{min-height:44px;padding:10px 14px;border:1px solid #cad8e5;background:#fff;border-radius:9px;color:#274461;font:inherit;cursor:pointer}button:first-child{background:#0f2a49;color:#fff;border-color:#0f2a49}button:focus-visible{outline:2px solid #638bb5;outline-offset:2px}#copy-status,#link-hint{flex-basis:100%;margin:0;color:#536579;line-height:1.7}#copy-status[data-error=true]{color:#a23b38}</style><h1 id="export-title">${esc(title)}</h1><nav aria-label="公众号复制工具"><button onclick="runCopy('body')">复制排版正文</button><button onclick="runCopy('plain')">复制纯文本</button><button onclick="runCopy('title')">复制标题</button>${options.url?'<button onclick="runCopy(\'url\')">复制阅读原文链接</button>':''}<p id="copy-status" role="status" aria-live="polite">正文复制包含顺序图片占位。请将同名图片插入对应位置，封面另选。</p>${options.url?`<p id="link-hint">${options.published===false?'本文尚未发布，链接发布后可访问。':'在公众号“阅读原文”中填入本篇网站链接。'}</p>`:''}</nav><article id="export-body">${body}</article><script>
${copyFallback.toString()}
${copyPayload.toString()}
const exportData=${data};
async function runCopy(kind){const status=document.querySelector('#copy-status');status.dataset.error='false';try{const payload=kind==='body'?exportData.body:{text:kind==='plain'?exportData.body.text:exportData[kind]};await copyPayload(payload);status.textContent=kind==='body'?'排版正文已复制。请粘贴后按占位编号插入同名图片。':kind==='url'?'阅读原文链接已复制。'+(!exportData.published?'本文尚未发布，链接发布后可访问。':''):'已复制。';}catch(error){status.dataset.error='true';status.textContent=error.message;}}
<\/script></html>`;
 }
 async function mount({articleId,revision,snapshot,assetUrl,toolbar,source,api,isCurrent,coverUrl,metadata}){
  const node=document.createElement('details');node.className='member-export-panel';node.innerHTML='<summary>公众号导出</summary>';toolbar.append(node);
  const area=document.createElement('div');area.className='export-workspace';node.append(area);let loaded=false,loading=null;
  function status(text,error=false){global.ReadToast?.show({key:'article-export:'+articleId,kind:error?'error':/已下载|已保存/.test(text)?'success':'info',message:text});}
  function fail(error){exportFault(error);status(failureMessage(error),true);if(!loaded)area.replaceChildren();}
  function load(){if(loaded)return Promise.resolve();if(loading)return loading;loading=performLoad().finally(()=>{loading=null;});return loading;}
  async function performLoad(){
   if(loaded)return;area.textContent='正在核对管理员权限与文章版本…';area.setAttribute('aria-busy','true');
   try{
    if(!isCurrent())throw Error('请重新登录管理员账号。');let effective=source==='draft-content'?'draft':source,saved,body=snapshot;
    if(source==='published'){try{saved=await recoverRead(()=>api(`admin/drafts/${articleId}/export-plan?source=published`),isCurrent);if(saved.content_hash!==revision||((snapshot.review_version_hash||metadata?.reviewVersion)&&saved.version_hash!==(snapshot.review_version_hash||metadata?.reviewVersion)))throw Object.assign(Error('文章版本已更新，已停止导出；当前阅读内容不会被替换。'),{kind:'version',code:'version_changed'});body=saved;}catch(e){if(e.status!==404)throw e;effective='static';}}
    const path=`admin/drafts/${articleId}/export-plan?source=${effective}`+(['static','history'].includes(effective)?`&version=${revision}`:'');
    if(!saved||effective==='static')saved=await recoverRead(()=>api(path),isCurrent);
    if(!isCurrent())throw Object.assign(Error('登录已变化，已停止导出。'),{kind:'identity',code:'identity_changed'});if(effective==='draft'||effective==='history'){if((source==='draft-content'?saved.content_hash:saved.version_hash)!==revision)throw Object.assign(Error('稿件版本已变化，已停止导出。'),{kind:'version',code:'version_changed'});body=saved;}
    const sourceLabels=body.article?.figureSourceLabels||snapshot.article?.figureSourceLabels||{};
    const blocks=body.blocks.filter(b=>b.kind!=='title'),citationIds=citationBlockIds(body.blocks),url=readingUrl(articleId),published=['published','static'].includes(effective);
    let titleText=body.title||body.article?.title?.zh||snapshot.article.title.zh;
    const month=body.article?.published||metadata?.published||(body.article?.firstPublishedOn||metadata?.firstPublishedOn||'').slice(0,7).replace('-','.');
    if(/^\d{4}\.\d{2}$/.test(month)&&!new RegExp('[（(]'+month.replace('.','\\.')+'[）)]$').test(titleText))titleText+='（'+month+'）';
    let starts=saved.plan?.starts||(body.article?.kind==='review'?suggest(blocks):[]),planRevision=effective==='static'?revision:saved.version_hash,selection='whole',parts=[];
    if(!starts.every(id=>blocks.some(b=>b.id===id&&b.kind==='heading')))starts=[];
    area.replaceChildren();const add=(parent,tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;parent.append(n);return n;};
    const intro=add(area,'section',undefined,'export-intro');add(intro,'span',effective==='history'?'历史版本 · 只读':published?'当前公开版本':'待审版本 · 仅导出','export-version');add(intro,'h3','导出素材包');add(intro,'p','下载后打开 body.html，一键复制正文、标题和阅读原文链接。');
    const titleLabel=add(area,'label','导出标题','export-field'),title=add(titleLabel,'input');title.value=saved.plan?.title||titleText;title.maxLength=300;title.setAttribute('aria-label','导出标题');
    const scope=add(area,'section',undefined,'export-section');add(scope,'h4','导出范围');const scopes=add(scope,'div',undefined,'export-scopes');scopes.setAttribute('aria-label','导出范围');
    const downloads=add(area,'section',undefined,'export-download-section'),downloadActions=add(downloads,'div',undefined,'export-download-actions');
    const report=add(downloads,'p','素材包包含排版正文、按编号配图、独立封面和本站阅读原文链接。','export-status');report.dataset.exportStatus='';report.setAttribute('role','status');report.setAttribute('aria-live','polite');
    if(!published)add(downloads,'p','本文尚未发布，阅读原文链接发布后可访问。','export-link-hint');
    const adjust=add(area,'details',undefined,'export-adjust');add(adjust,'summary','调整与保存分篇');add(adjust,'p','按章节分篇，不拆散段落与配图。4000字符 / 8图为编辑参考，不是微信后台硬上限。');const choices=add(adjust,'div',undefined,'export-split-choices');
    function action(parent,text,name,fn,primary=false){const b=add(parent,'button',undefined,'export-button'+(primary?' export-primary':''));b.type='button';b.innerHTML=icon(name)+'<span>'+esc(text)+'</span>';b.addEventListener('click',async()=>{if(b.disabled)return;const controls=[...area.querySelectorAll('button,input')];controls.forEach(n=>n.disabled=true);area.setAttribute('aria-busy','true');try{if(!isCurrent())throw Object.assign(Error('管理员身份已变化，已停止导出。'),{kind:'identity',code:'identity_changed'});await fn();}catch(error){exportFault(error);status(failureMessage(error),true);}finally{controls.forEach(n=>n.disabled=false);area.setAttribute('aria-busy','false');}});return b;}
    function refresh(){parts=split(blocks,starts);if(!['whole','parts'].includes(selection)&&Number(selection)>=parts.length)selection='whole';scopes.replaceChildren();const addScope=(value,label,detail)=>{const b=add(scopes,'button',undefined,'export-scope');b.type='button';b.setAttribute('aria-pressed',String(selection===value));add(b,'strong',label);add(b,'small',detail);b.addEventListener('click',()=>{selection=value;refresh();});};const whole=stats(blocks);addScope('whole','整篇',`${whole.characters}字 · ${whole.figures}张图`);if(parts.length>1){addScope('parts','全部分篇',`共${parts.length}篇 · 按章节分别整理`);parts.forEach((part,i)=>addScope(String(i),`第${i+1}篇 / 共${parts.length}篇`,`${part.stats.characters}字 · ${part.stats.figures}张图`));}}
    for(const b of blocks.filter((b,i)=>i>0&&b.kind==='heading')){const label=add(choices,'label',undefined,'export-split-choice'),check=add(label,'input');check.type='checkbox';check.checked=starts.includes(b.id);check.value=b.id;check.addEventListener('change',()=>{starts=[...choices.querySelectorAll('input:checked')].map(n=>n.value);refresh();});add(label,'span','从此章节开始下一篇：'+plainText(inline(b.text)));}
    const save=async()=>{if(effective==='history')return;if(!isCurrent())throw Object.assign(Error('登录状态已失效，已停止导出。'),{kind:'identity',code:'identity_changed'});await api(path,{version_hash:planRevision,starts,title:title.value},'PUT');};
    action(adjust,'按章节建议分篇','split',()=>{starts=suggest(blocks);for(const c of choices.querySelectorAll('input'))c.checked=starts.includes(c.value);refresh();status('已更新分篇建议，可选择范围后下载。');});
    if(effective!=='history')action(adjust,'保存分篇方案','save',async()=>{await save();status('标题与分篇方案已保存。');});
    async function download(){
     status('正在准备图片与素材包…');await save();const groups=exportGroups(blocks,starts,selection),files=[],cache=new Map(),manifestParts=[];let total=0,loadedImages=0;
     const imageCount=new Set(groups.flatMap(p=>p.part.blocks.filter(b=>b.kind==='figure').map(b=>b.src))).size+1;
     const getImage=async(src,cover=false)=>{
      const key=cover?'cover':src;if(cache.has(key))return cache.get(key);let asset;
      if(effective==='history')asset=`/api/member/admin/drafts/${articleId}/versions/${encodeURIComponent(revision)}/assets/${body.asset_map[key]}`;
      else if(effective==='draft')asset=`/api/member/admin/drafts/${articleId}/assets/${body.asset_map[key]}`;
      else if(effective==='published')asset=`/api/member/public/articles/${articleId}/assets/${body.asset_map[key]}?v=${planRevision}`;
      else asset=cover?coverUrl:assetUrl(src);
      const parsed=new URL(asset,location.href);if(parsed.origin!==location.origin)throw Error('导出图片必须来自本站。');if(!isCurrent())throw Object.assign(Error('登录状态已失效，已停止导出。'),{kind:'identity',code:'identity_changed'});
      const {bytes,ext}=await recoverRead(async()=>{
       let response;try{response=await fetch(parsed,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(60000)});}catch(error){if(['TypeError','AbortError','TimeoutError'].includes(error.name))error.kind=global.navigator?.onLine===false?'network':'transport';throw error;}
       if(!response.ok)throw Object.assign(Error(`素材服务返回错误（HTTP ${response.status}），本次导出未完成。`),{kind:'http',status:response.status,code:'asset_http_'+response.status});
       const mime=response.headers.get('Content-Type')?.split(';')[0],ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime];if(!ext)throw Object.assign(Error('素材响应不是图片，已停止导出。'),{kind:'application',code:'asset_content_type'});
       let buffer;try{buffer=await response.arrayBuffer();}catch(error){if(['TypeError','AbortError','TimeoutError'].includes(error.name))error.kind=global.navigator?.onLine===false?'network':'transport';throw error;}return {bytes:new Uint8Array(buffer),ext};
      },isCurrent);total+=bytes.length;if(total>100*1024*1024)throw Error('图片总量超过本次导出容量，请缩小分篇。');
      const result={bytes,ext};cache.set(key,result);loadedImages++;status(`正在准备素材：图片${loadedImages} / ${imageCount}…`);return result;
     };
     for(let i=0;i<groups.length;i++){
      const {part,index,count}=groups[i],prefix=`day-${String(index+1).padStart(2,'0')}/`,images=new Map(),figures=figurePlan(part.blocks,sourceLabels);
      for(const slot of figures){const image=await getImage(slot.src),name=`images/${slot.stem}.${image.ext}`;slot.fileName=slot.stem+'.'+image.ext;images.set(slot.key,name);files.push([prefix+name,image.bytes]);}
      const cover=await getImage('cover',true);files.push([prefix+`cover.${cover.ext}`,cover.bytes]);
      const titleValue=title.value+(count>1?`（${index+1}/${count}）`:''),copyHtml=render(part.blocks,new Map(),{placeholders:true,figures,footer:true,citationIds}),html=render(part.blocks,images,{figures,footer:true,citationIds});
      files.push([prefix+'title.txt',titleValue],[prefix+'body.html',documentHtml(titleValue,html,{copyHtml,url,published})],[prefix+'body.txt',plainText(copyHtml)],[prefix+'read-original-link.txt',url+(!published?'\n本文尚未发布，链接发布后可访问。':'')]);
      manifestParts.push({day:index+1,block_ids:part.original.map(b=>b.id),...part.stats,figures:figures.map(x=>({number:x.number,reference:x.reference,file:'images/'+x.fileName,block_id:x.key,source:x.src})),cover:'cover.'+cover.ext});
     }
     const final=await recoverRead(()=>api(path),isCurrent);if(!isCurrent())throw Object.assign(Error('管理员身份已变化，已停止导出。'),{kind:'identity',code:'identity_changed'});if(effective!=='static'&&final.version_hash!==planRevision)throw Object.assign(Error('文章版本已变化，已停止导出。'),{kind:'version',code:'version_changed'});
     files.push(['manifest.json',JSON.stringify({articleId,source:effective,version_hash:planRevision,readingUrl:url,published,parts:manifestParts,note:'插图序号逐篇重置；原图号另列；封面独立。不含PDF、SI、批注或反馈。'},null,2)]);
     const blob=zip(files),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${articleId}-${selection==='whole'?'full':selection==='parts'?'parts':'part-'+String(Number(selection)+1).padStart(2,'0')}.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),10000);status(`已下载${groups.length}篇素材。打开body.html可一键复制排版正文，按占位文件名插图，cover为独立封面。`);
    }
    action(downloadActions,'下载素材包','download',download,true);refresh();loaded=true;
   }catch(error){fail(error);}finally{area.setAttribute('aria-busy','false');}
  }
  node.addEventListener('toggle',()=>node.open?load():undefined);
  document.addEventListener('read-members-expired',()=>{area.replaceChildren();node.remove();},{once:true});return node;
 }
 const api={mount,split,suggest,stats,zip,render,citationBlockIds,exportGroups,documentHtml,plainText,figurePlan,readingUrl,copyPayload,copyFallback,recoverRead,retryableRead,failureMessage,SLOGAN};global.ReadArticleExport=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
