/* Versioned, pure reading-plan compiler. Does not modify article snapshots. */
(function(root) {
 "use strict";
 function compile(article, blocks) {
  const has = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
  const object = o => o && typeof o === "object" && !Array.isArray(o);
  const allowed = (o, keys) => object(o) && Object.keys(o).every(k=>keys.includes(k));
  const fraction = (v, name, open=false) => {if(typeof v!=="number" || !Number.isFinite(v) || (open ? v<=0||v>=1 : v<0||v>1))throw new Error(`Invalid ${name}`);return v;};
  const config = has(article,"reading") ? article.reading : {};
  if(!allowed(config,["version","downThreshold","upBuffer","endBuffer","switches"]) || (has(article,"reading") && config.version!==1))throw new Error("Invalid reading settings/version");
  const overrides = has(config,"switches") ? config.switches : [];
  if(!Array.isArray(overrides) || !Array.isArray(blocks) || !blocks.length)throw new Error("Invalid reading blocks/switches");
  const result = {version:1,downThreshold:fraction(has(config,"downThreshold") ? config.downThreshold : has(article,"scrollThreshold") ? article.scrollThreshold : .52,"downThreshold",true),upBuffer:fraction(has(config,"upBuffer") ? config.upBuffer : .18,"upBuffer"),endBuffer:fraction(has(config,"endBuffer") ? config.endBuffer : .25,"endBuffer"),switches:[]};
  const ids=new Set(), figures=[];
  // Full manifests have figures; API snapshots expose the same allowed assets as figurePages.
  const assets=new Set(article.figures ? article.figures.map(f=>`figures/${f.file}`) : Object.keys(article.figurePages || {}));
  for(const block of blocks){
   if(!object(block)||typeof block.id!=="string"||!block.id.trim()||ids.has(block.id))throw new Error("Missing or duplicate block id");
   ids.add(block.id);
   if(!["title","heading","paragraph","figure","bullet","number","quote","table"].includes(block.kind))throw new Error("Unsupported block kind");
   if(block.kind==="heading"&&(!Number.isInteger(has(block,"level")?block.level:2)||(block.level??2)<2||(block.level??2)>4))throw new Error("Invalid heading level");
   if(block.kind==="figure"){if(!assets.has(block.src))throw new Error("Unlisted figure asset");figures.push(block);}
   else if(has(block,"scrollTrigger"))throw new Error("Invalid scrollTrigger");
  }
  if(!figures.length)throw new Error("Article requires figures");
  const figureIds=new Set(figures.map(b=>b.id)), byId=new Map(), last=figures.at(-1).id;
  for(const item of overrides){
   if(!allowed(item,["figureId","trigger","anchorId"])||!figureIds.has(item.figureId)||byId.has(item.figureId)||!["block","article-end"].includes(item.trigger))throw new Error("Invalid figure switch");
   if(item.trigger==="article-end"&&(item.figureId!==last||has(item,"anchorId")))throw new Error("article-end requires final figure without anchor");
   if(item.trigger==="block"&&!ids.has(has(item,"anchorId") ? item.anchorId : item.figureId))throw new Error("Unknown anchorId");
   byId.set(item.figureId,item);
  }
  result.switches=figures.map(block=>{
   if(block.scrollTrigger!=null&&(block.scrollTrigger!=="article-end"||block.id!==last))throw new Error("Invalid legacy trigger");
   const item=byId.get(block.id)||{trigger:block.scrollTrigger||"block"};
   const entry={figureId:block.id,trigger:item.trigger};
   if(item.trigger==="block")entry.anchorId=has(item,"anchorId") ? item.anchorId : block.id;
   return entry;
  });
  return result;
 }
 const api=Object.freeze({compile});
 if(typeof module!=="undefined"&&module.exports)module.exports=api;
 root.ReadArticle=api;
})(typeof window!=="undefined"?window:globalThis);

"use strict";

let documentState = null;
const currentLanguage = "zh";
let figureBlocks = [];
let currentFigureIndex = 0;
let figureAuto = true;
let figureFillPane = false;
let figureScale = 1;
const inlineFigureScales = new Map();
const activeFigureTouchPointers = new Set();
let figureObserver = null;
let scrollQueued = false;
const DEFAULT_PANE_RATIO = .45;
let paneRatio = DEFAULT_PANE_RATIO;
let layoutPreference = "auto";
let paneSide = "right";
let changingLayout = false;
let panePointerId = null;
let paneFitQueued = false;
let restoringReadingState = false;
let readingRestoreInterrupted = false;
let restoreStartScrollY = 0;
let readingSaveTimer = null;
let readingBottomIntent = false;
let panelFigureRequest = 0;
let panelFigureReady = Promise.resolve("ready");
let pendingPanelViewport = null;
let pendingInlinePositions = null;
let readingPreparationSaved = null;
let readingPrepared = false;
let preparationAttempt = 0;
let imageRetryNumber = 0;
const backgroundFigureImages = [];
let figurePreloadActive=false,figurePreloadQueued=false;
const IMAGE_READY_TIMEOUT_MS = 12000;
const $ = selector => document.querySelector(selector);
const requestedArticleId = new URLSearchParams(location.search).get("article");
const reviewMode = new URLSearchParams(location.search).get("review") === "1";
const requestedVersion = new URLSearchParams(location.search).get("version");
let reviewDraft = null;
let reviewIdentity = null;
async function reviewMemberBridge() {
  if(window.ReadEnsureMembers)return window.ReadEnsureMembers();
  // The reader precedes members.js in the deferred script queue.
  if (!window.ReadMembers && document.readyState !== "complete") await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, {once:true}));
  if(window.ReadEnsureMembers)return window.ReadEnsureMembers();
  if (!window.ReadMembers) throw Object.assign(new Error("账号组件尚未准备好。"),{kind:"resource",code:"member_script_unavailable",publicMessage:"账号组件尚未准备好，当前页面已保留。"});
  return window.ReadMembers;
}
function assertReviewIdentity() {
  const state = window.ReadMembers?.state;
  if (!reviewIdentity || state?.expired || state?.user?.role !== "admin" || state.epoch !== reviewIdentity.epoch || state.user.id !== reviewIdentity.uid) throw Object.assign(new Error("登录状态已变化，请使用管理员账号重新打开稿件"),{kind:"identity",code:"identity_changed",publicMessage:"登录状态已变化，请使用当前管理员账号完成验证。"});
}
function clearPrivateReview() {
  if (!reviewMode) return;
  restoringReadingState = true;
  preloadOtherFigures.cancel?.();
  delete requestPanelFigure.pendingCandidate;
  panelFigureRequest += 1;
  preparationAttempt += 1;
  reviewDraft = null;
  documentState = null;
  figureBlocks = [];
  figureObserver?.disconnect();
  backgroundFigureImages.forEach(img => img.removeAttribute("src"));
  backgroundFigureImages.length = 0;
  document.querySelectorAll("#article img, #panel-figure-image").forEach(img => img.removeAttribute("src"));
  $("#article").replaceChildren();
  $("#toc").replaceChildren();
  $("#member-reader-tools").replaceChildren();
  $("#figure-canvas .panel-media-preview")?.remove();
  $("#panel-figure-caption").textContent = "";
  showPreparationFailure("登录状态已变化，请使用管理员账号重新打开稿件。");
}
const ui = {zh:{source:"原文 / 第",page:"页",figureNote:"论文原图裁切 · 下方按钮缩放，放大后可双向滚动"}};
function tr(key) { return ui.zh[key]; }
function articleId() { return documentState?.article?.id || requestedArticleId; }
function articleAsset(path) {
  if (reviewMode) {
    const assetId = documentState?.asset_map?.[path];
    if (!assetId || !/^[\w-]+$/.test(assetId)) throw new Error("稿件图片尚未就绪");
    return requestedVersion ? `/api/member/admin/drafts/${encodeURIComponent(articleId())}/versions/${encodeURIComponent(requestedVersion)}/assets/${encodeURIComponent(assetId)}` : `/api/member/admin/drafts/${encodeURIComponent(articleId())}/assets/${encodeURIComponent(assetId)}`;
  }
  if(window.ReadWorkbenchRead) return window.ReadWorkbenchRead.asset(path, articleId());
  if(documentState?.cloudPublished)return window.ReadPublished.asset(articleId(),documentState.asset_map?.[path],documentState.review_version_hash);
  return `./figures/${encodeURIComponent(articleId())}/${encodeURIComponent(path.split("/").pop())}`;
}

function adaptReviewDraft(draft, expectedId) {
  const content = typeof draft.body === "string" ? JSON.parse(draft.body) : draft.body;
  if ((requestedVersion && draft.version_hash !== requestedVersion) || draft.id !== expectedId || content?.article?.id !== expectedId || !Array.isArray(content.blocks) || !draft.version_hash) throw new Error("稿件信息不完整，请重新打开");
  const assets = new Set((draft.assets || []).map(asset => asset.id));
  for (const block of content.blocks) {
    if (block.kind === "figure" && !assets.has(content.asset_map?.[block.src])) throw new Error("稿件图片尚未就绪");
  }
  return {...content, version_hash:draft.version_hash};
}

function configureReviewNavigation() {
  for (const selector of ["#nav-catalog", "#footer-catalog", ".topbar .brand", ".reading-preparation-actions a"]) {
    const link = $(selector);
    link.href = "./member-system/admin.html";
    link.setAttribute("aria-label", "返回稿件审核");
    if (selector !== ".topbar .brand") link.textContent = "返回稿件审核";
  }
  for (const selector of ["#nav-prev", "#nav-next"]) { $(selector).disabled = true; $(selector).hidden = true; }
  document.body.dataset.reviewMode = "true";
}
function figurePage(src) { return documentState?.article?.figurePages?.[src] ?? "?"; }

