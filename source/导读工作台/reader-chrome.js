/* Shared reading chrome. Article text and member permissions stay with their owners. */
function createReaderJumpController(capture,move,restore,changed){
 let origin=null,edge=null;
 return {async jump(next){if(edge===next&&origin){const saved=origin;origin=null;edge=null;changed(null);await restore(saved);return;}if(!origin)origin=capture();edge=next;changed(edge);await move(next);},get edge(){return edge;}};
}
if(typeof module!=='undefined')module.exports={createReaderJumpController};
(() => {
  'use strict';
  if(typeof document==='undefined')return;
  const q = s => document.querySelector(s);
  if (!q('#article') || !q('.topbar')) return;
  const paths = {
    outline:'M4 6h2m4 0h10M4 12h2m4 0h10M4 18h2m4 0h10',
    prev:'m14 6-6 6 6 6',next:'m10 6 6 6-6 6',
    star:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
    pen:'m14 3 7 7-9 9H5v-7ZM11 6l7 7M3 22h12',
    notes:'M5 3h14v18H5ZM8 8h8M8 12h8M8 16h5',
    layout:'M3 4h18v16H3ZM12 4v16',
    export:'M12 16V3m-4 4 4-4 4 4M4 14v7h16v-7',
    link:'M14 3h7v7m0-7L10 14M10 5H4v15h15v-6',
    close:'M6 6l12 12M18 6 6 18',up:'m6 14 6-6 6 6',down:'m6 10 6 6 6-6',
    versions:'M4 5h16M4 12h16M4 19h16M7 2v6M7 9v6M7 16v6',
    review:'m5 12 4 4L19 6',more:'M5 12h.01M12 12h.01M19 12h.01',history:'M3 11a9 9 0 1 1 3 7M3 4v7h7m2-4v6l4 2'
  };
  function icon(name) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path');
    path.setAttribute('d',paths[name]||paths.notes);svg.append(path);return svg;
  }
  function dress(node,name,label) {
    node.classList.add('reader-tool');node.setAttribute('aria-label',label);node.title=label;
    const labelNode=document.createElement('span');labelNode.className='reader-tool-label';labelNode.textContent=label;node.replaceChildren(icon(name),labelNode);return node;
  }
  function tool(name,label,action) {
    const b=document.createElement('button');b.type='button';dress(b,name,label);
    if(action)b.addEventListener('click',action);return b;
  }
  const bar=document.createElement('nav');bar.className='reader-toolbar';bar.setAttribute('aria-label','阅读工具');
  const leading=document.createElement('div'),actions=document.createElement('div'),ending=document.createElement('div');
  leading.className='reader-tool-group reader-leading-tools';actions.className='reader-tool-group reader-admin-tools';ending.className='reader-tool-group reader-ending-tools';
  actions.id='reader-member-actions';bar.append(leading,ending);ending.append(actions);
  q('.topbar').after(bar);
  const catalog=q('#nav-catalog'),catalogGroup=document.createElement('div');catalogGroup.className='reader-global-articles';catalogGroup.setAttribute('aria-label','文献导航与相邻文章');
  if(catalog){q('.brand').after(catalogGroup);catalogGroup.append(catalog);}
  for(const [id,key,label] of [['nav-prev','prev','上一篇'],['nav-next','next','下一篇']])if(q('#'+id))catalogGroup.append(dress(q('#'+id),key,label));
  const annotationSlot=document.createElement('div');annotationSlot.className='reader-pen-slot';
  const penPlaceholder=tool('pen','荧光笔正在准备');penPlaceholder.disabled=true;annotationSlot.append(penPlaceholder);leading.append(annotationSlot);
  let resumeOffer=null,resumeNotice=null;
  function openResume(){if(resumeOffer)return resumeNotice=globalThis.ReadToast?.show({key:resumeOffer.key||'reading-resume',kind:'resume',message:resumeOffer.caption||'已保存上次阅读位置。',action:{label:resumeOffer.actionLabel||'继续阅读 →',onClick:resumeOffer.onResume}});}
  const resumeButton=tool('history','阅读记录',openResume);resumeButton.classList.add('reader-record-tool');resumeButton.disabled=true;leading.append(resumeButton);
  function dressJump(button,edge,active=false){dress(button,active?'history':edge==='top'?'up':'down',active?'返回跳转前的阅读位置':'前往页面'+(edge==='top'?'顶部':'底部'));button.querySelector('.reader-tool-label').textContent=active?'返回原位':edge==='top'?'顶部':'底部';}
  const jumps=document.createElement('div');jumps.className='reader-jump-tools';jumps.setAttribute('aria-label','页面跳转');
  const jumpButtons={};for(const [id,key,label] of [['nav-top','top','顶部'],['nav-bottom','bottom','底部']]){const button=q('#'+id);if(!button)continue;dressJump(button,key);button.classList.add('reader-jump-button');jumps.append(button);jumpButtons[key]=button;}
  leading.append(jumps);q('.reading-navigation')?.remove();
  const jumpController=createReaderJumpController(
   ()=>({x:window.scrollX,y:window.scrollY,anchor:typeof readingAnchor==='function'?readingAnchor():null}),
   edge=>{if(typeof readingBottomIntent!=='undefined')readingBottomIntent=edge==='bottom';if(typeof beginFigureJump==='function')beginFigureJump(edge==='top'?0:document.documentElement.scrollHeight);window.scrollTo({top:edge==='top'?0:document.documentElement.scrollHeight,behavior:'smooth'});},
   saved=>{if(typeof readingBottomIntent!=='undefined')readingBottomIntent=!!saved.anchor?.atBottom;if(saved.anchor&&typeof restoreArticleScroll==='function')restoreArticleScroll({scroll:saved.anchor});else {if(typeof beginFigureJump==='function')beginFigureJump(saved.y);window.scrollTo({top:saved.y,left:saved.x,behavior:'smooth'});}},
   active=>{for(const [edge,button]of Object.entries(jumpButtons)){const label=edge==='top'?'顶部':'底部';dressJump(button,edge,active===edge);button.setAttribute('aria-pressed',String(active===edge));}}
  );
  if(new URLSearchParams(location.search).has('review')){
    const badge=document.createElement('span');badge.className='reader-review-badge';badge.textContent='审稿';actions.append(badge);
  }
  const settings=document.createElement('details');settings.className='reader-layout-menu';
  const layoutTitle=document.createElement('summary');dress(layoutTitle,'layout','阅读布局');settings.append(layoutTitle);
  const settingsBody=document.createElement('div');settingsBody.className='reader-layout-options';
  const layout=q('.layout-choice'),swap=q('#pane-swap');
  if(layout)settingsBody.append(layout);if(swap)settingsBody.append(swap);settings.append(settingsBody);ending.append(settings);
  const currentImage=q('#panel-figure-image');if(currentImage){currentImage.fetchPriority='high';currentImage.decoding='async';}
  const original=q('.top-link');if(original){
    ending.append(dress(original,'link','阅读原文'));
    new MutationObserver(()=>{if(!original.querySelector('svg'))dress(original,'link','阅读原文');}).observe(original,{childList:true});
  }
  const more=document.createElement('details');more.className='reader-more-menu';
  const moreTitle=document.createElement('summary');dress(moreTitle,'more','更多阅读工具');more.append(moreTitle);
  const moreBody=document.createElement('div');moreBody.className='reader-more-body';more.append(moreBody);ending.append(more);
  const mobileQuery=window.matchMedia?.('(max-width:700px)');
  function arrangeToolbar(){
    const mobile=mobileQuery?mobileQuery.matches:innerWidth<=700;more.hidden=!mobile;
    if(mobile){moreBody.append(resumeButton,jumps,actions);if(original)moreBody.append(original);}
    else {leading.append(resumeButton,jumps);ending.prepend(actions);if(original)ending.insertBefore(original,more);more.open=false;}
  }
  mobileQuery?.addEventListener('change',arrangeToolbar);arrangeToolbar();
  if(q('.top-actions'))q('.top-actions').hidden=true;
  let openPanel=null,returnFocus=null;
  const backdrop=document.createElement('div');backdrop.className='reader-panel-shade';backdrop.hidden=true;document.body.append(backdrop);
  async function closePanel() {
    if(!openPanel)return;
    const panel=openPanel;openPanel=null;panel.hidden=true;backdrop.hidden=true;
    document.body.classList.remove('reader-outline-open');
    if(panel.dataset.outline){
      window.ReadOutlineOpen=false;
      if(typeof reflowReaderLayout==='function')await reflowReaderLayout();
    }
    panel._trigger?.setAttribute('aria-expanded','false');
    returnFocus?.focus({preventScroll:true});
  }
  async function showPanel(panel,trigger) {
    // The drawer and a sentence editor share one reading workspace.
    document.querySelectorAll('.member-review-editor').forEach(editor=>{editor.hidden=true;});
    globalThis.CSS?.highlights?.delete('read-pending-annotation');
    if(openPanel===panel){await closePanel();return;}
    await closePanel();returnFocus=trigger;openPanel=panel;panel.hidden=false;panel._trigger=trigger;
    panel.querySelectorAll('.reader-panel-body > details').forEach(d=>{d.open=true;});
    trigger.setAttribute('aria-expanded','true');backdrop.hidden=!panel.classList.contains('reader-dialog');
    if(panel.dataset.outline){
      window.ReadOutlineOpen=true;document.body.classList.add('reader-outline-open');
      if(typeof reflowReaderLayout==='function')await reflowReaderLayout();
    }
    panel.querySelector('.reader-panel-close')?.focus({preventScroll:true});
  }
  function panel(title,dialog=false) {
    const box=document.createElement('section');box.className=dialog?'reader-panel reader-dialog':'reader-panel';
    box.hidden=true;box.setAttribute('role',dialog?'dialog':'region');box.setAttribute('aria-label',title);
    const head=document.createElement('div');head.className='reader-panel-head';
    const heading=document.createElement('h2');heading.textContent=title;
    const close=tool('close','关闭'+title,closePanel);close.classList.add('reader-panel-close');head.append(heading,close);
    const body=document.createElement('div');body.className='reader-panel-body';box.append(head,body);document.body.append(box);return box;
  }
  backdrop.addEventListener('click',closePanel);
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){closePanel();settings.open=false;more.open=false;if(annotationButton?.getAttribute('aria-pressed')==='true')annotationButton.click();setHighlighter(false);}
    if(e.key==='Tab'&&openPanel?.classList.contains('reader-dialog')){
      const nodes=[...openPanel.querySelectorAll('button:not(:disabled),a[href],input,select,textarea,summary')].filter(n=>n.getClientRects().length);
      if(!nodes.length)return;
      if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1).focus();}
      else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0].focus();}
    }
  });
  document.addEventListener('pointerdown',e=>{if(!settings.contains(e.target))settings.open=false;if(!more.contains(e.target))more.open=false;});
  moreBody.addEventListener('click',event=>{if(event.target.closest('button,a'))more.open=false;});
  const outline=panel('文章大纲');outline.classList.add('reader-outline');outline.dataset.outline='true';
  const outlineButton=tool('outline','文章大纲',()=>showPanel(outline,outlineButton));outlineButton.setAttribute('aria-expanded','false');leading.prepend(outlineButton);
  const outlineBody=outline.querySelector('.reader-panel-body');let headingNodes=[],headingSignature='';
  function buildOutline() {
    const headings=[...q('#article').querySelectorAll('h2,h3,h4')];
    const signature=headings.map(h=>h.textContent).join('|');if(signature===headingSignature)return;
    headingSignature=signature;headingNodes=headings;outlineBody.replaceChildren();const groups=[];
    headings.forEach((h,i)=>{
      if(!h.id)h.id='reader-section-'+i;
      const a=document.createElement('a');a.href='#'+h.id;a.textContent=h.textContent;a.dataset.target=h.id;
      a.addEventListener('click',async e=>{
        e.preventDefault();
        if(innerWidth<901)await closePanel();
        if(typeof beginFigureJump==='function')beginFigureJump(h.getBoundingClientRect().top+window.scrollY-(parseFloat(getComputedStyle(h).scrollMarginTop)||0));
        h.scrollIntoView({behavior:'smooth',block:'start'});
      });
      const level=Number(h.tagName[1]);
      while(groups.length&&groups.at(-1).level>=level)groups.pop();
      const parent=groups.at(-1)?.node||outlineBody;
      if(headings[i+1]&&Number(headings[i+1].tagName[1])>level){
        const group=document.createElement('details');group.open=true;
        const title=document.createElement('summary');title.append(a);group.append(title);outlineBody.append(group);
        parent.append(group);groups.push({level,node:group});
      }else{a.className=level>2?'reader-outline-child':'';parent.append(a);}
    });
  }
  let scrollTick=false;
  window.addEventListener('scroll',()=>{
    if(scrollTick)return;scrollTick=true;requestAnimationFrame(()=>{
      scrollTick=false;let active=headingNodes[0];for(const h of headingNodes){if(h.getBoundingClientRect().top<160)active=h;else break;}
      outlineBody.querySelectorAll('a').forEach(a=>{if(a.dataset.target===active?.id)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');});
    });
  },{passive:true});
  new MutationObserver(buildOutline).observe(q('#article'),{childList:true,subtree:true});buildOutline();
  const source=q('#member-reader-tools');
  let notesPanel=null,annotationButton=null,notesTrigger=null;
  function setHighlighter(enabled){document.body.classList.toggle('read-highlighter-on',enabled===true);}
  document.addEventListener('read-highlighter-change',event=>setHighlighter(event.detail?.enabled));
  function convertDetails(detail,title,key,dialog) {
    if(detail.dataset.chrome)return;detail.dataset.chrome='true';
    const box=panel(title,dialog);box.querySelector('.reader-panel-body').append(detail);
    if(key==='notes')notesPanel=box;
    if(key==='export')box.classList.add('reader-export-dialog');
    if(key==='versions'){box.classList.add('reader-outline','reader-versions');box.dataset.outline='true';}
    detail.querySelector(':scope > summary').hidden=true;
    if(key==='notes'&&annotationButton){notesTrigger=null;return;}
    const trigger=tool(key,key==='notes'?'批注记录':title,()=>{more.open=false;showPanel(box,trigger);});trigger.setAttribute('aria-expanded','false');actions.append(trigger);
    if(key==='notes')notesTrigger=trigger;
  }
  function tidyMemberTools() {
    if(!source)return;
    source.querySelectorAll('.member-reader-actions button').forEach(b=>{
      if(b.dataset.chrome)return;
      const label=b.textContent.trim();
      const key=label.includes('收藏')?'star':['荧光笔','批注'].includes(label)?'pen':null;
      if(!key)return;
      b.dataset.chrome='true';b.dataset.controlLabel=label;(key==='pen'?annotationSlot:actions).append(b);if(key==='pen')penPlaceholder.remove();dress(b,key,label);
      if(key==='pen'){annotationButton=b;dress(b,'pen','荧光笔');b.addEventListener('pointerdown',event=>event.preventDefault());setHighlighter(b.getAttribute('aria-pressed')==='true');new MutationObserver(()=>setHighlighter(b.getAttribute('aria-pressed')==='true')).observe(b,{attributes:true,attributeFilter:['aria-pressed']});}
      if(key==='star'){
        const update=()=>{if(b.querySelector('svg'))return;const text=b.textContent;dress(b,'star',text);b.setAttribute('aria-pressed',String(text==='已收藏'));};
        b.setAttribute('aria-pressed',String(label==='已收藏'));new MutationObserver(update).observe(b,{childList:true});
      }
    });
    source.querySelectorAll('.member-notes-panel').forEach(d=>convertDetails(d,'批注','notes',false));
    source.querySelectorAll('.member-version-panel').forEach(d=>convertDetails(d,'版本记录','versions',false));
    source.querySelectorAll('.reader-historical-banner').forEach(n=>{n.classList.add('reader-historical-status');actions.prepend(n);});
    source.querySelectorAll('.member-export-panel').forEach(d=>convertDetails(d,'公众号导出','export',true));
    source.querySelectorAll('.member-review-decisions').forEach(d=>convertDetails(d,'提交审核','review',true));
    const extras=source.querySelector('.member-review-tools .member-reader-actions');
    if(extras&&!extras.dataset.chrome){
      extras.dataset.chrome='true';
      notesPanel?.querySelector('.reader-panel-body').prepend(extras);
      extras.querySelectorAll('button').forEach(b=>b.addEventListener('click',closePanel));
    }
  }
  if(source){new MutationObserver(tidyMemberTools).observe(source,{childList:true,subtree:true});tidyMemberTools();}
  document.addEventListener('read-members-expired',()=>{
    void closePanel();
    document.querySelectorAll('.reader-panel:not(.reader-outline)').forEach(n=>n.remove());
    actions.replaceChildren();annotationSlot.replaceChildren(penPlaceholder);setHighlighter(false);resumeOffer=null;resumeButton.disabled=true;resumeNotice?.close();resumeNotice=null;
    notesPanel=annotationButton=notesTrigger=null;
    if(new URLSearchParams(location.search).has('review')){
      outlineBody.replaceChildren();headingNodes=[];outlineButton.disabled=true;
    }
  });
  const message=q('#reading-preparation-message');
  const timer=setInterval(()=>{
    if(!document.body.classList.contains('reader-preparing')){clearInterval(timer);return;}
    if(message&&/^正在准备阅读/.test(message.textContent))message.textContent='正在准备阅读'+'.'.repeat(1+(Math.floor(Date.now()/450)%3));
  },450);
  window.ReadChrome={closePanel,refresh:tidyMemberTools,setHighlighter,offerResume(offer){if(!offer||typeof offer.onResume!=='function')return;resumeOffer=offer;resumeButton.disabled=false;openResume();},clearResume(){resumeOffer=null;resumeButton.disabled=true;resumeNotice?.close();resumeNotice=null;},openResume,openNotes:trigger=>notesPanel&&showPanel(notesPanel,trigger||notesTrigger||annotationButton),jump:edge=>jumpController.jump(edge)};
  window.addEventListener('read-public-update',()=>{
    globalThis.ReadToast?.show({key:'article-update',kind:'info',duration:8000,message:'本文已有更新。',action:{label:'载入新版',onClick:()=>location.reload()}});
  });
})();
