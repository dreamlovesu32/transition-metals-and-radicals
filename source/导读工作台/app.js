"use strict";

let documentState = null;
let pendingSelection = null;
let activeEditor = null;
let currentLanguage = "zh";
let figureBlocks = [];
let currentFigureIndex = 0;
let figureAuto = true;
let figureFillPane = false;
let figureScale = 1;
const inlineFigureScales = new Map();
let figureObserver = null;
let scrollQueued = false;
const DEFAULT_PANE_RATIO = .45;
let paneRatio = DEFAULT_PANE_RATIO;
let layoutPreference = "auto";
let paneSide = "right";
let changingLayout = false;
let panePointerId = null;
let paneFitQueued = false;
const READING_TOOLS_ENABLED = false;
const $ = selector => document.querySelector(selector);
const requestedArticleId = new URLSearchParams(location.search).get("article");
let catalogArticles = [];
const reviewMode = new URLSearchParams(location.search).get("review") === "1";
const requestedVersion = new URLSearchParams(location.search).get("version");
let reviewDraft = null;
let reviewIdentity = null;
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
function assertReviewIdentity() {
  const state = window.ReadMembers?.state;
  if (!reviewIdentity || state?.expired || state?.user?.role !== "admin" || state.epoch !== reviewIdentity.epoch || state.user.id !== reviewIdentity.uid) throw new Error("登录状态已变化，请使用管理员账号重新打开稿件");
}

function clearPrivateReview() {
  if (!reviewMode) return;
  restoringReadingState = true;
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

function adaptReviewDraft(draft, expectedId) {
  const content = typeof draft.body === "string" ? JSON.parse(draft.body) : draft.body;
  if ((requestedVersion && draft.version_hash !== requestedVersion) || draft.id !== expectedId || content?.article?.id !== expectedId || !Array.isArray(content.blocks) || !draft.version_hash) throw new Error("稿件信息不完整，请重新打开");
  const assets = new Set((draft.assets || []).map(asset => asset.id));
  for (const block of content.blocks) {
    if (block.kind === "figure" && !assets.has(content.asset_map?.[block.src])) throw new Error("稿件图片尚未就绪");
  }
  return {...content, sourceReady:true, version_hash:draft.version_hash};
}

function configureReviewNavigation() {
  for (const selector of ["#nav-catalog", "#footer-catalog", ".topbar .brand", ".reading-preparation-actions a"]) {
    const link = $(selector);
    link.href = "/member-system/admin.html";
    link.setAttribute("aria-label", "返回稿件审核");
    if (selector !== ".topbar .brand") link.textContent = "返回稿件审核";
  }
  for (const selector of ["#nav-prev", "#nav-next"]) { $(selector).disabled = true; $(selector).hidden = true; }
  document.body.dataset.reviewMode = "true";
}
function articleId() { return documentState?.article?.id || requestedArticleId; }
function articleSuffix() { return articleId() ? `?article=${encodeURIComponent(articleId())}` : ""; }
function articleAsset(path) {
  if(reviewMode){const assetId=documentState?.asset_map?.[path];if(!assetId||!/^[\w-]+$/.test(assetId))throw Error("稿件图片尚未就绪");return `/api/member/admin/drafts/${encodeURIComponent(articleId())}${requestedVersion?'/versions/'+encodeURIComponent(requestedVersion):''}/assets/${encodeURIComponent(assetId)}`;}
  return `/${path}${articleSuffix()}`;
}
const ui = {
  zh: {edit:"编辑", enlarge:"放大原图 <span class=ui-arrow-external aria-hidden=true></span>", source:"原文 / 第", page:"页", figureNote:"论文原图裁切 · 下方按钮缩放，放大后可双向滚动", audit:"原文核对与阅读边界", preparing:"中文导读正在整理", preparingDetail:"作者核对完成后，刷新此页即可阅读。", save:"保存修改", cancel:"取消", backup:"本机保存并保留上一版本", saving:"正在保存…", saved:"修改已在本机保存", savedToast:"文字已保存，上一版本已备份。", failed:"保存失败，文字仍在编辑框中", selection:"保存划词", selected:"保存", selectionSaved:"已保存，稍后讨论。", remove:"已从划词清单移除。", empty:"划词记录将显示在这里。", pdf:"原始 PDF / 第"},
  en: {edit:"EDIT", enlarge:"ENLARGE SOURCE <span class=ui-arrow-external aria-hidden=true></span>", source:"SOURCE / P. ", page:"", figureNote:"Original PDF crop · Use the controls below to zoom and scroll in both directions", audit:"Source audit & reading limits", preparing:"The English reading guide is being prepared", preparingDetail:"Refresh this page when the reviewed guide is ready.", save:"Save wording", cancel:"Cancel", backup:"Saved to this computer with a version backup", saving:"Saving to this computer…", saved:"Changes saved locally", savedToast:"Wording saved. A previous version was backed up.", failed:"Save failed — your text remains here", selection:"Save selected text", selected:"Save", selectionSaved:"Saved for later discussion.", remove:"Removed from your list.", empty:"Your reading notes will appear here.", pdf:"SOURCE PDF / PAGE "}
};
function tr(key) { return ui[currentLanguage][key]; }
function blockName(kind) {
  const zh = {title:"标题",heading:"小标题",paragraph:"段落",figure:"图注",bullet:"列表",number:"条目",quote:"引文",table:"表格"};
  return currentLanguage === "zh" ? (zh[kind] || "文字") : kind;
}
function figurePage(src) { return documentState?.article?.figurePages?.[src] ?? "?"; }

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}