function updateReadingChrome() {
  document.documentElement.lang = "zh-CN";
  document.title = `${documentState.article.title.zh} · 文献导读`;
  $(".eyebrow").innerHTML = `<span class="eyebrow-line"></span> ${documentState.article.kind === "review" ? "综述" : "研究论文"} <span class="separator">/</span> 导读`;
  $(".top-link").href = documentState.article.sourceUrl;
  updatePanelFigurePosition();
  $("#figure-stage").removeAttribute("title");
  $(".figure-scale-controls").removeAttribute("title");
  setFigureAuto(figureAuto);
  setFigureFillPane(figureFillPane);
  setFigureScale(figureScale);
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
function inlineMarkdown(text) { return window.ReadInline.html(text); }


// Canonical reader rendering, media, layout and progress. Data adapters live separately.
function blockElement(block) {
  const wrap = document.createElement("section");
  wrap.className = "block";
  wrap.dataset.blockId = block.id;
  if (block.kind === "figure") wrap.dataset.figureIndex = String(figureBlocks.findIndex(item => item.id === block.id));
  if (block.kind === "heading") wrap.id = "section-" + block.id;
  let content;
  switch (block.kind) {
    case "title": content = `<h1 class="article-title">${inlineMarkdown(block.text)}</h1>`; break;
    case "heading": {
      const level = Math.min(Math.max(block.level || 2,2),4);
      content = `<h${level}>${inlineMarkdown(block.text)}</h${level}>`; break;
    }
    case "bullet": content = `<ul><li>${inlineMarkdown(block.text)}</li></ul>`; break;
    case "number": content = `<p class="numbered">${inlineMarkdown(block.text)}</p>`; break;
    case "quote": content = `<blockquote>${inlineMarkdown(block.text)}</blockquote>`; break;
    case "table": content = `<p class="table-line">${inlineMarkdown(block.text)}</p>`; break;
    case "figure": {
      const page = figurePage(block.src);
      const number = Number(wrap.dataset.figureIndex) + 1;
      const label = `原图 ${number}`;
      content = `<figure class="source-figure"><div class="inline-figure-viewport"><div class="inline-figure-stage progressive-media" tabindex="0" aria-label="${label}，放大后可双向滚动"><div class="inline-figure-canvas">${figureImageMarkup(block, `${tr("source")}${page}${tr("page")}`)}</div></div><div class="inline-figure-status" role="status">正在载入当前原图…</div></div><div class="inline-figure-toolbar" role="group" aria-label="${label}缩放"><button type="button" class="inline-zoom-out" aria-label="${label}缩小">−</button><button type="button" class="inline-zoom-in" aria-label="${label}放大">＋</button><button type="button" class="inline-zoom-fit" aria-label="${label}适应">适应</button></div><figcaption class="figure-caption"><span class="figure-label">${tr("source")}${page}${tr("page")}</span><p>${inlineMarkdown(block.text)}</p></figcaption><div class="figure-source">${tr("figureNote")}</div></figure>`;
      break;
    }
    default: content = `<p>${inlineMarkdown(block.text)}</p>`;
  }
  wrap.innerHTML = content;
  window.ReadBlockTools?.attach?.(block, wrap);
  if (block.kind === "figure") {
    installDragPan(wrap.querySelector(".inline-figure-stage"));
    const image = wrap.querySelector(".inline-figure-canvas img");
    image.addEventListener("load", async () => {
      try {await decodeFigureImage(image);} catch {image.dispatchEvent(new Event("error")); return;}
      window.ReadMedia?.reveal(image);
      applyInlineFigureScale(wrap, false);
      const position = pendingInlinePositions?.[wrap.dataset.blockId];
      if (position) requestAnimationFrame(() => {
        if (position !== pendingInlinePositions?.[wrap.dataset.blockId]) return;
        const viewport = wrap.querySelector(".inline-figure-stage");
        restoreScrollFraction(viewport,"x",position.x);
        restoreScrollFraction(viewport,"y",position.y);
      });
    });
    wrap.querySelector(".inline-zoom-out").addEventListener("click", () => setInlineFigureScale(wrap, inlineFigureScale(wrap) / 1.25));
    wrap.querySelector(".inline-zoom-in").addEventListener("click", () => setInlineFigureScale(wrap, inlineFigureScale(wrap) * 1.25));
    wrap.querySelector(".inline-zoom-fit").addEventListener("click", () => setInlineFigureScale(wrap, 1));
  }
  return wrap;
}

function renderArticle() {
  const article = $("#article");
  article.replaceChildren();
  $("#toc").replaceChildren();
  documentState.readingPlan = window.ReadArticle.compile(documentState.article, documentState.blocks);
  figureBlocks = documentState.blocks.filter(block => block.kind === "figure");
  const body = document.createElement("div");
  body.className = "article-body";
  const meta = document.createElement("div");
  meta.className = "article-meta";
  let sectionStarted = false;
  let metadataBlocks = 0;
  for (const block of documentState.blocks) {
    const node = blockElement(block);
    if (block.kind === "title") article.append(node);
    else if (!sectionStarted && block.kind === "heading" && metadataBlocks === 0 && !/^\d+\./.test(block.text)) {
      node.classList.add("article-deck");
      article.append(node);
    } else if (!sectionStarted && block.kind !== "heading" && metadataBlocks < 2) {
      meta.append(node);
      metadataBlocks += 1;
    } else {
      if (!sectionStarted) { article.append(meta); sectionStarted = true; }
      body.append(node);
    }
    if (block.kind === "heading") {
      const link = document.createElement("a");
      link.className = "toc-link";
      link.dataset.level = String(block.level || 2);
      link.href = "#section-" + block.id;
      link.textContent = block.text.replace(/\*|`/g, "");
      $("#toc").append(link);
    }
  }
  if (!sectionStarted) article.append(meta);
  article.append(body);
  renderFigurePanel();
  observeFigures();
  requestAnimationFrame(applyAllInlineFigureScales);
}

function inlineFigureScale(wrap) {
  return inlineFigureScales.get(wrap.dataset.blockId) || 1;
}

function applyInlineFigureScale(wrap, preserveCenter=true, anchor=null, immediate=false) {
  const stage = wrap.querySelector(".inline-figure-stage");
  const revision = stage.readScaleRevision = (stage.readScaleRevision || 0) + 1;
  const canvas = wrap.querySelector(".inline-figure-canvas");
  const image = canvas.querySelector("img");
  if (!image.naturalWidth || !stage.clientWidth || !stage.clientHeight) return;
  const scale = inlineFigureScale(wrap);
  const centerX = preserveCenter && stage.scrollWidth > stage.clientWidth ?
    (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : .5;
  const centerY = preserveCenter && stage.scrollHeight > stage.clientHeight ?
    (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : .5;
  const oldCanvas = canvas.getBoundingClientRect();
  const point = anchor && oldCanvas.width && oldCanvas.height ? {
    x: anchor.x, y: anchor.y,
    targetX: anchor.targetX ?? anchor.x,
    targetY: anchor.targetY ?? anchor.y,
    fractionX: Math.min(1, Math.max(0, (anchor.x - oldCanvas.left) / oldCanvas.width)),
    fractionY: Math.min(1, Math.max(0, (anchor.y - oldCanvas.top) / oldCanvas.height))
  } : null;
  const style = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight) * .98;
  canvas.style.width = `${Math.max(1, Math.floor(image.naturalWidth * fit * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(image.naturalHeight * fit * scale))}px`;
  stage.style.overflow = "auto";
  const finish = () => {
    if (revision !== stage.readScaleRevision) return;
    if (wrap.dataset.figureStartPending === "true") {
      stage.scrollLeft = 0; stage.scrollTop = 0;
      delete wrap.dataset.figureStartPending;
    } else if (point) {
      const resized = canvas.getBoundingClientRect();
      stage.scrollLeft += resized.left + point.fractionX * resized.width - point.targetX;
      stage.scrollTop += resized.top + point.fractionY * resized.height - point.targetY;
    } else {
      stage.scrollLeft = centerX * stage.scrollWidth - stage.clientWidth / 2;
      stage.scrollTop = centerY * stage.scrollHeight - stage.clientHeight / 2;
    }
    updateDragPanState(stage);
  };
  if (immediate) finish();
  else requestAnimationFrame(finish);
}

function resetInlineFigureOrigin(wrap) {
  if (!wrap) return;
  wrap.dataset.figureStartPending = "true";
  if (pendingInlinePositions) delete pendingInlinePositions[wrap.dataset.blockId];
  applyInlineFigureScale(wrap, false, null, true);
  const stage = wrap.querySelector(".inline-figure-stage");
  stage.scrollLeft = 0; stage.scrollTop = 0;
}

function updateDragPanState(stage) {
  const ready = stage.id !== "figure-stage" || stage.dataset.imageState === "ready";
  const overflow = stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1;
  stage.classList.toggle("can-drag", ready && overflow);
}

function installDragPan(stage) {
  let pointerId = null;
  let originX = 0, originY = 0, scrollX = 0, scrollY = 0;
  let pinch = null;
  let pinchFrame = 0;
  const touchScale = () => stage.id === "figure-stage" ? figureScale : inlineFigureScale(stage.closest(".block"));
  const flushPinch = () => {
    pinchFrame = 0;
    if (!pinch || pinch.startDistance <= 2 || pinch.distance <= 2) return;
    const next = pinch.startScale * pinch.distance / pinch.startDistance;
    const anchor = {x:pinch.lastX, y:pinch.lastY, targetX:pinch.x, targetY:pinch.y};
    if (stage.id === "figure-stage") setFigureScale(next, anchor, true);
    else setInlineFigureScale(stage.closest(".block"), next, anchor, true);
    pinch.lastX = pinch.x;
    pinch.lastY = pinch.y;
  };
  // Leave every one-finger gesture to the browser: momentum and scroll chaining
  // must not be reconstructed with pointer capture or script-driven page scrolling.
  const touchPair = event => [...event.targetTouches].slice(0, 2);
  const startPinch = event => {
    if (event.targetTouches.length < 2 || (stage.id === "figure-stage" && stage.dataset.imageState !== "ready")) return;
    if (event.cancelable) event.preventDefault();
    const [a,b] = touchPair(event);
    pinch = {startDistance:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),startScale:touchScale(),distance:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),x:(a.clientX+b.clientX)/2,y:(a.clientY+b.clientY)/2,lastX:(a.clientX+b.clientX)/2,lastY:(a.clientY+b.clientY)/2};
  };
  stage.addEventListener("touchstart", startPinch, {passive:false});
  stage.addEventListener("touchmove", event => {
    if (event.targetTouches.length < 2) return;
    if (stage.id === "figure-stage" && stage.dataset.imageState !== "ready") return;
    if (!pinch) startPinch(event);
    if (event.cancelable) event.preventDefault();
    const [a,b] = touchPair(event);
    pinch.distance = Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
    pinch.x = (a.clientX+b.clientX)/2;
    pinch.y = (a.clientY+b.clientY)/2;
    if (!pinchFrame) pinchFrame = requestAnimationFrame(flushPinch);
  }, {passive:false});
  const finishPinch = event => {
    if (event.type !== "touchcancel" && event.targetTouches.length >= 2) return;
    if (pinchFrame) {cancelAnimationFrame(pinchFrame);flushPinch();}
    pinch = null;
    updateDragPanState(stage);
  };
  stage.addEventListener("touchend", finishPinch, {passive:true});
  stage.addEventListener("touchcancel", finishPinch, {passive:true});
  stage.addEventListener("pointerenter", () => updateDragPanState(stage));
  stage.addEventListener("dragstart", event => event.preventDefault());
  stage.addEventListener("pointerdown", event => {
    updateDragPanState(stage);
    if (event.pointerType === "touch") return;
    if (event.pointerType !== "mouse" || event.button !== 0 || !stage.classList.contains("can-drag")) return;
    event.preventDefault();
    pointerId = event.pointerId;
    originX = event.clientX; originY = event.clientY;
    scrollX = stage.scrollLeft; scrollY = stage.scrollTop;
    stage.setPointerCapture(pointerId);
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") return;
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    stage.scrollLeft = scrollX - (event.clientX - originX);
    stage.scrollTop = scrollY - (event.clientY - originY);
  });
  const finish = event => {
    if (event.pointerType === "touch") return;
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    stage.classList.remove("is-dragging");
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    updateDragPanState(stage);
  };
  stage.addEventListener("pointerup", finish);
  stage.addEventListener("pointercancel", finish);
  stage.addEventListener("lostpointercapture", finish);
}

function setInlineFigureScale(wrap, value, anchor=null, immediate=false) {
  const scale = Math.min(5, Math.max(1, value));
  inlineFigureScales.set(wrap.dataset.blockId, scale);
  wrap.querySelector(".inline-zoom-out").disabled = scale <= 1;
  wrap.querySelector(".inline-zoom-in").disabled = scale >= 5;
  wrap.querySelector(".inline-zoom-fit").disabled = scale <= 1;
  applyInlineFigureScale(wrap, true, anchor, immediate);
  scheduleReadingSave();
}

function applyAllInlineFigureScales() {
  document.querySelectorAll("#article .block[data-figure-index]").forEach(wrap => {
    const scale = inlineFigureScale(wrap);
    wrap.querySelector(".inline-zoom-out").disabled = scale <= 1;
    wrap.querySelector(".inline-zoom-in").disabled = scale >= 5;
    wrap.querySelector(".inline-zoom-fit").disabled = scale <= 1;
    applyInlineFigureScale(wrap);
  });
}

function setPanelFigureState(state) {
  const stage = $("#figure-stage");
  const status = $("#panel-figure-status");
  stage.dataset.imageState = state;
  updateDragPanState(stage);
  status.hidden = state === "ready";
  stage.dataset.hasImage = String(state === "ready" && Boolean($("#panel-figure-image").naturalWidth));
  stage.setAttribute("aria-busy", String(state === "loading"));
  $("#panel-figure-status-message").textContent = state === "failed" ? "当前原图暂时无法载入，可重试" : "正在载入当前原图…";
  $("#panel-figure-retry").hidden = state !== "failed";
  $("#figure-zoom-out").disabled = state !== "ready" || figureScale <= 1;
  $("#figure-detail-zoom").disabled = state !== "ready" || figureScale >= 5;
  $("#figure-fit").disabled = state !== "ready" || figureScale <= 1;
  $("#figure-zoom").disabled = state !== "ready";
}

function handlePanelVisibleLoad(changed=false) {
  // Complete sizing before revealing the committed image; no old frame may recenter it.
  applyFigureScale(false, null, true);
  const stage = $("#figure-stage");
  if (changed) {
    pendingPanelViewport = null;
    stage.scrollLeft = 0; stage.scrollTop = 0;
  } else if (pendingPanelViewport) {
    restoreScrollFraction(stage, "x", pendingPanelViewport.x);
    restoreScrollFraction(stage, "y", pendingPanelViewport.y);
    pendingPanelViewport = null;
  }
}

function figureMedia(block) {
  return documentState?.article?.figureMedia?.[block.src] || {};
}

function figureImageMarkup(block, alt) {
  const media = figureMedia(block);
  const dimensions = media.width && media.height ? ` width="${media.width}" height="${media.height}"` : "";
  return `<img data-src="${articleAsset(block.src)}" alt="${alt}"${dimensions} decoding="async" loading="lazy">`;
}

async function decodeFigureImage(image) {
  if (!image.naturalWidth) throw new Error("图片无法解码");
  if (image.dataset.decoded === "true") return;
  if (typeof image.decode === "function") {
    if (!image.readDecodePromise) image.readDecodePromise = image.decode().catch(error => {delete image.readDecodePromise; throw error;});
    await image.readDecodePromise;
  }
  image.dataset.decoded = "true";
}

function primeCurrentFigure() {
  const blocks = documentState?.blocks?.filter(block => block.kind === "figure") || [];
  const block = blocks[Math.max(0, Math.min(currentFigureIndex, blocks.length - 1))];
  if (!block) return;
  const url = articleAsset(block.src);
  if (backgroundFigureImages.some(image => image.getAttribute("src") === url)) return;
  const image = new Image();
  image.decoding = "async"; image.fetchPriority = "high";
  image.dataset.figureSource = block.src;
  const media = figureMedia(block);
  if (media.width && media.height) {image.width = media.width; image.height = media.height;}
  backgroundFigureImages.push(image);
  // Start the known current original before building DOM or restoring layout.
  image.src = url;
}

function updatePanelFigurePosition() {
  const number = String(currentFigureIndex + 1).padStart(2, "0");
  $(".figure-panel-head .rail-kicker").textContent = currentLanguage === "zh" ? `原文配图 / ${number}` : `SOURCE FIGURES / ${number}`;
  $("#figure-position").textContent = `${number} / ${String(figureBlocks.length).padStart(2, "0")}`;
}

function commitPanelFigure(block) {
  const page = figurePage(block.src);
  $("#panel-figure-image").alt = `${tr("source")}${page}${tr("page")}`;
  updatePanelFigurePosition();
  $("#panel-figure-page").textContent = `${tr("source")}${page}${tr("page")}`;
  $("#panel-figure-caption").innerHTML = inlineMarkdown(block.text);
  $("#panel-figure-note").textContent = currentLanguage === "zh" ? "原论文裁图 · 栏内查看" : "Original paper crop";
}

function schedulePanelFigureRecovery(block, failedRequest, attempt=1) {
  if (typeof documentState==="undefined" || !documentState?.article || typeof fetch!=="function") return;
  const owner=readingIdentity();let stopped=false,timer=null,controller=null;
  const current=()=>!stopped && panelFigureRequest===failedRequest && sameReadingIdentity(owner);
  const stop=()=>{stopped=true;clearTimeout(timer);controller?.abort();if(requestPanelFigure.recovery?.stop===stop)delete requestPanelFigure.recovery;};
  const schedule=delay=>{timer=setTimeout(check,delay??Math.min(300000,1000*2**Math.min(attempt-1,9)));timer?.unref?.();};
  const check=async()=>{
    if(!current()){stop();return;}
    controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const response=await fetch(articleAsset(block.src),{credentials:"same-origin",cache:"no-store",signal:controller.signal});
      try{await response.body?.cancel();}catch{}
      if(!current()){stop();return;}
      if(response.ok && /^image\//i.test(response.headers.get("Content-Type")||"")){
        stop();const pending=requestPanelFigure(block,true,attempt),renewedRequest=panelFigureRequest;
        const result=await pending;
        if(result==="ready" && panelFigureRequest===renewedRequest && sameReadingIdentity(owner))await recoverReadingPreparationImage({target:$("#panel-figure-image")});
      } else if(!response.ok && [408,425,429,502,503,504].includes(response.status)) {
        attempt++;const retryAfter=Math.min(300000,Math.max(0,Number(response.headers.get("Retry-After"))||0)*1000);schedule(retryAfter||undefined);
      } else {
        console.warn("Read image recovery diagnostic",{scope:"panel-image",kind:response.ok?"protocol":"http",status:response.status||0});stop();
      }
    } catch {if(current()){attempt++;schedule();}}
    finally {clearTimeout(timeout);}
  };
  requestPanelFigure.recovery?.stop();requestPanelFigure.recovery={stop};schedule();
}

function requestPanelFigure(block, retry=false, recoveryAttempt=0) {
  requestPanelFigure.recovery?.stop();
  const requestId = ++panelFigureRequest;
  const base = articleAsset(block.src);
  const url = retry ? `${base}${base.includes("?") ? "&" : "?"}imageRetry=${++imageRetryNumber}` : base;
  const warm = backgroundFigureImages.find(item => item.getAttribute("src") === url && (!item.isConnected || item.id === "panel-figure-image"));
  const cachedReady = Boolean(warm?.complete && warm.naturalWidth && warm.dataset.decoded === "true");
  if (!cachedReady) setPanelFigureState("loading");
  panelFigureReady = new Promise(resolve => {
    const candidate = warm || new Image();
    requestPanelFigure.pendingCandidate=candidate;
    const media = figureMedia(block);
    candidate.decoding = "async"; candidate.fetchPriority = "high";
    if (media.width && media.height) {candidate.width = media.width; candidate.height = media.height;}
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      candidate.removeEventListener("load", loaded); candidate.removeEventListener("error", failed);
      if (requestId !== panelFigureRequest) {resolve("stale"); return;}
      if(requestPanelFigure.pendingCandidate===candidate)delete requestPanelFigure.pendingCandidate;
      if (result !== "ready") {setPanelFigureState("failed");preloadOtherFigures.trim?.();schedulePanelFigureRecovery(block,requestId,recoveryAttempt+1);resolve(result);return;}
      candidate.id = "panel-figure-image";
      const visible = $("#panel-figure-image");
      const changed = Boolean(visible.dataset.figureSource && (visible.dataset.figureSource !== block.src || (block.id && visible.dataset.figureBlockId !== block.id)));
      if (visible !== candidate) {visible.removeAttribute("id");visible.replaceWith(candidate);}
      candidate.dataset.figureSource = block.src;
      candidate.dataset.figureBlockId = block.id || "";
      if (!backgroundFigureImages.includes(candidate)) backgroundFigureImages.push(candidate);
      $("#figure-canvas .panel-media-preview")?.remove();
      commitPanelFigure(block); handlePanelVisibleLoad(changed); setPanelFigureState("ready");
      preloadOtherFigures.trim?.();
      resolve("ready");
    };
    const loaded = async () => {
      try {await decodeFigureImage(candidate); finish("ready");}
      catch {finish("error");}
    };
    const timer = setTimeout(() => finish("timeout"), IMAGE_READY_TIMEOUT_MS);
    const failed = () => finish("error");
    candidate.addEventListener("load", loaded); candidate.addEventListener("error", failed);
    if (cachedReady) {finish("ready"); return;}
    if (!warm) {candidate.dataset.figureSource = block.src; backgroundFigureImages.push(candidate); candidate.src = url;}
    if (candidate.complete) candidate.naturalWidth ? loaded() : failed();
  });
  return panelFigureReady;
}

function retryPanelFigure() {
  if (figureBlocks[currentFigureIndex]) return requestPanelFigure(figureBlocks[currentFigureIndex], true);
}

function showFigure(index, force=false) {
  if (!figureBlocks.length) return;
  const nextIndex = Math.max(0, Math.min(index, figureBlocks.length - 1));
  if (!force && nextIndex === currentFigureIndex) return;
  const changed = nextIndex !== currentFigureIndex;
  currentFigureIndex = nextIndex;
  const block = figureBlocks[currentFigureIndex];
  updatePanelFigurePosition();
  if (isDesktopLayout()) requestPanelFigure(block).then(result => {if (result === "ready" && readingPrepared) preloadOtherFigures();});
  if (!isDesktopLayout() && changed) resetInlineFigureOrigin(document.querySelector(`#article .block[data-figure-index="${nextIndex}"]`));
  $("#figure-prev").disabled = currentFigureIndex === 0;
  $("#figure-next").disabled = currentFigureIndex === figureBlocks.length - 1;
  $("#figure-edge-prev").disabled = currentFigureIndex === 0;
  $("#figure-edge-next").disabled = currentFigureIndex === figureBlocks.length - 1;
  const list = $("#figure-list");
  const buttons = list.querySelectorAll("button");
  buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === currentFigureIndex)));
  const selected = buttons[currentFigureIndex];
  if (selected) {
    const item = selected.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    if (item.left < viewport.left) list.scrollLeft += item.left - viewport.left - 5;
    else if (item.right > viewport.right) list.scrollLeft += item.right - viewport.right + 5;
  }
}

function setFigureFillPane(enabled) {
  figureFillPane = enabled;
  $(".left-rail").classList.toggle("figure-fill-pane", enabled);
  const button = $("#figure-zoom");
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = currentLanguage === "zh" ? (enabled ? "退出铺满" : "铺满") : (enabled ? "Exit fill" : "Fill pane");
  $("#figure-edge-prev").tabIndex = enabled ? 0 : -1;
  $("#figure-edge-next").tabIndex = enabled ? 0 : -1;
  requestAnimationFrame(() => applyFigureScale());
  scheduleReadingSave();
}

function applyFigureScale(preserveCenter=true, anchor=null, immediate=false) {
  const requestId = panelFigureRequest;
  const stage = $("#figure-stage");
  const image = $("#panel-figure-image");
  const canvas = $("#figure-canvas");
  if (!image.naturalWidth || !stage.clientWidth || !stage.clientHeight) return;
  stage.style.overflow = "auto";
  const centerX = preserveCenter && stage.scrollWidth > stage.clientWidth ?
    (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : .5;
  const centerY = preserveCenter && stage.scrollHeight > stage.clientHeight ?
    (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : .5;
  const oldCanvas = canvas.getBoundingClientRect();
  const point = anchor && oldCanvas.width && oldCanvas.height ? {
    x: anchor.x,
    y: anchor.y,
    targetX: anchor.targetX ?? anchor.x,
    targetY: anchor.targetY ?? anchor.y,
    fractionX: Math.min(1, Math.max(0, (anchor.x - oldCanvas.left) / oldCanvas.width)),
    fractionY: Math.min(1, Math.max(0, (anchor.y - oldCanvas.top) / oldCanvas.height))
  } : null;
  const style = getComputedStyle(stage);
  const availableWidth = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const availableHeight = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const fit = Math.min(availableWidth / image.naturalWidth, availableHeight / image.naturalHeight) * .98;
  canvas.style.width = `${Math.max(1, Math.floor(image.naturalWidth * fit * figureScale))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(image.naturalHeight * fit * figureScale))}px`;
  const finish = () => {
    if (requestId !== panelFigureRequest || image !== $("#panel-figure-image")) return;
    if (point) {
      const resized = canvas.getBoundingClientRect();
      stage.scrollLeft += resized.left + point.fractionX * resized.width - point.targetX;
      stage.scrollTop += resized.top + point.fractionY * resized.height - point.targetY;
    } else {
      stage.scrollLeft = centerX * stage.scrollWidth - stage.clientWidth / 2;
      stage.scrollTop = centerY * stage.scrollHeight - stage.clientHeight / 2;
    }
    updateDragPanState(stage);
  };
  if (immediate) finish();
  else requestAnimationFrame(finish);
}

function setFigureScale(value, anchor=null, immediate=false) {
  figureScale = Math.min(5, Math.max(1, value));
  const ready = $("#figure-stage").dataset.imageState === "ready";
  $("#figure-zoom-out").disabled = !ready || figureScale <= 1;
  $("#figure-detail-zoom").disabled = !ready || figureScale >= 5;
  $("#figure-fit").disabled = !ready || figureScale <= 1;
  applyFigureScale(true, anchor, immediate);
  scheduleReadingSave();
}

function wheelDeltaPixels(event, stage) {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, stage.clientHeight);
  return event.deltaY;
}

function handleFigureWheel(event) {
  if (!event.ctrlKey || !event.currentTarget.contains(event.target)) return;
  event.preventDefault();
  const stage = $("#figure-stage");
  if (stage.dataset.imageState !== "ready") return;
  const delta = wheelDeltaPixels(event, stage);
  if (!Number.isFinite(delta) || delta === 0) return;
  const factor = Math.exp(-Math.max(-300, Math.min(300, delta)) * .0025);
  const next = Math.min(5, Math.max(1, figureScale * factor));
  if (next === figureScale) return;
  const anchor = stage.contains(event.target) ? {x:event.clientX, y:event.clientY} : null;
  setFigureScale(next, anchor);
}

function schedulePaneFigureFit() {
  if (paneFitQueued) return;
  paneFitQueued = true;
  requestAnimationFrame(() => {
    paneFitQueued = false;
    applyFigureScale();
  });
}

function applyPaneRatio(requested=paneRatio) {
  if (!isDesktopLayout() || document.body.classList.contains("source-pending")) return;
  const layout = $(".layout");
  const divider = $("#pane-divider");
  const available = layout.getBoundingClientRect().width - divider.offsetWidth;
  if (available <= 0) return;
  const min = Math.max(.3, 340 / available);
  const max = Math.min(.7, 1 - 380 / available);
  paneRatio = Math.min(max, Math.max(min, requested));
  layout.style.setProperty("--figure-pane-width", `${available * paneRatio}px`);
  const leftPercent = Math.round(paneRatio * 100);
  divider.setAttribute("aria-valuemin", String(Number((min * 100).toFixed(1))));
  divider.setAttribute("aria-valuemax", String(Number((max * 100).toFixed(1))));
  divider.setAttribute("aria-valuenow", String(Number((paneRatio * 100).toFixed(1))));
  divider.setAttribute("aria-valuetext", currentLanguage === "zh" ?
    `原图在${paneSide === "left" ? "左" : "右"}侧，占${leftPercent}%；正文占${100 - leftPercent}%` :
    `Figure on ${paneSide}, ${leftPercent}%; article ${100 - leftPercent}%`);
  schedulePaneFigureFit();
  scheduleReadingSave();
}

function paneRatioAt(clientX) {
  const layout = $(".layout");
  const divider = $("#pane-divider");
  const rect = layout.getBoundingClientRect();
  const available = rect.width - divider.offsetWidth;
  return paneSide === "right" ?
    (rect.right - clientX - divider.offsetWidth / 2) / available :
    (clientX - rect.left - divider.offsetWidth / 2) / available;
}

function endPaneDrag(event) {
  if (event.pointerId !== panePointerId) return;
  panePointerId = null;
  document.body.classList.remove("pane-resizing");
  const divider = $("#pane-divider");
  if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  schedulePaneFigureFit();
}

function handlePaneKey(event) {
  let requested;
  if (event.key === "Home") requested = DEFAULT_PANE_RATIO;
  else if (event.key === "ArrowLeft") requested = paneRatio + (paneSide === "right" ? 1 : -1) * (event.shiftKey ? .05 : .02);
  else if (event.key === "ArrowRight") requested = paneRatio + (paneSide === "right" ? -1 : 1) * (event.shiftKey ? .05 : .02);
  else return;
  event.preventDefault();
  applyPaneRatio(requested);
}

function setFigureAuto(enabled) {
  figureAuto = enabled;
  const button = $("#figure-auto");
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = enabled ? (currentLanguage === "zh" ? "● 自动" : "● Auto") : (currentLanguage === "zh" ? "Ⅱ 恢复自动" : "Ⅱ Resume auto");
  button.title = enabled ? (currentLanguage === "zh" ? "随正文自动切换图片" : "Follow the article") : (currentLanguage === "zh" ? "手动切图已暂停联动，点击恢复" : "Manual choice paused following; click to resume");
  syncFigureToScroll.jumpTarget = null;
  if (enabled) syncFigureToScroll(true);
  scheduleReadingSave();
}

function chooseFigure(index) {
  saveReadingState.progressed=true;
  setFigureAuto(false);
  showFigure(index);
}

function renderFigurePanel() {
  const list = $("#figure-list");
  list.replaceChildren();
  figureBlocks.forEach((block, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(index + 1).padStart(2,"0");
    button.title = `${tr("source")}${figurePage(block.src)}${tr("page")}`;
    button.setAttribute("aria-label", `${currentLanguage === "zh" ? "显示原图" : "Show source figure"} ${index + 1}`);
    button.addEventListener("click", () => chooseFigure(index));
    list.append(button);
  });
  showFigure(Math.min(currentFigureIndex, figureBlocks.length - 1), true);
  setFigureAuto(figureAuto);
}

function isReadingAtEnd(scrollY, viewportHeight, contentHeight) {
  // Document heights and scroll offsets can differ by fractional CSS pixels.
  return viewportHeight > 0 && scrollY + viewportHeight >= contentHeight - 6;
}

function articleEndFigureIndex() {
  const switches = documentState?.readingPlan?.switches;
  const index = switches ? switches.findIndex(item => item.trigger === "article-end") : figureBlocks.findIndex(block => block.scrollTrigger === "article-end");
  return index === figureBlocks.length - 1 ? index : -1;
}

function readingVisibleHeight() {
  const toolbar = document.querySelector?.(".reader-toolbar") || document.querySelector?.(".topbar");
  const headerBottom = toolbar?.getBoundingClientRect?.().bottom || 0;
  return Math.max(1, window.innerHeight - Math.max(0, headerBottom));
}

function selectAutoFigure(tops, current, endIndex, downLine, visibleHeight, bottomGap, atEnd, force=false, settings={}) {
  if (atEnd && tops.length) return tops.length - 1;
  let next = 0;
  tops.forEach((top, index) => {if (index !== endIndex && top <= downLine) next = index;});
  if (force || current < 0 || current >= tops.length) return next;
  if (current === tops.length - 1 && bottomGap < visibleHeight * (settings.endBuffer ?? .25)) return current;
  if (endIndex >= 0 && current === endIndex) return bottomGap < visibleHeight * (settings.endBuffer ?? .25) ? endIndex : next;
  if (next >= current) return next;
  const upLine = downLine + visibleHeight * (settings.upBuffer ?? .18);
  let previous = 0;
  tops.forEach((top, index) => {if (index !== endIndex && top <= upLine) previous = index;});
  return Math.min(current, previous);
}

function resetAutoFigureTracking() {
  syncFigureToScroll.jumpTarget = null;
  syncFigureToScroll(true);
}

function beginFigureJump(targetY) {
  if (!figureAuto || !isDesktopLayout() || !Number.isFinite(targetY)) return;
  const scroller = document.scrollingElement || document.documentElement;
  const max = Math.max(0, Math.max(scroller.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight);
  syncFigureToScroll.jumpTarget = Math.max(0, Math.min(max, targetY));
  syncFigureToScroll(true);
}

function cancelFigureJump(event) {
  if (event.target?.closest?.(".figure-stage,.inline-figure-stage")) return;
  if (syncFigureToScroll.jumpTarget != null) resetAutoFigureTracking();
}

function syncFigureToScroll(force=false) {
  if (restoringReadingState || !figureBlocks.length) return;
  if (!isDesktopLayout()) {
    syncFigureToScroll.jumpTarget = null;
    if (!readingPrepared) return;
    const wrap = currentInlineFigure();
    const index = Number(wrap?.dataset.figureIndex);
    if (Number.isInteger(index) && index !== currentFigureIndex) {currentFigureIndex = index; updatePanelFigurePosition(); resetInlineFigureOrigin(wrap); preloadOtherFigures();}
    return;
  }
  if (!figureAuto) return;
  const scroller = document.scrollingElement || document.documentElement;
  const contentHeight = Math.max(scroller.scrollHeight, document.documentElement.scrollHeight);
  const max = Math.max(0, contentHeight - window.innerHeight);
  const jump = syncFigureToScroll.jumpTarget;
  const targetY = jump == null ? window.scrollY : Math.max(0, Math.min(max, jump));
  if (jump != null) {
    syncFigureToScroll.jumpTarget = Math.abs(window.scrollY - targetY) <= 6 ? null : targetY;
  }
  const plan = documentState.readingPlan;
  const allBlocks = [...document.querySelectorAll(".block[data-block-id]")];
  const anchors = plan ? plan.switches.map(item => allBlocks.find(node => node.dataset.blockId === (item.anchorId || item.figureId))) : [...document.querySelectorAll(".block[data-figure-index]")];
  const tops = anchors.map(anchor => anchor.getBoundingClientRect().top + window.scrollY - targetY);
  const downLine = window.innerHeight * (documentState.readingPlan?.downThreshold ?? documentState.article?.scrollThreshold ?? .52);
  const index = selectAutoFigure(tops, currentFigureIndex, articleEndFigureIndex(), downLine,
    readingVisibleHeight(), Math.max(0, contentHeight - window.innerHeight - targetY),
    isReadingAtEnd(targetY, window.innerHeight, contentHeight), force === true || (!readingPrepared && !readingPreparationSaved) || jump != null, documentState.readingPlan);
  showFigure(index);
}

function observeFigures() {
  figureObserver?.disconnect();
  if (!figureBlocks.length) return;
  figureObserver = new IntersectionObserver(() => syncFigureToScroll(), {rootMargin:"-20% 0px -40% 0px"});
  document.querySelectorAll(".block[data-figure-index]").forEach(node => figureObserver.observe(node));
  requestAnimationFrame(syncFigureToScroll);
}

function isDesktopLayout() {
  return !window.ReadOutlineOpen && layoutPreference !== "single" && window.innerWidth >= 901;
}

function applyLayoutPreference() {
  document.body.classList.toggle("reader-outline-open", !!window.ReadOutlineOpen);
  const mode = isDesktopLayout() ? "desktop" : "single";
  document.body.dataset.readerLayout = mode;
  document.body.dataset.paneSide = paneSide;
  const control = $("#layout-mode");
  if (control) {
    control.value = layoutPreference;
    control.title = layoutPreference === "double" && mode === "single" ?
      "双栏需至少 901 像素宽；当前为单栏，窗口变宽后自动切换" : "选择阅读布局";
  }
  const swap = $("#pane-swap");
  if (swap) {
    swap.hidden = mode !== "desktop";
    swap.title = paneSide === "left" ? "把原图移到右侧" : "把原图移到左侧";
  }
  return mode;
}

function loadLayoutPreference() {
  try {
    const stored = localStorage.getItem("reading-desk:layout");
    layoutPreference = ["auto", "double", "single"].includes(stored) ? stored : "auto";
    paneSide = localStorage.getItem("reading-desk:pane-side") === "left" ? "left" : "right";
  } catch(error) { layoutPreference = "auto"; paneSide = "right"; }
  applyLayoutPreference();
}

async function reflowReaderLayout(nextPreference=layoutPreference, nextPaneSide=paneSide) {
  if (changingLayout || !documentState?.article) return;
  const before = captureReadingState();
  saveReadingState();
  changingLayout = true;
  restoringReadingState = true;
  layoutPreference = nextPreference;
  paneSide = nextPaneSide;
  try {
    localStorage.setItem("reading-desk:layout", layoutPreference);
    localStorage.setItem("reading-desk:pane-side", paneSide);
  } catch(error) {}
  applyLayoutPreference();
  if (isDesktopLayout()) showFigure(currentFigureIndex, true);
  const modePositions = storedReadingState();
  const panelPosition = before.mode === "desktop" ? before.figure : modePositions?.figure || before.figure;
  const inlinePositions = before.mode === "single" ? before.inline : modePositions?.inline || before.inline;
  await animationFrame();
  applyPaneRatio();
  applyFigureScale(false);
  applyAllInlineFigureScales();
  await animationFrame();
  restoreArticleScroll(before);
  restoreScrollFraction($("#figure-stage"), "x", panelPosition.x);
  restoreScrollFraction($("#figure-stage"), "y", panelPosition.y);
  document.querySelectorAll("#article .block[data-figure-index]").forEach(wrap => {
    const position = inlinePositions[wrap.dataset.blockId];
    if (!position) return;
    const stage = wrap.querySelector(".inline-figure-stage");
    restoreScrollFraction(stage, "x", position.x);
    restoreScrollFraction(stage, "y", position.y);
  });
  restoringReadingState = false;
  changingLayout = false;
  resetAutoFigureTracking();
  scheduleReadingSave();
}

function readingMode() {
  return document.body.dataset.readerLayout || (isDesktopLayout() ? "desktop" : "single");
}

function readingIdentity() {
  const state=window.ReadMembers?.state;
  return {uid:state?.user?.id||"guest",epoch:state?.epoch||0,document:documentState,hash:documentState?.version_hash};
}

function sameReadingIdentity(owner) {
  const now=readingIdentity();return owner.document===now.document&&owner.hash===now.hash&&owner.uid===now.uid&&owner.epoch===now.epoch;
}

function readingKey(mode=readingMode()) {
  return `${window.ReadMembers?.state.user?.id || "guest"}:reading-desk:v2:${reviewMode ? "review:" : ""}${articleId()}:${documentState.version_hash}:${mode}`;
}

function clearReadingActivity() {
  clearTimeout(readingSaveTimer);readingSaveTimer=null;saveReadingState.progressed=false;
  resumeRemoteProgress.refresh=null;window.ReadChrome?.clearResume?.();
}

function scrollFraction(element, axis) {
  const horizontal = axis === "x";
  const range = horizontal ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
  const value = horizontal ? element.scrollLeft : element.scrollTop;
  return range > 0 ? Math.max(0, Math.min(1, value / range)) : 0;
}

function restoreScrollFraction(element, axis, fraction) {
  const horizontal = axis === "x";
  const range = horizontal ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
  const value = Math.max(0, Math.min(1, Number(fraction) || 0)) * Math.max(0, range);
  if (horizontal) element.scrollLeft = value;
  else element.scrollTop = value;
}

function readingAnchor() {
  const blocks = [...document.querySelectorAll("#article .block[data-block-id]:not([data-figure-index])")];
  let anchor = blocks[0];
  const line=readingSectionInset()+2;
  for (const block of blocks) {
    const heading=block.querySelector("h2,h3,h4");
    const marker=heading||block;
    if (marker.getBoundingClientRect().top > line) {
      // Outline targets sit just below this line; keep that visible heading,
      // rather than an earlier paragraph whose height changes on reflow.
      if (heading && marker.getBoundingClientRect().top <= line + 16) anchor=block;
      break;
    }
    anchor = block;
  }
  const top = anchor ? anchor.getBoundingClientRect().top + window.scrollY : 0;
  const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  return {blockId:anchor?.dataset.blockId || null, offset:window.scrollY - top,
          fraction:max ? window.scrollY / max : 0, atBottom:readingBottomIntent || (max > 0 && max - window.scrollY < 5)};
}

function captureReadingState() {
  const stage = $("#figure-stage");
  const inline = {};
  document.querySelectorAll("#article .block[data-figure-index]").forEach(wrap => {
    const viewport = wrap.querySelector(".inline-figure-stage");
    inline[wrap.dataset.blockId] = {scale:inlineFigureScale(wrap),
      x:scrollFraction(viewport,"x"), y:scrollFraction(viewport,"y")};
  });
  return {version:1, article:articleId(), documentVersion:documentState.version_hash, savedAt:Date.now(), mode:readingMode(),
    scroll:readingAnchor(), sectionId:readingSectionId(), paneRatio,
    figure:{index:currentFigureIndex, auto:figureAuto, fill:figureFillPane,
      scale:figureScale, x:scrollFraction(stage,"x"), y:scrollFraction(stage,"y")},
    inline};
}

function saveReadingState() {
  clearTimeout(readingSaveTimer);readingSaveTimer=null;
  if(restoringReadingState || !documentState?.article || !readingPrepared || !saveReadingState.progressed)return false;
  if(window.ReadMembers && window.ReadMembers.state.authStatus!=="ready")return false;
  const owner=readingIdentity(),key=readingKey(),captured=captureReadingState();
  saveReadingState.previous ||= new Map();
  if(!saveReadingState.previous.has(key))saveReadingState.previous.set(key,storedReadingState());
  if(!sameReadingIdentity(owner))return false;
  try {
    const encoded=JSON.stringify(captured);localStorage.setItem(key,encoded);
    if(localStorage.getItem(key)!==encoded)throw Error("storage verification failed");
  } catch(error) {
    window.ReadToast?.show({key:"reading-storage",kind:"error",message:"阅读位置尚未保存到此设备，请稍后重试。"});return false;
  }
  if(!reviewMode && sameReadingIdentity(owner))window.ReadMembers?.saveProgress(articleId(),documentState.version_hash,captured);
  return true;
}

function scheduleReadingSave() {
  if(restoringReadingState || !documentState?.article)return;
  clearTimeout(readingSaveTimer);const owner=readingIdentity();
  readingSaveTimer=setTimeout(()=>{if(sameReadingIdentity(owner))saveReadingState();},180);
}

function storedReadingState(mode=readingMode()) {
  try {
    const state=JSON.parse(localStorage.getItem(readingKey(mode)));
    return state?.version===1&&state.article===articleId()&&state.documentVersion===documentState.version_hash&&state.mode===mode?state:null;
  } catch(error) {return null;}
}

function animationFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

function imageSettled(image) {
  if (image.complete) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { image.removeEventListener("load", done); image.removeEventListener("error", done); resolve(); };
    image.addEventListener("load", done);
    image.addEventListener("error", done);
    setTimeout(done, 2500);
  });
}

function handleReadingScroll() {
  if (changingLayout) return;
  if(readingPrepared&&!restoringReadingState&&window.ReadReaderTouched&&window.scrollY>24)saveReadingState.progressed=true;
  resumeRemoteProgress.refresh?.();
  if (restoringReadingState && documentState?.article && Math.abs(window.scrollY - restoreStartScrollY) > 5) {
    readingRestoreInterrupted = true;
    restoringReadingState = false;
    readingBottomIntent = false;
  }
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => { scrollQueued = false; syncFigureToScroll(); scheduleReadingSave(); });
}

function restoreArticleScroll(saved) {
  const scroll = saved?.scroll;
  if (!scroll) return;
  const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const block = [...document.querySelectorAll("#article .block[data-block-id]")]
    .find(node => node.dataset.blockId === scroll.blockId);
  const target = scroll.atBottom ? max : block ?
    block.getBoundingClientRect().top + window.scrollY + (Number(scroll.offset) || 0) :
    max * Math.max(0, Math.min(1, Number(scroll.fraction) || 0));
  if (restoringReadingState) syncFigureToScroll.jumpTarget = null;
  else beginFigureJump(Math.max(0, Math.min(max, target)));
  window.scrollTo({top:Math.max(0, Math.min(max, target)), behavior:"instant"});
}

async function restoreReadingState(saved) {
  if (!saved) { restoringReadingState = false; return; }
  await document.fonts?.ready;
  if (readingRestoreInterrupted) return;
  await animationFrame();
  applyPaneRatio();
  applyFigureScale(false);
  applyAllInlineFigureScales();
  await animationFrame();
  await animationFrame();
  if (readingRestoreInterrupted) return;
  restoreArticleScroll(saved);
  if (saved.scroll?.atBottom) {
    const keepBottom = () => {
      if (readingBottomIntent) window.scrollTo({top:document.documentElement.scrollHeight,behavior:"instant"});
    };
    for (const delay of [100,400,1000]) setTimeout(keepBottom, delay);
  }
  const stage = $("#figure-stage");
  restoreScrollFraction(stage,"x",saved.figure?.x);
  restoreScrollFraction(stage,"y",saved.figure?.y);
  document.querySelectorAll("#article .block[data-figure-index]").forEach(wrap => {
    const position = saved.inline?.[wrap.dataset.blockId];
    if (!position) return;
    const viewport = wrap.querySelector(".inline-figure-stage");
    restoreScrollFraction(viewport,"x",position.x);
    restoreScrollFraction(viewport,"y",position.y);
  });
  restoringReadingState = false;
}

function currentInlineFigure() {
  const anchors = [...document.querySelectorAll("#article .block[data-figure-index]")];
  const threshold = innerHeight * (documentState.readingPlan?.downThreshold ?? documentState.article?.scrollThreshold ?? .52);
  let index = 0;
  anchors.forEach((anchor, i) => { if (anchor.getBoundingClientRect().top <= threshold) index = i; });
  return anchors[index] || null;
}

function waitForInlineImage(image) {
  if (!image) return Promise.resolve("ready");
  const primed = backgroundFigureImages.find(item => item.getAttribute("src") === image.dataset.src && !item.isConnected && item.id !== "panel-figure-image");
  if (primed && primed !== image) {
    primed.alt = image.alt; primed.dataset.src = image.dataset.src;
    image.replaceWith(primed); image = primed;
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      image.removeEventListener("load", loaded); image.removeEventListener("error", failed);
      resolve(result);
    };
    const loaded = async () => {try {await decodeFigureImage(image); window.ReadMedia?.reveal?.(image); finish("ready");} catch {finish("error");}};
    const failed = () => finish("error");
    const timer = setTimeout(() => finish("timeout"), IMAGE_READY_TIMEOUT_MS);
    image.addEventListener("load", loaded); image.addEventListener("error", failed);
    window.ReadMedia?.load(image, "high"); image.loading = "eager";
    if (image.complete && image.getAttribute("src")) image.naturalWidth ? loaded() : failed();
  });
}

