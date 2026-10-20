/* Editorial exports consume the displayed snapshot; they never fetch a newer draft for a public page. */
(function(global){
 'use strict';
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const formatter=global.ReadInline||(typeof require==='function'?require('../inline-format.js'):null);
 function inline(s){if(!formatter)throw Error('排版工具尚未载入，请刷新重试。');return formatter.html(s);}
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
 function figurePlan(blocks){
  return blocks.filter(b=>b.kind==='figure').map((block,index)=>{
   const file=String(block.src||'').split('/').pop(),source=/^(figure|fig|table|scheme)[-_]?(\d+[a-z]?)(?:[-_.]|$)/i.exec(file);
   const caption=String(block.text||'').replace(/[*`]/g,''),labelMatch=/(图式|图|表)\s*(\d+[A-Za-z]?)/.exec(caption);
   const label=source?({figure:'图',fig:'图',table:'表',scheme:'图式'}[source[1].toLowerCase()]+source[2].toUpperCase()):labelMatch?labelMatch[1]+labelMatch[2]:'配图';
   const number=String(index+1).padStart(2,'0'),stem=number+'-'+label.replace(/[^\p{Script=Han}A-Za-z0-9_-]/gu,'');
   return {key:block.id||'figure-'+index,src:block.src,number,label,reference:label==='配图'?'本段配图':(source?'原文':'文中')+label+(source&&labelMatch&&labelMatch[1]+labelMatch[2]!==label?'｜文中'+labelMatch[1]+labelMatch[2]:''),stem};
  });
 }
 function footer(){return `<p data-export-footer style="${esc(TEXT_STYLE)}margin-top:28px;padding-top:16px;border-top:1px solid #dce5ee">更好的图文阅读体验，欢迎访问 <a href="https://metalradical.xyz" style="color:#315f8b;text-decoration:underline;font-family:${esc(FONT)}">metalradical.xyz</a>，或点击下方“阅读原文”。</p>`;}
 function render(blocks,images=new Map(),options={}){
  const figures=options.figures||figurePlan(blocks);let n=0;
  const body=blocks.filter(b=>b.kind!=='title').map(b=>{
   const t=exportInline(b.text),style=esc(TEXT_STYLE);
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
   return `<p style="${style}">${t}</p>`;
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
  if(payload.isCurrent&& !payload.isCurrent())throw Error('管理员身份已变化，请重新打开导出。');
  try{
   if(payload.html&&env.navigator?.clipboard?.write&&env.ClipboardItem){
    const item=new env.ClipboardItem({'text/html':new env.Blob([payload.html],{type:'text/html'}),'text/plain':new env.Blob([payload.text],{type:'text/plain'})});
    await env.navigator.clipboard.write([item]);return 'rich';
   }
   if(!payload.html&&env.navigator?.clipboard?.writeText){await env.navigator.clipboard.writeText(payload.text);return 'text';}
  }catch{}
  if(payload.isCurrent&& !payload.isCurrent())throw Error('管理员身份已变化，请重新打开导出。');
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
  const area=document.createElement('div');area.className='export-workspace';node.append(area);let loaded=false;
  function status(text,error=false){const box=area.querySelector('[data-export-status]');if(box){box.textContent=text;box.dataset.tone=error?'error':'normal';}}
  function fail(error){area.replaceChildren();const message=document.createElement('p');message.className='export-status';message.setAttribute('role','alert');message.textContent=error.message||'暂时不能导出。';const retry=document.createElement('button');retry.type='button';retry.className='export-button';retry.textContent='重新载入';retry.addEventListener('click',()=>{loaded=false;load();});area.append(message,retry);}
  async function load(){
   if(loaded)return;area.textContent='正在核对管理员权限与文章版本…';area.setAttribute('aria-busy','true');
   try{
    if(!isCurrent())throw Error('请重新登录管理员账号。');let effective=source==='draft-content'?'draft':source,saved,body=snapshot;
    if(source==='published'){try{saved=await api(`admin/drafts/${articleId}/export-plan?source=published`);if(saved.content_hash!==revision||((snapshot.review_version_hash||metadata?.reviewVersion)&&saved.version_hash!==(snapshot.review_version_hash||metadata?.reviewVersion)))throw Error('页面内容已更新，请刷新后再导出。');body=saved;}catch(e){if(e.status!==404)throw e;effective='static';}}
    const path=`admin/drafts/${articleId}/export-plan?source=${effective}`+(['static','history'].includes(effective)?`&version=${revision}`:'');
    if(!saved||effective==='static')saved=await api(path);
    if(!isCurrent())throw Error('登录已变化，请重新打开文章。');if(effective==='draft'||effective==='history'){if((source==='draft-content'?saved.content_hash:saved.version_hash)!==revision)throw Error('稿件已更新，请重新打开。');body=saved;}
    const blocks=body.blocks.filter(b=>b.kind!=='title'),url=readingUrl(articleId),published=['published','static'].includes(effective);
    let titleText=body.title||body.article?.title?.zh||snapshot.article.title.zh;
    const month=body.article?.published||metadata?.published||(body.article?.firstPublishedOn||metadata?.firstPublishedOn||'').slice(0,7).replace('-','.');
    if(/^\d{4}\.\d{2}$/.test(month)&&!new RegExp('[（(]'+month.replace('.','\\.')+'[）)]$').test(titleText))titleText+='（'+month+'）';
    let starts=saved.plan?.starts||(body.article?.kind==='review'?suggest(blocks):[]),planRevision=effective==='static'?revision:saved.version_hash,selection='whole',parts=[];
    if(!starts.every(id=>blocks.some(b=>b.id===id&&b.kind==='heading')))starts=[];
    area.replaceChildren();const add=(parent,tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;parent.append(n);return n;};
    const intro=add(area,'section',undefined,'export-intro');add(intro,'span',effective==='history'?'历史版本 · 只读':published?'当前公开版本':'待审版本 · 仅导出','export-version');add(intro,'h3','从阅读页，到公众号');add(intro,'p','复制正文后，按编号插入图片。');
    const titleLabel=add(area,'label','导出标题','export-field'),title=add(titleLabel,'input');title.value=saved.plan?.title||titleText;title.maxLength=300;title.setAttribute('aria-label','导出标题');
    const scope=add(area,'section',undefined,'export-section');add(scope,'h4','复制范围');const scopes=add(scope,'div',undefined,'export-scopes');scopes.setAttribute('aria-label','复制范围');
    const copyArea=add(area,'section',undefined,'export-section');const copyActions=add(copyArea,'div',undefined,'export-copy-actions');
    const report=add(copyArea,'p','选择整篇或分篇后复制。','export-status');report.dataset.exportStatus='';report.setAttribute('role','status');report.setAttribute('aria-live','polite');
    const linkArea=add(area,'section',undefined,'export-link-section');add(linkArea,'h4','公众号“阅读原文”');add(linkArea,'p',url,'export-read-url');add(linkArea,'p',published?'填写此链接，读者将进入本篇网站阅读页。':'本文尚未发布，链接发布后可访问。复制或导出不会发布稿件。','export-link-hint');
    const mapDetails=add(area,'details',undefined,'export-image-map');add(mapDetails,'summary','图片顺序与对应文件');const imageMap=add(mapDetails,'div',undefined,'export-image-map-list');
    const downloads=add(area,'section',undefined,'export-section');add(downloads,'h4','图片与本地素材');add(downloads,'p','占位中的01、02是本篇插入顺序，原文图号另列。封面独立，不占正文编号。');const downloadActions=add(downloads,'div',undefined,'export-download-actions');
    const adjust=add(area,'details',undefined,'export-adjust');add(adjust,'summary','调整与保存分篇');add(adjust,'p','按章节分篇，不拆散段落与配图。4000字符 / 8图为编辑参考，不是微信后台硬上限。');const choices=add(adjust,'div',undefined,'export-split-choices');
    function action(parent,text,name,fn,primary=false){const b=add(parent,'button',undefined,'export-button'+(primary?' export-primary':''));b.type='button';b.innerHTML=icon(name)+'<span>'+esc(text)+'</span>';b.addEventListener('click',async()=>{if(b.disabled)return;const controls=[...area.querySelectorAll('button,input')];controls.forEach(n=>n.disabled=true);area.setAttribute('aria-busy','true');try{if(!isCurrent())throw Error('管理员身份已变化，请重新打开导出。');await fn();}catch(error){status(error.message||'操作未完成，请重试。',true);}finally{controls.forEach(n=>n.disabled=false);area.setAttribute('aria-busy','false');}});return b;}
    function selected(){const planned=selection!=='whole',index=planned?Number(selection):0,part=planned?parts[index]:{blocks,original:blocks,stats:stats(blocks)};if(!part)throw Error('分篇范围已变化，请重新选择。');return {part,title:title.value+(planned&&parts.length>1?`（${index+1}/${parts.length}）`:''),figures:figurePlan(part.blocks)};}
    function payload(){const item=selected(),html=render(item.part.blocks,new Map(),{placeholders:true,figures:item.figures,footer:true});return {...item,html,text:plainText(html)};}
    action(copyActions,'复制排版正文','copy',()=>{const value=payload();return copyPayload({...value,isCurrent}).then(()=>status('排版正文已复制。请粘贴后按占位编号插入同名图片。'));},true);
    action(copyActions,'复制纯文本','text',()=>{const value=payload();return copyPayload({text:value.text,isCurrent}).then(()=>status('纯文本已复制，图片占位和原图号一并保留。'));});
    action(copyActions,'复制标题','text',()=>copyPayload({text:selected().title,isCurrent}).then(()=>status('标题已复制。')));
    action(linkArea,'复制阅读原文链接','link',()=>copyPayload({text:url,isCurrent}).then(()=>status('阅读原文链接已复制。'+(!published?'本文尚未发布，链接发布后可访问。':''))));
    function refresh(){parts=split(blocks,starts);if(selection!=='whole'&&Number(selection)>=parts.length)selection='whole';scopes.replaceChildren();const addScope=(value,label,detail)=>{const b=add(scopes,'button',undefined,'export-scope');b.type='button';b.setAttribute('aria-pressed',String(selection===value));add(b,'strong',label);add(b,'small',detail);b.addEventListener('click',()=>{selection=value;refresh();});};const whole=stats(blocks);addScope('whole','整篇',`${whole.characters}字 · ${whole.figures}张图`);if(parts.length>1)parts.forEach((part,i)=>addScope(String(i),`第${i+1}篇 / 共${parts.length}篇`,`${part.stats.characters}字 · ${part.stats.figures}张图`));imageMap.replaceChildren();for(const item of selected().figures){const row=add(imageMap,'div',undefined,'export-image-row');add(row,'strong','图片'+item.number);add(row,'span',item.reference);add(row,'code',item.stem);}if(!selected().figures.length)add(imageMap,'p','本范围没有正文图片。');}
    for(const b of blocks.filter((b,i)=>i>0&&b.kind==='heading')){const label=add(choices,'label',undefined,'export-split-choice'),check=add(label,'input');check.type='checkbox';check.checked=starts.includes(b.id);check.value=b.id;check.addEventListener('change',()=>{starts=[...choices.querySelectorAll('input:checked')].map(n=>n.value);refresh();});add(label,'span','从此章节开始下一篇：'+plainText(inline(b.text)));}
    const save=async()=>{if(effective==='history')return;if(!isCurrent())throw Error('登录已失效。');await api(path,{version_hash:planRevision,starts,title:title.value},'PUT');};
    action(adjust,'按章节建议分篇','split',()=>{starts=suggest(blocks);for(const c of choices.querySelectorAll('input'))c.checked=starts.includes(c.value);refresh();status('已更新分篇建议，可选择各篇复制或下载。');});
    if(effective!=='history')action(adjust,'保存分篇方案','save',async()=>{await save();status('标题与分篇方案已保存。');});
    async function download(planned){
     status('正在准备图片与素材包…');await save();const groups=planned?split(blocks,starts):[{blocks,original:blocks,stats:stats(blocks)}],files=[],cache=new Map(),manifestParts=[];let total=0,loadedImages=0;
     const imageCount=new Set(groups.flatMap(p=>p.blocks.filter(b=>b.kind==='figure').map(b=>b.src))).size+1;
     const getImage=async(src,cover=false)=>{
      const key=cover?'cover':src;if(cache.has(key))return cache.get(key);let asset;
      if(effective==='history')asset=`/api/member/admin/drafts/${articleId}/versions/${encodeURIComponent(revision)}/assets/${body.asset_map[key]}`;
      else if(effective==='draft')asset=`/api/member/admin/drafts/${articleId}/assets/${body.asset_map[key]}`;
      else if(effective==='published')asset=`/api/member/public/articles/${articleId}/assets/${body.asset_map[key]}?v=${planRevision}`;
      else asset=cover?coverUrl:assetUrl(src);
      const parsed=new URL(asset,location.href);if(parsed.origin!==location.origin)throw Error('导出图片必须来自本站。');if(!isCurrent())throw Error('登录已失效。');
      const response=await fetch(parsed,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('图片下载失败，请稍后重试。');
      const mime=response.headers.get('Content-Type')?.split(';')[0],ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime];if(!ext)throw Error('非图片资源已拒绝。');
      const bytes=new Uint8Array(await response.arrayBuffer());total+=bytes.length;if(total>100*1024*1024)throw Error('图片总量超过本次导出容量，请缩小分篇。');
      const result={bytes,ext};cache.set(key,result);loadedImages++;status(`正在准备素材：图片${loadedImages} / ${imageCount}…`);return result;
     };
     for(let i=0;i<groups.length;i++){
      const part=groups[i],prefix=`day-${String(i+1).padStart(2,'0')}/`,images=new Map(),figures=figurePlan(part.blocks);
      for(const slot of figures){const image=await getImage(slot.src),name=`images/${slot.stem}.${image.ext}`;slot.fileName=slot.stem+'.'+image.ext;images.set(slot.key,name);files.push([prefix+name,image.bytes]);}
      const cover=await getImage('cover',true);files.push([prefix+`cover.${cover.ext}`,cover.bytes]);
      const titleValue=title.value+(groups.length>1?`（${i+1}/${groups.length}）`:''),copyHtml=render(part.blocks,new Map(),{placeholders:true,figures,footer:true}),html=render(part.blocks,images,{figures,footer:true});
      files.push([prefix+'title.txt',titleValue],[prefix+'body.html',documentHtml(titleValue,html,{copyHtml,url,published})],[prefix+'body.txt',plainText(copyHtml)],[prefix+'read-original-link.txt',url+(!published?'\n本文尚未发布，链接发布后可访问。':'')]);
      manifestParts.push({day:i+1,block_ids:part.original.map(b=>b.id),...part.stats,figures:figures.map(x=>({number:x.number,reference:x.reference,file:'images/'+x.fileName,block_id:x.key,source:x.src})),cover:'cover.'+cover.ext});
     }
     const final=await api(path);if(!isCurrent()||(effective!=='static'&&final.version_hash!==planRevision))throw Error('文章或管理员身份已变化，已停止导出。');
     files.push(['manifest.json',JSON.stringify({articleId,source:effective,version_hash:planRevision,readingUrl:url,published,parts:manifestParts,note:'插图序号逐篇重置；原图号另列；封面独立。不含PDF、SI、批注或反馈。'},null,2)]);
     const blob=zip(files),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${articleId}-${planned?'plan':'full'}.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),10000);status(`已下载${groups.length}篇素材。打开body.html可一键复制排版正文，按占位文件名插图，cover为独立封面。`);
    }
    action(downloadActions,'下载整篇素材包','download',()=>download(false));action(downloadActions,'按分篇下载素材包','download',()=>download(true));refresh();loaded=true;
   }catch(error){fail(error);}finally{area.setAttribute('aria-busy','false');}
  }
  node.addEventListener('toggle',()=>{if(node.open)load();});
  document.addEventListener('read-members-expired',()=>{area.replaceChildren();node.remove();},{once:true});return node;
 }
 const api={mount,split,suggest,stats,zip,render,documentHtml,plainText,figurePlan,readingUrl,copyPayload,copyFallback,SLOGAN};global.ReadArticleExport=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
