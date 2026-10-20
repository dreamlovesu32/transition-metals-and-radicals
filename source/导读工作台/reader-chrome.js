/* Shared reading chrome. Article text and member permissions stay with their owners. */
(() => {
  'use strict';
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
    review:'m5 12 4 4L19 6'
  };
  function icon(name) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path');
    path.setAttribute('d',paths[name]||paths.notes);svg.append(path);return svg;
  }
  function dress(node,name,label) {
    node.classList.add('reader-tool');node.setAttribute('aria-label',label);node.title=label;
    node.replaceChildren(icon(name));return node;
  }
  function tool(name,label,action) {
    const b=document.createElement('button');b.type='button';dress(b,name,label);
    if(action)b.addEventListener('click',action);return b;
  }
  const bar=document.createElement('nav');bar.className='reader-toolbar';bar.setAttribute('aria-label','阅读工具');
  const leading=document.createElement('div'),actions=document.createElement('div'),ending=document.createElement('div');
  leading.className=actions.className=ending.className='reader-tool-group';
  actions.id='reader-member-actions';bar.append(leading,actions,ending);
  q('.topbar').after(bar);
  const catalog=q('#nav-catalog');if(catalog)q('.brand').after(catalog);
  for(const [id,key,label] of [['nav-prev','prev','上一篇'],['nav-next','next','下一篇']])if(q('#'+id))leading.append(dress(q('#'+id),key,label));
  const jumps=document.createElement('div');jumps.className='reader-jumps';jumps.setAttribute('aria-label','页面跳转');
  for(const [id,key,label] of [['nav-top','up','返回顶部'],['nav-bottom','down','前往底部']])if(q('#'+id))jumps.append(dress(q('#'+id),key,label));
  document.body.append(jumps);q('.reading-navigation')?.remove();
  if(new URLSearchParams(location.search).has('review')){
    const badge=document.createElement('span');badge.className='reader-review-badge';badge.textContent='审稿';leading.append(badge);
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
    if(e.key==='Escape'){closePanel();settings.open=false;}
    if(e.key==='Tab'&&openPanel?.classList.contains('reader-dialog')){
      const nodes=[...openPanel.querySelectorAll('button:not(:disabled),a[href],input,select,textarea,summary')].filter(n=>n.getClientRects().length);
      if(!nodes.length)return;
      if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1).focus();}
      else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0].focus();}
    }
  });
  document.addEventListener('pointerdown',e=>{if(!settings.contains(e.target))settings.open=false;});
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
  let notesPanel=null;
  function convertDetails(detail,title,key,dialog) {
    if(detail.dataset.chrome)return;detail.dataset.chrome='true';
    const box=panel(title,dialog);box.querySelector('.reader-panel-body').append(detail);
    if(key==='notes')notesPanel=box;
    if(key==='versions'){box.classList.add('reader-outline','reader-versions');box.dataset.outline='true';}
    detail.querySelector(':scope > summary').hidden=true;
    const trigger=tool(key,title,()=>showPanel(box,trigger));trigger.setAttribute('aria-expanded','false');actions.append(trigger);
  }
  function tidyMemberTools() {
    if(!source)return;
    source.querySelectorAll('.member-reader-actions button').forEach(b=>{
      if(b.dataset.chrome)return;
      const label=b.textContent.trim();
      const key=label.includes('收藏')?'star':label==='荧光笔'?'pen':null;
      if(!key)return;
      b.dataset.chrome='true';b.dataset.controlLabel=label;actions.append(b);dress(b,key,label);
      if(key==='star'){
        const update=()=>{if(b.querySelector('svg'))return;const text=b.textContent;dress(b,'star',text);b.setAttribute('aria-pressed',String(text==='已收藏'));};
        b.setAttribute('aria-pressed',String(label==='已收藏'));new MutationObserver(update).observe(b,{childList:true});
      }
    });
    source.querySelectorAll('.member-notes-panel').forEach(d=>convertDetails(d,'批注与笔记','notes',false));
    source.querySelectorAll('.member-version-panel').forEach(d=>convertDetails(d,'版本记录','versions',false));
    source.querySelectorAll('.reader-historical-banner').forEach(n=>{n.classList.add('reader-historical-status');actions.prepend(n);});
    source.querySelectorAll('.member-export-panel').forEach(d=>convertDetails(d,'导出素材','export',true));
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
    actions.replaceChildren();
    if(new URLSearchParams(location.search).has('review')){
      outlineBody.replaceChildren();headingNodes=[];outlineButton.disabled=true;
    }
  });
  const message=q('#reading-preparation-message');
  const timer=setInterval(()=>{
    if(!document.body.classList.contains('reader-preparing')){clearInterval(timer);return;}
    if(message&&/^正在准备阅读/.test(message.textContent))message.textContent='正在准备阅读'+'.'.repeat(1+(Math.floor(Date.now()/450)%3));
  },450);
  window.ReadChrome={closePanel,refresh:tidyMemberTools};
  window.addEventListener('read-public-update',()=>{
    if(q('.reader-update-notice'))return;
    const update=document.createElement('button');update.type='button';update.className='reader-update-notice';
    update.textContent='本文已有更新 · 载入新版';update.addEventListener('click',()=>location.reload());document.body.append(update);
  });
})();