function preloadOtherFigures() {
  if(!documentState || !figureBlocks.length)return;
  if(isDesktopLayout()&&$("#figure-stage").dataset.imageState!=="ready")return;
  const identity=reviewMode?`${reviewIdentity?.uid}:${reviewIdentity?.epoch}`:"public";
  let session=preloadOtherFigures.session;
  if(session && (session.snapshot!==documentState || session.identity!==identity))session.cancel();
  if(!session || session.cancelled){
    session={snapshot:documentState,identity,attempted:new Set(),inlineAttempted:new Set(),active:false,cancelled:false,timer:null,stop:null,batch:0};
    session.cancel=()=>{
      session.cancelled=true;clearTimeout(session.timer);session.ticket=null;session.stop?.();
      for(let i=backgroundFigureImages.length-1;i>=0;i--){const image=backgroundFigureImages[i];if(image.readPreloadOwner===session&&!image.isConnected&&image!==requestPanelFigure.pendingCandidate){image.removeAttribute('src');backgroundFigureImages.splice(i,1);}}
      if(preloadOtherFigures.session===session)figurePreloadActive=false;
    };
    preloadOtherFigures.session=session;
    preloadOtherFigures.cancel=()=>preloadOtherFigures.session?.cancel();
  }
  preloadOtherFigures.trim=()=>{
    // Images adopted by the article belong to the DOM and must never be blanked.
    const detached=backgroundFigureImages.filter(item=>!item.isConnected&&item!==requestPanelFigure.pendingCandidate);
    while(detached.length>6){const oldest=detached.shift(),at=backgroundFigureImages.indexOf(oldest);if(at>=0)backgroundFigureImages.splice(at,1);oldest.removeAttribute('src');}
  };
  preloadOtherFigures.trim();
  if(session.active)return;
  if(session.timer){clearTimeout(session.timer);session.timer=null;session.ticket=null;}
  const valid=()=>{
    if(session.cancelled || documentState!==session.snapshot)return false;
    if(reviewMode){try{assertReviewIdentity();if(`${reviewIdentity?.uid}:${reviewIdentity?.epoch}`!==session.identity)return false;}catch{return false;}}
    return true;
  };
  const schedule=delay=>{const ticket={};session.ticket=ticket;session.timer=setTimeout(()=>{if(session.ticket!==ticket)return;session.timer=null;pump();},delay);};
  const pump=()=>{
    if(session.active)return;
    if(!valid()){session.cancel();return;}
    if(isDesktopLayout()&&$("#figure-stage").dataset.imageState!=="ready"){if($("#figure-stage").dataset.imageState==="loading")schedule(100);return;}
    const order=[...(!isDesktopLayout()?[figureBlocks[currentFigureIndex]]:[]),...figureBlocks.slice(currentFigureIndex+1),...figureBlocks.slice(0,currentFigureIndex)];
    const wraps=[...document.querySelectorAll('#article .block[data-figure-index]')];
    let task;
    for(const block of order){
      const index=figureBlocks.indexOf(block),near=index>=currentFigureIndex&&index<=currentFigureIndex+2;
      const url=articleAsset(block.src),wrap=near?wraps.find(n=>n.dataset.blockId===block.id):null;
      const inline=wrap?.querySelector('.inline-figure-canvas img');
      if(near&&inline&&inline.dataset.decoded!=="true"&&!session.inlineAttempted.has(block.id)){task={block,url,near,wrap,image:inline};break;}
      if(!session.attempted.has(url)){task={block,url,near,wrap:null,image:null};break;}
    }
    if(!task)return;
    const {block,url,near,wrap}=task;
    session.attempted.add(url);if(wrap)session.inlineAttempted.add(block.id);
    // One low-priority background slot leaves bandwidth for a high-priority current image.
    const warm=backgroundFigureImages.find(image=>image.getAttribute('src')===url&&!image.isConnected&&image!==requestPanelFigure.pendingCandidate);
    const image=warm||new Image();
    image.readPreloadOwner=session;image.dataset.figureSource=block.src;image.decoding='async';image.fetchPriority=block===figureBlocks[currentFigureIndex]?'high':'low';image.loading='eager';
    if(!backgroundFigureImages.includes(image))backgroundFigureImages.push(image);
    session.active=true;figurePreloadActive=true;
    let settled=false;
    const finish=()=>{
      if(settled)return;settled=true;clearTimeout(timer);image.removeEventListener('load',loaded);image.removeEventListener('error',failed);session.stop=null;session.active=false;
      if(preloadOtherFigures.session===session)figurePreloadActive=false;
      preloadOtherFigures.trim();
      if(!valid()){session.cancel();return;}
      session.batch++;
      schedule(session.batch%4===0?32:0);
    };
    const loaded=async()=>{
      if(settled)return;
      if(settled||!valid()){finish();return;}
      // Explicit decoded originals stay near the current position; distant resources
      // warm the HTTP cache and release their bounded detached nodes naturally.
      if(near){try{await decodeFigureImage(image);}catch{finish();return;}}
      if(settled||!valid()){finish();return;}
      if(wrap){
        const inline=wrap.querySelector('.inline-figure-canvas img');
        await waitForInlineImage(inline);
        if(settled||!valid()){finish();return;}
        if(!isDesktopLayout())applyInlineFigureScale(wrap,false);
      }
      finish();
    };
    const failed=()=>finish(),timer=setTimeout(()=>{if(!image.isConnected&&image!==requestPanelFigure.pendingCandidate)image.removeAttribute('src');finish();},IMAGE_READY_TIMEOUT_MS);
    session.stop=()=>{if(!image.isConnected)image.removeAttribute('src');finish();};
    image.addEventListener('load',loaded);image.addEventListener('error',failed);
    if(!image.getAttribute('src'))image.src=url;
    if(image.complete)image.naturalWidth?loaded():failed();
  };
  pump();
}