function inlineMarkdown(text) { return window.ReadInline.html(text); }

function toast(message) {
  const box = $("#toast");
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove("show"), 3100);
}

function indicator(text, state="") {
  const el = $("#saved-indicator");
  el.className = "saved-indicator " + state;
  el.innerHTML = '<span class="saved-dot"></span>' + escapeHtml(text);
}

async function request(url, options={}) {
  const response = await fetch(url, {cache:"no-store", ...options});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function blockElement(block, metadata=false) {
  const wrap = document.createElement("section");
  wrap.className = "block" + (block.editedAt ? " edited" : "");
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
      const label = currentLanguage === "zh" ? `原图 ${number}` : `Source figure ${number}`;
      const fit = currentLanguage === "zh" ? "适应" : "Fit";
      content = `<figure class="source-figure"><div class="inline-figure-viewport"><div class="inline-figure-stage progressive-media" tabindex="0" aria-label="${label}，放大后可双向滚动"><div class="inline-figure-canvas">${figureImageMarkup(block, `${tr("source")}${page}${tr("page")}`)}</div></div><div class="inline-figure-status" role="status">正在载入当前原图…</div></div><div class="inline-figure-toolbar" role="group" aria-label="${label}缩放"><button type="button" class="inline-zoom-out" aria-label="${label}缩小">−</button><button type="button" class="inline-zoom-in" aria-label="${label}放大">＋</button><button type="button" class="inline-zoom-fit" aria-label="${label}适应">${fit}</button></div><figcaption class="figure-caption"><span class="figure-label">${tr("source")}${page}${tr("page")}</span><p>${inlineMarkdown(block.text)}</p></figcaption><div class="figure-source">${tr("figureNote")}</div></figure>`;
      break;
    }
    default: content = `<p>${inlineMarkdown(block.text)}</p>`;
  }
  wrap.innerHTML = content;
  if (READING_TOOLS_ENABLED) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit-trigger";
    edit.textContent = tr("edit");
    edit.setAttribute("aria-label", `${tr("edit")} ${blockName(block.kind)}`);
    edit.addEventListener("click", () => openEditor(block, wrap));
    wrap.prepend(edit);
  }
  if (block.kind === "figure") {
    installDragPan(wrap.querySelector(".inline-figure-stage"));
    const image = wrap.querySelector(".inline-figure-canvas img");
    image.addEventListener("load", async () => {
      try {await decodeFigureImage(image);} catch {image.dispatchEvent(new Event("error")); return;}
      window.ReadMedia?.reveal(image);
      applyInlineFigureScale(wrap, false);
      const position = pendingInlinePositions?.[wrap.dataset.blockId];
      if (position) requestAnimationFrame(() => {
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
  figureBlocks = documentState.blocks.filter(block => block.kind === "figure");
  document.body.classList.toggle("source-pending", !documentState.sourceReady);
  if (!documentState.sourceReady) {
    article.innerHTML = `<h1 class="article-title">${tr("preparing")}</h1><p class="article-meta">${tr("preparingDetail")}</p>`;
    return;
  }
  const blocks = documentState.blocks;
  const body = document.createElement("div");
  body.className = "article-body";
  const meta = document.createElement("div");
  meta.className = "article-meta";
  let sectionStarted = false;
  let metadataBlocks = 0;
  let audit = null;
  for (const block of blocks) {
    const node = blockElement(block);
    if (block.kind === "heading" && (/^Source audit/i.test(block.text) || /^原文核对/.test(block.text) || /^来源核查/.test(block.text))) {
      audit = document.createElement("details");
      audit.className = "source-audit";
      audit.innerHTML = `<summary>${tr("audit")}</summary>`;
      body.append(audit);
      continue;
    }
    if (audit) { audit.append(node); continue; }
    if (block.kind === "title") article.append(node);
    else if (!sectionStarted && block.kind === "heading" && metadataBlocks === 0 && !/^\d+\./.test(block.text)) {
      node.classList.add("article-deck");
      article.append(node);
    }
    else if (!sectionStarted && block.kind !== "heading" && (currentLanguage !== "zh" || metadataBlocks < 2)) {
      meta.append(node);
      metadataBlocks += 1;
    }
    else {
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

function handlePanelVisibleLoad() {
  applyFigureScale(false);
  if (pendingPanelViewport) requestAnimationFrame(() => {
    restoreScrollFraction($("#figure-stage"),"x",pendingPanelViewport.x);
    restoreScrollFraction($("#figure-stage"),"y",pendingPanelViewport.y);
    pendingPanelViewport = null;
  });
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

function requestPanelFigure(block, retry=false) {
  const requestId = ++panelFigureRequest;
  const base = articleAsset(block.src);
  const url = retry ? `${base}${base.includes("?") ? "&" : "?"}imageRetry=${++imageRetryNumber}` : base;
  const warm = backgroundFigureImages.find(item => item.getAttribute("src") === url && (!item.isConnected || item.id === "panel-figure-image"));
  const cachedReady = Boolean(warm?.complete && warm.naturalWidth && warm.dataset.decoded === "true");
  if (!cachedReady) setPanelFigureState("loading");
  panelFigureReady = new Promise(resolve => {
    const candidate = warm || new Image();
    const media = figureMedia(block);
    candidate.decoding = "async"; candidate.fetchPriority = "high";
    if (media.width && media.height) {candidate.width = media.width; candidate.height = media.height;}
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      candidate.removeEventListener("load", loaded); candidate.removeEventListener("error", failed);
      if (requestId !== panelFigureRequest) {resolve("stale"); return;}
      if (result !== "ready") {setPanelFigureState("failed"); resolve(result); return;}
      candidate.id = "panel-figure-image";
      const visible = $("#panel-figure-image");
      if (visible !== candidate) visible.replaceWith(candidate);
      candidate.dataset.figureSource = block.src;
      if (!backgroundFigureImages.includes(candidate)) backgroundFigureImages.push(candidate);
      $("#figure-canvas .panel-media-preview")?.remove();
      commitPanelFigure(block); handlePanelVisibleLoad(); setPanelFigureState("ready");
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
  currentFigureIndex = nextIndex;
  const block = figureBlocks[currentFigureIndex];
  updatePanelFigurePosition();
  if (isDesktopLayout()) requestPanelFigure(block).then(result => {if (result === "ready" && readingPrepared) preloadOtherFigures();});
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
  const index = figureBlocks.findIndex(block => block.scrollTrigger === "article-end");
  return index === figureBlocks.length - 1 ? index : -1;
}

function readingVisibleHeight() {
  const toolbar = document.querySelector?.(".reader-toolbar") || document.querySelector?.(".topbar");
  const headerBottom = toolbar?.getBoundingClientRect?.().bottom || 0;
  return Math.max(1, window.innerHeight - Math.max(0, headerBottom));
}

function selectAutoFigure(tops, current, endIndex, downLine, visibleHeight, bottomGap, atEnd, force=false) {
  if (endIndex >= 0 && atEnd) return endIndex;
  let next = 0;
  tops.forEach((top, index) => {if (index !== endIndex && top <= downLine) next = index;});
  if (force || current < 0 || current >= tops.length) return next;
  if (endIndex >= 0 && current === endIndex) return bottomGap < visibleHeight * .25 ? endIndex : next;
  if (next >= current) return next;
  const upLine = downLine + visibleHeight * .18;
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
    if (Number.isInteger(index) && index !== currentFigureIndex) {currentFigureIndex = index; updatePanelFigurePosition(); preloadOtherFigures();}
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
  const anchors = [...document.querySelectorAll(".block[data-figure-index]")];
  const tops = anchors.map(anchor => anchor.getBoundingClientRect().top + window.scrollY - targetY);
  const downLine = window.innerHeight * (documentState.article?.scrollThreshold ?? .52);
  const index = selectAutoFigure(tops, currentFigureIndex, articleEndFigureIndex(), downLine,
    readingVisibleHeight(), Math.max(0, contentHeight - window.innerHeight - targetY),
    isReadingAtEnd(targetY, window.innerHeight, contentHeight), force === true || (!readingPrepared && !readingPreparationSaved) || jump != null);
  showFigure(index);
}

function observeFigures() {
  figureObserver?.disconnect();
  if (!figureBlocks.length) return;
  figureObserver = new IntersectionObserver(() => syncFigureToScroll(), {rootMargin:"-20% 0px -40% 0px"});
  document.querySelectorAll(".block[data-figure-index]").forEach(node => figureObserver.observe(node));
  requestAnimationFrame(syncFigureToScroll);
}

function setToolsOpen(open) {
  if (!READING_TOOLS_ENABLED) return;
  if (!open && activeEditor) return;
  document.body.classList.toggle("tools-open", open);
  $("#tools-toggle").setAttribute("aria-expanded", String(open));
  $("#reading-tools").setAttribute("aria-hidden", String(!open));
  $("#reading-tools").inert = !open;
  if (open) $("#tools-close").focus();
  else $("#tools-toggle").focus();
}

function openEditor(block, wrap) {
  if (!READING_TOOLS_ENABLED) return;
  if (activeEditor) activeEditor.remove();
  const editor = document.createElement("div");
  editor.className = "inline-editor";
  editor.innerHTML = `<textarea aria-label="${tr("edit")} ${blockName(block.kind)}"></textarea><div class="editor-actions"><button type="button" class="button primary save-edit" style="width:auto">${tr("save")}</button><button type="button" class="button subtle cancel-edit">${tr("cancel")}</button><span class="editor-note">${tr("backup")}</span></div>`;
  const textarea = editor.querySelector("textarea");
  textarea.value = block.text;
  editor.querySelector(".cancel-edit").addEventListener("click", () => { editor.remove(); activeEditor = null; });
  editor.querySelector(".save-edit").addEventListener("click", async () => {
    const button = editor.querySelector(".save-edit");
    button.disabled = true;
    indicator(tr("saving"), "saving");
    try {
      const result = await request("/api/block", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({article:articleId(),language:currentLanguage,id:block.id,text:textarea.value,revision:documentState.revision})});
      documentState.revision = result.revision;
      Object.assign(block, result.block);
      activeEditor = null;
      renderArticle();
      indicator(tr("saved"));
      toast(tr("savedToast"));
    } catch (error) {
      indicator(tr("failed"), "error");
      toast(error.message);
      button.disabled = false;
    }
  });
  wrap.append(editor);
  activeEditor = editor;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length,textarea.value.length);
  editor.scrollIntoView({block:"nearest",behavior:"smooth"});
}

function captureSelection() {
  if (!READING_TOOLS_ENABLED) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const text = selection.toString().replace(/\s+/g," ").trim();
  if (!text || text.length > 500) return;
  const anchor = selection.anchorNode?.parentElement?.closest(".block");
  const focus = selection.focusNode?.parentElement?.closest(".block");
  if (!anchor || !focus || anchor !== focus || anchor.closest(".inline-editor")) return;
  const blockId = anchor.dataset.blockId;
  const block = documentState?.blocks.find(item => item.id === blockId);
  if (!block || block.kind === "figure") return;
  pendingSelection = {text, context:block.text, blockId};
  $("#save-selection").disabled = false;
  $("#save-selection").innerHTML = `${tr("selected")} “${escapeHtml(text.slice(0,24))}${text.length>24?'…':''}” <span><span class=ui-arrow-external aria-hidden=true></span></span>`;
}

async function saveSelection() {
  if (!pendingSelection) return;
  const button = $("#save-selection");
  button.disabled = true;
  try {
    const result = await request("/api/selection", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...pendingSelection,article:articleId(),language:currentLanguage})});
    documentState.selections.push(result.selection);
    documentState.revision = result.revision;
    renderSelections();
    toast(tr("selectionSaved"));
    pendingSelection = null;
    button.innerHTML = `${tr("selection")} <span><span class=ui-arrow-external aria-hidden=true></span></span>`;
    window.getSelection()?.removeAllRanges();
  } catch(error) {
    toast(error.message);
    button.disabled = false;
  }
}

function renderSelections() {
  const list = $("#selection-list");
  list.replaceChildren();
  $("#selection-count").textContent = String(documentState.selections.length).padStart(2,"0");
  if (!documentState.selections.length) {
    list.innerHTML = `<div class="empty-state">${tr("empty")}</div>`;
    return;
  }
  for (const entry of [...documentState.selections].reverse()) {
    const card = document.createElement("div");
    card.className = "selection-card";
    card.innerHTML = `<div class="selection-title"><strong>${escapeHtml(entry.text)}</strong><button type="button" aria-label="Remove ${escapeHtml(entry.text)}" title="Remove">×</button></div><p>${escapeHtml(entry.context)}</p>`;
    card.querySelector("button").addEventListener("click", async () => {
      try {
        const result = await request("/api/selection/delete", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({article:articleId(),id:entry.id,language:currentLanguage})});
        documentState.revision = result.revision;
        documentState.selections = documentState.selections.filter(item => item.id !== entry.id);
        renderSelections();
        toast(tr("remove"));
      } catch(error) { toast(error.message); }
    });
    list.append(card);
  }
}

function openLightbox(block) {
  const box = $("#lightbox");
  const page = figurePage(block.src);
  $("#lightbox-image").src = articleAsset(block.src);
  $("#lightbox-image").classList.remove("zoomed");
  $("#lightbox-label").textContent = `${tr("pdf")}${page}${tr("page")}`;
  $("#lightbox-pdf").href = `/source.pdf${articleSuffix()}#page=${page}`;
  box.hidden = false;
  document.body.style.overflow = "hidden";
  $("#close-lightbox").focus();
}
function closeLightbox() {
  $("#lightbox").hidden = true;
  document.body.style.overflow = "";
}

function updateLanguageChrome() {
  const zh = currentLanguage === "zh";
  document.documentElement.lang = zh ? "zh-CN" : "en";
  const number = documentState?.article?.displayNumber || "01";
  document.title = zh ? `文献导读 · 第 ${number} 篇` : `Reading Desk · Paper ${number}`;
  $("#language-zh").setAttribute("aria-pressed", String(zh));
  $("#language-en").setAttribute("aria-pressed", String(!zh));
  $("#export-selections").href = `/api/export-selections?lang=${currentLanguage}&article=${encodeURIComponent(articleId())}`;
  const sourceUrl = documentState?.article?.sourceUrl;
  const sourceHref = sourceUrl || `/source.pdf${articleSuffix()}`;
  $(".top-link").href = sourceHref;
  const labels = [
    [".brand>span:last-child", "文献导读", "READING DESK"],
    [".private-badge", "● 仅本机可见", "● Private · this computer"],
    [".top-link", sourceUrl ? "原文链接 <span class=ui-arrow-external aria-hidden=true></span>" : "原始 PDF <span class=ui-arrow-external aria-hidden=true></span>", sourceUrl ? "Source article <span class=ui-arrow-external aria-hidden=true></span>" : "Original PDF <span class=ui-arrow-external aria-hidden=true></span>"],
    [".left-rail h2", "阅读路线", "Reading route"],
    [".rail-foot p", "依据原文页码整理的导读。", "A guided reading, anchored to the source pages."],
    [".eyebrow", documentState?.article?.kind === "review" ? "综述 / 导读" : "研究论文 / 导读", documentState?.article?.kind === "review" ? "REVIEW / GUIDED READING" : "RESEARCH ARTICLE / GUIDED READING"],
    [".tool-header span:last-child", "我的工作区", "YOUR WORKSPACE"],
    [".right-rail > .tool-card:not(.edit-card) .tool-step", "01 / 划词", "01 / MARK"],
    [".right-rail > .tool-card:not(.edit-card) h3", "待讨论的词句", "Words to discuss"],
    [".right-rail > .tool-card:not(.edit-card) p", "划选导读中的词或短语，保存后再讨论注释。", "Select an unfamiliar word or phrase in the article, then save it here with its sentence."],
    [".shortcut", "快捷键：Ctrl + Enter", "Keyboard: Ctrl + Enter"],
    [".list-head span:first-child", "已保存", "Saved for later"],
    ["#export-selections", "导出划词 <span class=ui-arrow-down aria-hidden=true></span>", "Export word list <span class=ui-arrow-down aria-hidden=true></span>"],
    [".edit-card .tool-step", "02 / 修改", "02 / REFINE"],
    [".edit-card h3", "修改导读文字", "Make it your own"],
    [".edit-card p", "点击标题、段落或图注旁的编辑，修改会保存到本机。", "Use Edit beside any title, paragraph, or caption. Save each change to this computer."],
    ["#lightbox-pdf", "打开原始 PDF <span class=ui-arrow-external aria-hidden=true></span>", "Open original PDF <span class=ui-arrow-external aria-hidden=true></span>"],
    [".lightbox-help", "点击图片放大 · 拖动查看 · Esc 关闭", "Click or tap the page to zoom · Drag to inspect · Esc to close"]
  ];
  for (const [selector, chinese, english] of labels) {
    const element = $(selector);
    if (element) element.innerHTML = zh ? chinese : english;
  }
  $("#save-selection").innerHTML = `${tr("selection")} <span><span class=ui-arrow-external aria-hidden=true></span></span>`;
  $("#tools-toggle").textContent = zh ? "阅读工具" : "Reading tools";
  $("#tools-close").setAttribute("aria-label", zh ? "关闭阅读工具" : "Close reading tools");
  $("#figure-prev").setAttribute("aria-label", zh ? "上一张原图" : "Previous source figure");
  $("#figure-next").setAttribute("aria-label", zh ? "下一张原图" : "Next source figure");
  $("#figure-edge-prev").setAttribute("aria-label", zh ? "上一张原图" : "Previous source figure");
  $("#figure-edge-next").setAttribute("aria-label", zh ? "下一张原图" : "Next source figure");
  $("#figure-stage").setAttribute("aria-label", zh ? "原文配图，放大后可横向和纵向滚动" : "Source figure; scroll horizontally and vertically after zooming");
  const divider = $("#pane-divider");
  divider.setAttribute("aria-label", zh ? "调整原图与正文宽度" : "Resize figure and article panes");
  divider.title = zh ? "拖动调整宽度；双击恢复45%/55%；方向键微调" : "Drag to resize; double-click to reset 45%/55%; use arrow keys to adjust";
  applyPaneRatio();
  $("#figure-stage").removeAttribute("title");
  $(".figure-scale-controls").removeAttribute("title");
  $("#figure-zoom-out").setAttribute("aria-label", zh ? "缩小图片" : "Zoom out of figure");
  $("#figure-detail-zoom").setAttribute("aria-label", zh ? "放大图片" : "Zoom in on figure");
  $("#figure-fit").textContent = zh ? "适应" : "Fit";
  $(".figure-scale-controls").setAttribute("aria-label", zh ? "图片缩放" : "Figure zoom");
  updatePanelFigurePosition();
  $("#figure-list").setAttribute("aria-label", zh ? "选择原文配图" : "Choose source figure");
  setFigureAuto(figureAuto);
  setFigureFillPane(figureFillPane);
  setFigureScale(figureScale);
  indicator(tr("saved"));
}

async function loadLanguage(lang) {
  if (activeEditor) {
    toast(currentLanguage === "zh" ? "请先保存或取消当前修改。" : "Save or cancel the current edit first.");
    return;
  }
  if (lang === currentLanguage && documentState) return;
  const incoming = await request(`/api/document?lang=${lang}${requestedArticleId ? `&article=${encodeURIComponent(requestedArticleId)}` : ""}`);
  currentLanguage = lang;
  documentState = incoming;
  pendingSelection = null;
  $("#save-selection").disabled = true;
  updateLanguageChrome();
  renderArticle();
  applyPaneRatio();
  if (READING_TOOLS_ENABLED) renderSelections();
}

function isDesktopLayout() {
  return !window.ReadOutlineOpen && layoutPreference !== "single" && window.innerWidth >= 901;
}

function applyLayoutPreference() {
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

function readingKey() {
  return `${window.ReadMembers?.state.user?.id || "guest"}:reading-desk:v1:${reviewMode ? "review:" + documentState.version_hash + ":" : ""}${articleId()}:${readingMode()}`;
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
  for (const block of blocks) {
    if (block.getBoundingClientRect().top > 120) break;
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
  return {version:1, article:articleId(), mode:readingMode(),
    scroll:readingAnchor(), paneRatio,
    figure:{index:currentFigureIndex, auto:figureAuto, fill:figureFillPane,
      scale:figureScale, x:scrollFraction(stage,"x"), y:scrollFraction(stage,"y")},
    inline};
}

function saveReadingState() {
  clearTimeout(readingSaveTimer);
  readingSaveTimer = null;
  if (window.ReadProgressPending || restoringReadingState || !documentState?.article) return;
  const captured = captureReadingState();
  if (!reviewMode && window.ReadMembers) window.ReadMembers.saveProgress(articleId(),documentState.version_hash,captured);
  try { localStorage.setItem(readingKey(), JSON.stringify(captured)); }
  catch(error) { /* Reading remains usable if local storage is unavailable. */ }
}

function scheduleReadingSave() {
  if (restoringReadingState || !documentState?.article) return;
  clearTimeout(readingSaveTimer);
  readingSaveTimer = setTimeout(saveReadingState, 180);
}

function storedReadingState() {
  try {
    const state = JSON.parse(localStorage.getItem(readingKey()));
    return state?.version === 1 && state.article === articleId() && state.mode === readingMode() ? state : null;
  } catch(error) { return null; }
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
  const threshold = innerHeight * (documentState.article?.scrollThreshold ?? .52);
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
  if(isDesktopLayout()&&$("#figure-stage").dataset.imageState!=="ready")return;
  if (figurePreloadActive) {figurePreloadQueued=true;return;}
  const snapshot=documentState,startIndex=currentFigureIndex;
  const order=figureBlocks.slice(startIndex+1,startIndex+3);
  figurePreloadActive=true;
  (async()=>{
    for (const block of order) {
      if(documentState!==snapshot || currentFigureIndex!==startIndex)break;
      if(reviewMode){try{assertReviewIdentity();}catch{break;}}
      if(backgroundFigureImages.some(image=>image.dataset.figureSource===block.src))continue;
      const image=new Image();image.dataset.figureSource=block.src;
      image.decoding='async';image.fetchPriority='low';backgroundFigureImages.push(image);
      await new Promise(resolve=>{const timer=setTimeout(resolve,12000);image.onload=async()=>{try{await decodeFigureImage(image);}catch{}clearTimeout(timer);resolve();};image.onerror=()=>{clearTimeout(timer);resolve();};image.src=articleAsset(block.src);});
    }
  })().finally(()=>{figurePreloadActive=false;if(figurePreloadQueued){figurePreloadQueued=false;preloadOtherFigures();}});
}

function showPreparationFailure(message) {
  readingPrepared = false;
  document.body.classList.add("reader-preparing");
  $(".layout").inert = true; $("#reading-preparation").hidden = false;
  $("#reading-preparation-message").textContent = message;
  $("#reading-preparation-retry").hidden = false;
  $("#reading-preparation-continue").hidden = !documentState?.article;
}

function revealReadingContent(attempt) {
  if (attempt !== preparationAttempt) return;
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
    showPreparationFailure("当前原图暂未就绪，请重试或先读正文。");
    return;
  }
  revealReadingContent(attempt);
  preloadOtherFigures();
}

async function resumeRemoteProgress(readerTouched) {
  if (reviewMode || !window.ReadMembers) return;
  await window.ReadMembers.ready;
  const owner = {uid:window.ReadMembers.state.user?.id, epoch:window.ReadMembers.state.epoch};
  const sameOwner = () => !window.ReadMembers.state.expired && window.ReadMembers.state.epoch === owner.epoch && window.ReadMembers.state.user?.id === owner.uid;
  const local = storedReadingState();
  const remote = await window.ReadMembers.loadProgress(articleId(),documentState.version_hash,local,readingMode());
  if (!remote || remote === local || readingPreparationSaved || readerTouched() || readingRestoreInterrupted || !sameOwner()) return;
  const positionKey = value => JSON.stringify([value?.scroll?.blockId || null,Number(value?.scroll?.offset) || 0,Number(value?.scroll?.fraction) || 0,value?.scroll?.atBottom === true,Number(value?.figure?.index) || 0,Number(value?.figure?.scale) || 1]);
  if (positionKey(remote) === positionKey(captureReadingState())) return;
  // The remote revision is now known; a resume invitation must not block new progress saves.
  window.ReadProgressPending = false;
  // Late account I/O must not move text or pictures already revealed to the reader.
  if (readingPrepared) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "reader-resume-progress";
    button.textContent = "继续上次阅读";
    ($(".reader-toolbar") || $(".topbar")).append(button);
    const accepted = await new Promise(resolve => {
      const cleanup = value => {button.remove();document.removeEventListener("read-members-expired", expired);document.removeEventListener("read-members-change", changed);resolve(value);};
      const expired = () => cleanup(false);
      const changed = () => {if (!sameOwner()) cleanup(false);};
      document.addEventListener("read-members-expired", expired);
      document.addEventListener("read-members-change", changed);
      button.addEventListener("click", () => cleanup(true), {once:true});
    });
    if (!accepted || !sameOwner()) return;
    readingPrepared = false;
    document.body.classList.add("reader-preparing");
    $(".layout").inert = true; $("#reading-preparation").hidden = false;
  }
  restoringReadingState = true;
  readingBottomIntent = remote.scroll?.atBottom === true;
  readingPreparationSaved = remote;
  paneRatio = Number.isFinite(remote.paneRatio) ? remote.paneRatio : DEFAULT_PANE_RATIO;
  pendingPanelViewport = remote.figure || null;
  pendingInlinePositions = {...(remote.inline || {})};
  figureAuto = remote.figure?.auto !== false;
  figureFillPane = remote.figure?.fill === true;
  figureScale = Math.min(5,Math.max(1,Number(remote.figure?.scale)||1));
  for (const [id,position] of Object.entries(remote.inline||{})) inlineFigureScales.set(id,Math.min(5,Math.max(1,Number(position.scale)||1)));
  showFigure(Number.isInteger(remote.figure?.index)?remote.figure.index:0);
  setFigureAuto(figureAuto);setFigureFillPane(figureFillPane);
  await restoreReadingState(remote);
  await finishReadingPreparation();
}

function mountReadingTools(metadata, readerTouched) {
  const placeholder=document.createElement("span");
  placeholder.className="reader-tools-pending";placeholder.textContent="正在连接阅读工具…";
  $("#member-reader-tools").append(placeholder);
  (async()=>{
    if (!window.ReadMembers && document.readyState !== "complete") await new Promise(resolve=>document.addEventListener("DOMContentLoaded",resolve,{once:true}));
    if (!window.ReadMembers) {placeholder.remove();return;}
    await window.ReadMembers.ready;
    placeholder.remove();
    const mount=reviewMode?window.ReadMembers.mountReviewReader:window.ReadMembers.mountReader;
    mount({draft:reviewDraft,articleId:articleId(),revision:documentState.version_hash,snapshot:documentState,assetUrl:articleAsset,metadata,root:$("#article"),toolbar:$("#member-reader-tools"),figureRoot:$(".left-rail")});
    await resumeRemoteProgress(readerTouched);
  })().catch(error=>{placeholder.textContent="阅读工具暂未连接";console.warn("Reading tools unavailable",error);}).finally(()=>{window.ReadProgressPending=false;});
}

async function configureReadingNavigation() {
  const {articles} = await request("/api/catalog");
  catalogArticles = articles;
  window.ReadMembers?.setPublicCatalog?.(articles);
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
  location.href = `/read?article=${encodeURIComponent(button.dataset.articleId)}`;
}

async function start() {
  history.scrollRestoration = "manual";
  window.ReadProgressPending = !reviewMode;
  let readerTouched = false;
  for (const type of ["wheel","touchstart","pointerdown","keydown"]) window.addEventListener(type,()=>{readerTouched=true;},{once:true,passive:true});
  loadLayoutPreference();
  $("#reading-preparation-continue").addEventListener("click", () => finishReadingPreparation(false, true));
  $("#panel-figure-retry").addEventListener("click", retryPanelFigure);
  $("#reading-preparation-retry").addEventListener("click", () => {
    if (!documentState?.article) location.reload();
    else finishReadingPreparation(true);
  });
  try {
    restoringReadingState = true;
    if(reviewMode){
      if(!window.ReadMembers)throw Error("账号组件暂时无法载入，请刷新重试");
      await (window.ReadMembers.authReady||window.ReadMembers.ready);reviewIdentity={epoch:window.ReadMembers.state.epoch,uid:window.ReadMembers.state.user?.id};assertReviewIdentity();
      reviewDraft=await request(`/api/member/admin/drafts/${encodeURIComponent(requestedArticleId)}${requestedVersion?'?version='+encodeURIComponent(requestedVersion):''}`,{credentials:'same-origin',cache:'no-store'});assertReviewIdentity();documentState=adaptReviewDraft(reviewDraft,requestedArticleId);configureReviewNavigation();document.addEventListener('read-members-expired',clearPrivateReview);
    }else documentState = await request(`/api/document?lang=zh${requestedArticleId ? `&article=${encodeURIComponent(requestedArticleId)}` : ""}`, {signal:AbortSignal.timeout(15000)});
    const saved = storedReadingState();
    readingPreparationSaved = saved;
    pendingPanelViewport = saved?.figure || null;
    pendingInlinePositions = {...(saved?.inline || {})};
    if (saved) {
      readingBottomIntent = saved.scroll?.atBottom === true;
      paneRatio = Number.isFinite(saved.paneRatio) ? saved.paneRatio : DEFAULT_PANE_RATIO;
      currentFigureIndex = Number.isInteger(saved.figure?.index) ? saved.figure.index : 0;
      figureAuto = saved.figure?.auto !== false;
      figureFillPane = saved.figure?.fill === true;
      figureScale = Math.min(5, Math.max(1, Number(saved.figure?.scale) || 1));
      for (const [id, position] of Object.entries(saved.inline || {})) {
        inlineFigureScales.set(id, Math.min(5, Math.max(1, Number(position.scale) || 1)));
      }
    }
    primeCurrentFigure();
    updateLanguageChrome();
    renderArticle();
    applyPaneRatio();
    if (READING_TOOLS_ENABLED) renderSelections();
    restoreStartScrollY = window.scrollY;
    window.addEventListener("scroll", handleReadingScroll, {passive:true});
    await restoreReadingState(saved);
    syncFigureToScroll();
    await finishReadingPreparation();
    if(!reviewMode)configureReadingNavigation().catch(() => {});
    mountReadingTools(catalogArticles.find(item=>item.id===articleId()),()=>readerTouched);
  } catch(error) {
    restoringReadingState = false;
    $("#article").innerHTML = '<h1 class="article-title">Unable to load this reading desk</h1><p>Please check that the local server is running.</p>';
    indicator("Connection unavailable", "error");
    showPreparationFailure("阅读内容暂时无法载入，请重试。");
  }
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
  document.addEventListener("keydown",event => { if(event.key === "Escape") closeLightbox(); });
  if (READING_TOOLS_ENABLED) {
    document.addEventListener("mouseup",captureSelection);
    document.addEventListener("keyup",event => { if(event.key === "Shift" || event.key.startsWith("Arrow")) captureSelection(); });
    document.addEventListener("keydown",event => { if(event.ctrlKey && event.key === "Enter" && pendingSelection) {event.preventDefault();saveSelection();} });
    $("#save-selection").addEventListener("mousedown",event => event.preventDefault());
    $("#save-selection").addEventListener("click",saveSelection);
    $("#tools-toggle").addEventListener("click", () => setToolsOpen(!document.body.classList.contains("tools-open")));
    $("#tools-close").addEventListener("click", () => setToolsOpen(false));
  }
  $("#close-lightbox").addEventListener("click",closeLightbox);
  $("#lightbox-image").addEventListener("click",event => event.currentTarget.classList.toggle("zoomed"));
  $("#lightbox").addEventListener("click",event => {if(event.target.id === "lightbox") closeLightbox();});
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
  divider.addEventListener("dblclick", event => { event.preventDefault(); applyPaneRatio(DEFAULT_PANE_RATIO); });
  divider.addEventListener("keydown", handlePaneKey);
  window.addEventListener("resize", () => {
    if (readingMode() !== (isDesktopLayout() ? "desktop" : "single")) {
      reflowReaderLayout();
      return;
    }
    applyPaneRatio(); applyFigureScale(); applyAllInlineFigureScales();
    if(readingBottomIntent) window.scrollTo({top:document.documentElement.scrollHeight,behavior:"instant"});
    resetAutoFigureTracking();
  });
}
start();