async function recoverReadingPreparationImage(event) {
  const owner=showPreparationFailure.recoveryOwner;
  if (!owner || owner.document!==documentState || owner.attempt!==preparationAttempt || !documentState?.article || readingPrepared) return;
  if (reviewMode) {try {assertReviewIdentity();} catch {return;}}
  const current=isDesktopLayout()?$("#panel-figure-image"):currentInlineFigure()?.querySelector(".inline-figure-canvas img");
  if (event.target!==current || !current?.complete || !current.naturalWidth) return;
  showPreparationFailure.recoveryOwner=null;
  try {await finishReadingPreparation();}
  catch {showPreparationFailure("阅读准备暂未完成，当前内容已保留。");}
}

function showPreparationFailure(message, deferImageActions=false) {
  showPreparationFailure.recoveryOwner={document:documentState,attempt:preparationAttempt};
  clearTimeout(showPreparationFailure.actionsTimer);
  if (!showPreparationFailure.watchingImages) {
    document.addEventListener?.("load",recoverReadingPreparationImage,true);
    showPreparationFailure.watchingImages=true;
  }
  readingPrepared = false;
  document.body.classList.add("reader-preparing");
  $(".layout").inert = true; $("#reading-preparation").hidden = false;
  $("#reading-preparation-message").textContent = deferImageActions?"正在准备阅读…":message;
  $("#reading-preparation-retry").hidden = deferImageActions;
  $("#reading-preparation-continue").hidden = deferImageActions || !documentState?.article;
  if(deferImageActions){
    const owner=showPreparationFailure.recoveryOwner;
    showPreparationFailure.actionsTimer=setTimeout(()=>{
      if(readingPrepared || showPreparationFailure.recoveryOwner!==owner || owner.document!==documentState || owner.attempt!==preparationAttempt)return;
      $("#reading-preparation-message").textContent=message;
      $("#reading-preparation-retry").hidden=false;
      $("#reading-preparation-continue").hidden=!documentState?.article;
    },8000);
  }
}

function revealReadingContent(attempt) {
  if (attempt !== preparationAttempt) return;
  if(showPreparationFailure.actionsTimer)clearTimeout(showPreparationFailure.actionsTimer);
  showPreparationFailure.recoveryOwner=null;
  if (readingPreparationSaved?.scroll?.atBottom) window.scrollTo({top:document.documentElement.scrollHeight,behavior:"instant"});
  readingPrepared = true;
  $(".topbar").inert = false; $(".layout").inert = false;
  document.body.classList.remove("reader-preparing");
  $("#reading-preparation").hidden = true;
  window.ReadContentReady = true;
  document.dispatchEvent(new CustomEvent("read-content-ready"));
  if (window.ReadMedia) window.ReadMedia.inline($("#article"));
}

async function finishReadingPreparation(retry=false, textOnly=false) {
  const attempt = ++preparationAttempt;
  $("#reading-preparation-message").textContent = "正在准备阅读…";
  $("#reading-preparation-retry").hidden = true;
  $("#reading-preparation-continue").hidden = true;
  if (textOnly) {revealReadingContent(attempt); return;}
  let result;
  if (isDesktopLayout()) {
    if (retry) retryPanelFigure();
    // Layout/scroll restoration can supersede an image while it is decoding.
    do {const pending = panelFigureReady; result = await pending; if (pending === panelFigureReady) break;} while (attempt === preparationAttempt);
  } else {
    const wrap = currentInlineFigure();
    const image = wrap?.querySelector(".inline-figure-canvas img");
    if (wrap) currentFigureIndex = Number(wrap.dataset.figureIndex);
    if (retry && image) {
      const base = articleAsset(figureBlocks[currentFigureIndex].src);
      image.removeAttribute("src"); delete image.dataset.decoded;
      image.dataset.src = `${base}${base.includes("?") ? "&" : "?"}imageRetry=${++imageRetryNumber}`;
    }
    result = await waitForInlineImage(image);
    if (result === "ready" && wrap) applyInlineFigureScale(wrap, false);
  }
  if (attempt !== preparationAttempt) return;
  if (result !== "ready") {
    showPreparationFailure("正文已就绪，可先阅读正文。",true);
    return;
  }
  revealReadingContent(attempt);
  preloadOtherFigures();
}

// Resume uses stable section IDs; exact paragraph offsets remain layout-only.
function readingSectionInset() {
  const bottoms=[".topbar",".reader-toolbar"].map(selector=>document.querySelector(selector)?.getBoundingClientRect().bottom || 0);
  return Math.max(0,...bottoms.filter(Number.isFinite))+16;
}

function sectionHeading(id) {
  const block=documentState.blocks.find(item=>item.id===id&&item.kind==="heading");
  if(!block)return null;
  const wrap=[...document.querySelectorAll("#article .block[data-block-id]")].find(node=>node.dataset.blockId===id);
  const node=wrap?.querySelector("h2,h3,h4");
  return node?{block,node}:null;
}

function readingSectionId() {
  let id=null;
  // Match readingAnchor's nearby-heading band so reload resumes this section.
  const line=readingSectionInset()+18;
  for(const block of documentState.blocks.filter(item=>item.kind==="heading")){
    const heading=sectionHeading(block.id);
    if(heading&&heading.node.getBoundingClientRect().top<=line)id=block.id;
  }
  return id;
}

function resumeHeading(record) {
  if(record?.version!==1 || record.article!==articleId() || record.documentVersion!==documentState.version_hash)return null;
  // Explicitly saved IDs never fall back to a different heading if removed.
  if(Object.hasOwn(record,"sectionId"))return typeof record.sectionId==="string"?sectionHeading(record.sectionId):null;
  const index=documentState.blocks.findIndex(block=>block.id===record.scroll?.blockId);
  if(index<0)return null;
  const heading=documentState.blocks.slice(0,index+1).reverse().find(block=>block.kind==="heading");
  return heading?sectionHeading(heading.id):null;
}

function storedResumeState(previous=saveReadingState.previous) {
  const records=["desktop","single"].map(mode=>previous?.has(readingKey(mode))?previous.get(readingKey(mode)):storedReadingState(mode)).filter(Boolean);
  records.sort((a,b)=>(Number(b.savedAt)||0)-(Number(a.savedAt)||0));
  return records[0]||null;
}

function resumeTarget(record) {
  const heading=resumeHeading(record);if(!heading)return null;
  const max=Math.max(0,document.documentElement.scrollHeight-innerHeight);
  return Math.max(0,Math.min(max,heading.node.getBoundingClientRect().top+window.scrollY-readingSectionInset()));
}

function resumeChapter(record) {
  return (resumeHeading(record)?.block.text||"").replace(/[*`]/g,"");
}

function restoreResumeSection(record) {
  const target=resumeTarget(record);if(target===null)return false;
  readingBottomIntent=false;
  // An explicit section jump recalibrates the existing reading plan, even when
  // the previous manual figure choice paused following. Keep that pause afterward.
  const following=figureAuto;figureAuto=true;
  try{beginFigureJump(target);window.scrollTo({top:target,behavior:"instant"});syncFigureToScroll(true);}
  finally{figureAuto=following;}
  return true;
}

async function resumeRemoteProgress() {
  if(!window.ReadMembers)return;
  await window.ReadMembers.ready;
  if(window.ReadMembers.state.authStatus==="cached")await window.ReadMembers.refreshAuthSession();
  if(window.ReadMembers.state.authStatus!=="ready")return;
  const owner=readingIdentity();
  const current=()=>sameReadingIdentity(owner)&&!window.ReadMembers.state.expired;
  const key=readingKey(),previous=saveReadingState.previous;
  let candidate=storedResumeState(previous),offered="";
  const far=record=>{const target=resumeTarget(record);return target!==null&&Math.abs(target-window.scrollY)>Math.max(160,innerHeight*.35);};
  const offer=record=>{
    if(!current()||!far(record))return;
    const signature=JSON.stringify([record.sectionId,record.scroll,record.documentVersion]);if(signature===offered)return;
    candidate=record;offered=signature;
    window.ReadChrome?.offerResume?.({key,caption:`上次读到「${resumeChapter(record)}」`,label:resumeChapter(record),onResume:()=>{
      if(!current()||!far(record)){window.ReadChrome?.clearResume?.();return;}
      if(!restoreResumeSection(record))return;
      saveReadingState.progressed=true;
      if(!isDesktopLayout()){
        const wrap=currentInlineFigure(),image=wrap?.querySelector(".inline-figure-canvas img");
        void waitForInlineImage(image).then(()=>{if(current()&&wrap?.isConnected)applyInlineFigureScale(wrap,false);});
      }
      window.ReadChrome?.clearResume?.();scheduleReadingSave();preloadOtherFigures();
    }});
  };
  resumeRemoteProgress.refresh=()=>{if(!current()||(candidate&&!far(candidate)))window.ReadChrome?.clearResume?.();};
  document.addEventListener("read-members-expired",clearReadingActivity,{once:true});
  offer(candidate);
  if(reviewMode)return;
  const remote=await window.ReadMembers.loadProgress(articleId(),documentState.version_hash,candidate,readingMode(),()=>storedResumeState(null));
  if(current())offer(remote);
}

function mountReadingTools(metadata, readerTouched) {
  let mounted=null,owner=null,mounting=null;
  const attach=()=>{
    if(mounting)return mounting;
    mounting=(async()=>{
      const members=window.ReadMembers||await window.ReadEnsureMembers?.();if(!members)return;
      await members.ready;
      if(members.state.authStatus==="cached")await members.refreshAuthSession();
      if(members.state.authStatus!=="ready"||!members.state.libraryReady)return;
      const next=readingIdentity();if(owner&&sameReadingIdentity(owner))return;
      mounted?.destroy?.();owner=next;
      const mount=reviewMode?members.mountReviewReader:members.mountReader;
      mounted=mount({draft:reviewDraft,articleId:articleId(),revision:documentState.version_hash,snapshot:documentState,assetUrl:articleAsset,metadata,root:$("#article"),toolbar:$("#member-reader-tools"),figureRoot:$(".left-rail")});
      await resumeRemoteProgress(readerTouched);
    })().catch(error=>{window.ReadMembers?.recordOperationFailure?.("reader-tools","MOUNT",error);}).finally(()=>{mounting=null;window.ReadProgressPending=false;});
    return mounting;
  };
  document.addEventListener("read-members-ready",attach);
  document.addEventListener("read-members-available",attach);
  document.addEventListener("read-members-expired",()=>{mounted?.destroy?.();mounted=null;owner=null;});
  if(!window.ReadMembers&&document.readyState!=="complete")document.addEventListener("DOMContentLoaded",attach,{once:true});
  void attach();
}

function configureReadingNavigation(articles) {
  const index = articles.findIndex(item => item.id === articleId());
  const prev = $("#nav-prev");
  const next = $("#nav-next");
  prev.disabled = index < 1;
  next.disabled = index < 0 || index >= articles.length - 1;
  if (!prev.disabled) prev.dataset.articleId = articles[index - 1].id;
  if (!next.disabled) next.dataset.articleId = articles[index + 1].id;
}

function navigateToArticle(button) {
  if (button.disabled || !button.dataset.articleId) return;
  saveReadingState();
  location.href = `./read.html?article=${encodeURIComponent(button.dataset.articleId)}`;
}

async function start() {
  history.scrollRestoration = "manual";
  window.ReadProgressPending = !reviewMode;
  let readerTouched = false;
  const touched = () => { readerTouched = true;window.ReadReaderTouched=true; };
  for (const type of ["wheel","touchstart","pointerdown","keydown"]) window.addEventListener(type,touched,{once:true,passive:true});
  if (reviewMode) {
    configureReviewNavigation();
    document.addEventListener("read-members-expired", clearPrivateReview);
  }
  loadLayoutPreference();
  $("#reading-preparation-continue").addEventListener("click", () => finishReadingPreparation(false, true));
  $("#panel-figure-retry").addEventListener("click", retryPanelFigure);
  $("#reading-preparation-retry").addEventListener("click", () => {
    if (!documentState?.article) void prepareContent();
    else finishReadingPreparation(true);
  });
  let articles=[],navigationFlight=null,navigationFailed=false,contentFlight=null;
  const safeMessage=error=>window.ReadPublished?.failureMessage?.(error)||error?.publicMessage||"内容暂时无法读取，当前页面已保留。";
  const report=error=>window.ReadPublished?.reportReadFailure?.(error,"reader-start");
  function refreshReadingNavigation(refresh=false){
    if(navigationFlight)return navigationFlight;
    const transport=window.ReadWorkbenchRead||window.ReadPublished;
    navigationFlight=transport.catalog('./catalog.json',{refresh}).then(data=>{
      if(!Array.isArray(data.articles))throw Object.assign(Error('Invalid catalog'),{kind:'application',code:'invalid_catalog'});
      articles=data.articles;navigationFailed=false;window.ReadMembers?.setPublicCatalog?.(articles);configureReadingNavigation(articles);
    }).catch(error=>{navigationFailed=true;report(error);window.ReadToast?.show({key:'reader-navigation',kind:'error',message:safeMessage(error)});}).finally(()=>{navigationFlight=null;});
    return navigationFlight;
  }
  function prepareContent(){if(contentFlight)return contentFlight;contentFlight=readContent().finally(()=>{contentFlight=null;});return contentFlight;}
  async function readContent(){
   try {
    if (reviewMode) {
      if (!requestedArticleId || !/^[\w-]+$/.test(requestedArticleId)) throw new Error("稿件编号无效");
      await reviewMemberBridge();
      await (window.ReadMembers.authReady || window.ReadMembers.ready);
      reviewIdentity = {epoch:window.ReadMembers.state.epoch, uid:window.ReadMembers.state.user?.id};
      assertReviewIdentity();
      const url=`/api/member/admin/drafts/${encodeURIComponent(requestedArticleId)}${requestedVersion ? "?version="+encodeURIComponent(requestedVersion) : ""}`;
      const current=()=>{try{assertReviewIdentity();return true;}catch{return false;}};
      if(window.ReadPublished?.json)reviewDraft=await window.ReadPublished.json(url,15000,{fetchOptions:{credentials:"same-origin",cache:"no-store"},current});
      else {const response=await fetch(url,{credentials:"same-origin",cache:"no-store",signal:AbortSignal.timeout(15000)});if(!response.ok)throw Object.assign(Error('Draft read failed'),{kind:'http',status:response.status,code:'read_http_'+response.status});reviewDraft=await response.json();}
      assertReviewIdentity();
      documentState = adaptReviewDraft(reviewDraft, requestedArticleId);
    } else {
    const transport = window.ReadWorkbenchRead || window.ReadPublished;
    void refreshReadingNavigation();
    documentState = await transport.read(requestedArticleId,`./data/${encodeURIComponent(requestedArticleId)}.json`);
    }
    restoringReadingState = true;
    // Every opening starts at the top; saved positions are offered only after readiness.
    const saved=null;readingPreparationSaved=null;pendingPanelViewport=null;pendingInlinePositions=null;
    currentFigureIndex=0;saveReadingState.progressed=false;window.ReadReaderTouched=false;
    window.scrollTo({top:0,behavior:"instant"});
    primeCurrentFigure();
    updateReadingChrome();
    renderArticle();
    applyPaneRatio();
    restoreStartScrollY = window.scrollY;
    window.addEventListener("scroll", handleReadingScroll, {passive:true});
    await restoreReadingState(null);
    window.scrollTo({top:0,behavior:"instant"});
    syncFigureToScroll();
    await finishReadingPreparation();
    if (reviewMode) assertReviewIdentity();
    if (!reviewMode) configureReadingNavigation(articles);
    mountReadingTools(articles.find(a=>a.id===articleId()),()=>readerTouched);
  } catch(error) {
    report(error);restoringReadingState=false;
    if(reviewMode&&error.kind==='identity')clearPrivateReview();
    showPreparationFailure(safeMessage(error));
   }
  }
  await prepareContent();
  window.addEventListener('online',()=>{if(!readingPrepared){if(documentState?.article)void finishReadingPreparation(true);else void prepareContent();}else if(!reviewMode&&navigationFailed)void refreshReadingNavigation(true);});
  window.addEventListener('focus',()=>{if(!reviewMode&&navigationFailed)void refreshReadingNavigation(true);});
  $("#nav-top").addEventListener("click", () => {if(window.ReadChrome?.jump)return window.ReadChrome.jump("top");readingBottomIntent = false; beginFigureJump(0); window.scrollTo({top:0,behavior:"smooth"});});
  $("#nav-bottom").addEventListener("click", () => {if(window.ReadChrome?.jump)return window.ReadChrome.jump("bottom");readingBottomIntent = true; beginFigureJump(document.documentElement.scrollHeight); window.scrollTo({top:document.documentElement.scrollHeight,behavior:"smooth"});});
  window.addEventListener("wheel", event => {if(!event.ctrlKey) {readingBottomIntent = false; cancelFigureJump(event);}}, {passive:true});
  window.addEventListener("touchmove", event => {readingBottomIntent = false; cancelFigureJump(event);}, {passive:true});
  window.addEventListener("keydown", event => {if(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(event.key)) {readingBottomIntent = false; cancelFigureJump(event);}});
  $("#nav-prev").addEventListener("click", event => navigateToArticle(event.currentTarget));
  $("#nav-next").addEventListener("click", event => navigateToArticle(event.currentTarget));
  $("#nav-catalog").addEventListener("click", saveReadingState);
  $("#footer-catalog").addEventListener("click", saveReadingState);
  $("#footer-top").addEventListener("click", () => {if(window.ReadChrome?.jump)return window.ReadChrome.jump("top");readingBottomIntent = false; beginFigureJump(0); window.scrollTo({top:0,behavior:"smooth"});});
  $(".topbar .brand").addEventListener("click", saveReadingState);
  window.addEventListener("pagehide", saveReadingState);
  document.addEventListener("visibilitychange", () => {if(document.visibilityState === "hidden") saveReadingState();});
  $("#article").addEventListener("scroll", scheduleReadingSave, true);
  $("#figure-stage").addEventListener("scroll", scheduleReadingSave, {passive:true});
  installDragPan($("#figure-stage"));
  $("#article").addEventListener("click", scheduleReadingSave);
  $("#figure-zoom").addEventListener("click", () => setFigureFillPane(!figureFillPane));
  $("#figure-detail-zoom").addEventListener("click", () => setFigureScale(figureScale * 1.25));
  $("#figure-zoom-out").addEventListener("click", () => setFigureScale(figureScale / 1.25));
  $("#figure-fit").addEventListener("click", () => setFigureScale(1));
  $("#figure-prev").addEventListener("click", () => chooseFigure(currentFigureIndex - 1));
  $("#figure-next").addEventListener("click", () => chooseFigure(currentFigureIndex + 1));
  $("#figure-edge-prev").addEventListener("click", () => chooseFigure(currentFigureIndex - 1));
  $("#figure-edge-next").addEventListener("click", () => chooseFigure(currentFigureIndex + 1));
  $("#figure-auto").addEventListener("click", () => setFigureAuto(!figureAuto));
  $("#layout-mode").addEventListener("change", event => reflowReaderLayout(event.currentTarget.value));
  $("#pane-swap").addEventListener("click", () => reflowReaderLayout(layoutPreference, paneSide === "left" ? "right" : "left"));
  $(".left-rail").addEventListener("wheel", handleFigureWheel, {passive:false});
  const divider = $("#pane-divider");
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !isDesktopLayout()) return;
    event.preventDefault();
    panePointerId = event.pointerId;
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add("pane-resizing");
    applyPaneRatio(paneRatioAt(event.clientX));
  });
  divider.addEventListener("pointermove", event => {
    if (event.pointerId !== panePointerId) return;
    event.preventDefault();
    applyPaneRatio(paneRatioAt(event.clientX));
  });
  divider.addEventListener("pointerup", endPaneDrag);
  divider.addEventListener("pointercancel", endPaneDrag);
  divider.addEventListener("lostpointercapture", endPaneDrag);
  divider.addEventListener("dblclick", event => {event.preventDefault();applyPaneRatio(DEFAULT_PANE_RATIO);});
  divider.addEventListener("keydown", handlePaneKey);
  window.addEventListener("resize", () => {
    if (readingMode() !== (isDesktopLayout() ? "desktop" : "single")) {reflowReaderLayout();return;}
    applyPaneRatio();applyFigureScale();applyAllInlineFigureScales();
    if(readingBottomIntent)window.scrollTo({top:document.documentElement.scrollHeight,behavior:"instant"});
    resetAutoFigureTracking();
  });
}

start();
