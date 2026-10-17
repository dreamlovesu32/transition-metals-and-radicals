"use strict";

let documentState = null;
const currentLanguage = "zh";
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
let panePointerId = null;
let paneFitQueued = false;
let restoringReadingState = false;
let readingSaveTimer = null;
let readingBottomIntent = false;
const $ = selector => document.querySelector(selector);
const requestedArticleId = new URLSearchParams(location.search).get("article");
const ui = {zh:{source:"原文 / 第",page:"页",figureNote:"论文原图裁切 · 下方按钮缩放，放大后可双向滚动"}};
function tr(key) { return ui.zh[key]; }
function articleId() { return documentState?.article?.id || requestedArticleId; }
function articleAsset(path) { return `./figures/${encodeURIComponent(articleId())}/${encodeURIComponent(path.split("/").pop())}`; }
function figurePage(src) { return documentState?.article?.figurePages?.[src] ?? "?"; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1 <span class=ui-arrow-external aria-hidden=true></span></a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html.replace(/\n/g, '<br>');
}

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
      content = `<figure class="source-figure"><div class="inline-figure-stage" tabindex="0" aria-label="${label}，放大后可双向滚动"><div class="inline-figure-canvas"><img src="${articleAsset(block.src)}" alt="${tr("source")}${page}${tr("page")}" loading="lazy"></div></div><div class="inline-figure-toolbar" role="group" aria-label="${label}缩放"><button type="button" class="inline-zoom-out" aria-label="${label}缩小">−</button><button type="button" class="inline-zoom-in" aria-label="${label}放大">＋</button><button type="button" class="inline-zoom-fit" aria-label="${label}适应">适应</button></div><figcaption class="figure-caption"><span class="figure-label">${tr("source")}${page}${tr("page")}</span><p>${inlineMarkdown(block.text)}</p></figcaption><div class="figure-source">${tr("figureNote")}</div></figure>`;
      break;
    }
    default: content = `<p>${inlineMarkdown(block.text)}</p>`;
  }
  wrap.innerHTML = content;
  if (block.kind === "figure") {
    const image = wrap.querySelector(".inline-figure-canvas img");
    image.addEventListener("load", () => applyInlineFigureScale(wrap, false));
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
    if (block.kind === "heading" && (block.level || 2) <= 2 && /^\d+\./.test(block.text)) {
      const link = document.createElement("a");
      link.className = "toc-link";
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

function updateReadingChrome() {
  document.documentElement.lang = "zh-CN";
  document.title = `${documentState.article.title.zh} · 文献导读`;
  $(".top-link").href = documentState.article.sourceUrl;
  $(".figure-panel-head .rail-kicker").textContent = `原文配图 / ${documentState.article.displayNumber}`;
  const zoomHint = "Ctrl＋滚轮缩放图片";
  $("#figure-stage").title = zoomHint;
  $(".figure-scale-controls").title = zoomHint;
  setFigureAuto(figureAuto);
  setFigureFillPane(figureFillPane);
  setFigureScale(figureScale);
}

function inlineFigureScale(wrap) {
  return inlineFigureScales.get(wrap.dataset.blockId) || 1;
}

function applyInlineFigureScale(wrap, preserveCenter=true) {
  const stage = wrap.querySelector(".inline-figure-stage");
  const canvas = wrap.querySelector(".inline-figure-canvas");
  const image = canvas.querySelector("img");
  if (!image.naturalWidth || !stage.clientWidth || !stage.clientHeight) return;
  const scale = inlineFigureScale(wrap);
  const centerX = preserveCenter && stage.scrollWidth > stage.clientWidth ?
    (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : .5;
  const centerY = preserveCenter && stage.scrollHeight > stage.clientHeight ?
    (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : .5;
  const style = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight) * .98;
  canvas.style.width = `${Math.max(1, Math.floor(image.naturalWidth * fit * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(image.naturalHeight * fit * scale))}px`;
  stage.style.overflow = scale <= 1 ? "hidden" : "auto";
  requestAnimationFrame(() => {
    stage.scrollLeft = centerX * stage.scrollWidth - stage.clientWidth / 2;
    stage.scrollTop = centerY * stage.scrollHeight - stage.clientHeight / 2;
  });
}

function setInlineFigureScale(wrap, value) {
  const scale = Math.min(5, Math.max(1, value));
  inlineFigureScales.set(wrap.dataset.blockId, scale);
  wrap.querySelector(".inline-zoom-out").disabled = scale <= 1;
  wrap.querySelector(".inline-zoom-in").disabled = scale >= 5;
  wrap.querySelector(".inline-zoom-fit").disabled = scale <= 1;
  applyInlineFigureScale(wrap);
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

function showFigure(index, force=false) {
  if (!figureBlocks.length) return;
  const nextIndex = Math.max(0, Math.min(index, figureBlocks.length - 1));
  if (!force && nextIndex === currentFigureIndex) return;
  const imageChanged = nextIndex !== currentFigureIndex;
  currentFigureIndex = nextIndex;
  const block = figureBlocks[currentFigureIndex];
  const page = figurePage(block.src);
  const image = $("#panel-figure-image");
  image.src = articleAsset(block.src);
  if (imageChanged || force) requestAnimationFrame(() => applyFigureScale(false));
  image.alt = `${tr("source")}${page}${tr("page")}`;
  $("#figure-position").textContent = `${String(currentFigureIndex + 1).padStart(2,"0")} / ${String(figureBlocks.length).padStart(2,"0")}`;
  $("#panel-figure-page").textContent = `${tr("source")}${page}${tr("page")}`;
  $("#panel-figure-caption").innerHTML = inlineMarkdown(block.text);
  $("#panel-figure-note").textContent = currentLanguage === "zh" ? "原论文裁图 · 左栏内查看" : "Original paper crop · inspect in the left pane";
  $("#figure-prev").disabled = currentFigureIndex === 0;
  $("#figure-next").disabled = currentFigureIndex === figureBlocks.length - 1;
  $("#figure-edge-prev").disabled = currentFigureIndex === 0;
  $("#figure-edge-next").disabled = currentFigureIndex === figureBlocks.length - 1;
  $("#figure-list").querySelectorAll("button").forEach((button, i) => button.setAttribute("aria-pressed", String(i === currentFigureIndex)));
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

function applyFigureScale(preserveCenter=true, anchor=null) {
  const stage = $("#figure-stage");
  const image = $("#panel-figure-image");
  const canvas = $("#figure-canvas");
  if (!image.naturalWidth || !stage.clientWidth || !stage.clientHeight) return;
  stage.style.overflow = figureScale <= 1 ? "hidden" : "auto";
  const centerX = preserveCenter && stage.scrollWidth > stage.clientWidth ?
    (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : .5;
  const centerY = preserveCenter && stage.scrollHeight > stage.clientHeight ?
    (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : .5;
  const oldCanvas = canvas.getBoundingClientRect();
  const point = anchor && oldCanvas.width && oldCanvas.height ? {
    x: anchor.x,
    y: anchor.y,
    fractionX: Math.min(1, Math.max(0, (anchor.x - oldCanvas.left) / oldCanvas.width)),
    fractionY: Math.min(1, Math.max(0, (anchor.y - oldCanvas.top) / oldCanvas.height))
  } : null;
  const style = getComputedStyle(stage);
  const availableWidth = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const availableHeight = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const fit = Math.min(availableWidth / image.naturalWidth, availableHeight / image.naturalHeight) * .98;
  canvas.style.width = `${Math.max(1, Math.floor(image.naturalWidth * fit * figureScale))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(image.naturalHeight * fit * figureScale))}px`;
  requestAnimationFrame(() => {
    if (point) {
      const resized = canvas.getBoundingClientRect();
      stage.scrollLeft += resized.left + point.fractionX * resized.width - point.x;
      stage.scrollTop += resized.top + point.fractionY * resized.height - point.y;
    } else {
      stage.scrollLeft = centerX * stage.scrollWidth - stage.clientWidth / 2;
      stage.scrollTop = centerY * stage.scrollHeight - stage.clientHeight / 2;
    }
  });
}

function setFigureScale(value, anchor=null) {
  figureScale = Math.min(5, Math.max(1, value));
  $("#figure-zoom-out").disabled = figureScale <= 1;
  $("#figure-detail-zoom").disabled = figureScale >= 5;
  $("#figure-fit").disabled = figureScale <= 1;
  applyFigureScale(true, anchor);
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
  if (!window.matchMedia("(min-width: 901px)").matches || document.body.classList.contains("source-pending")) return;
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
    `原图${leftPercent}%，正文${100 - leftPercent}%` :
    `Figure ${leftPercent}%, article ${100 - leftPercent}%`);
  schedulePaneFigureFit();
  scheduleReadingSave();
}

function paneRatioAt(clientX) {
  const layout = $(".layout");
  const divider = $("#pane-divider");
  const rect = layout.getBoundingClientRect();
  const available = rect.width - divider.offsetWidth;
  return (clientX - rect.left - divider.offsetWidth / 2) / available;
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
  else if (event.key === "ArrowLeft") requested = paneRatio - (event.shiftKey ? .05 : .02);
  else if (event.key === "ArrowRight") requested = paneRatio + (event.shiftKey ? .05 : .02);
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
  if (enabled) syncFigureToScroll();
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

function syncFigureToScroll() {
  if (restoringReadingState || !figureAuto || !figureBlocks.length || !matchMedia("(min-width: 901px)").matches) return;
  const anchors = [...document.querySelectorAll(".block[data-figure-index]")];
  const threshold = window.innerHeight * (documentState.article?.scrollThreshold ?? .52);
  let index = 0;
  anchors.forEach((anchor, i) => { if (anchor.getBoundingClientRect().top <= threshold) index = i; });
  showFigure(index);
}

function observeFigures() {
  figureObserver?.disconnect();
  if (!figureBlocks.length) return;
  figureObserver = new IntersectionObserver(() => syncFigureToScroll(), {rootMargin:"-20% 0px -40% 0px"});
  document.querySelectorAll(".block[data-figure-index]").forEach(node => figureObserver.observe(node));
  requestAnimationFrame(syncFigureToScroll);
}

function readingMode() {
  return matchMedia("(min-width: 901px)").matches ? "desktop" : "single";
}

function readingKey() {
  return `reading-desk:v1:${articleId()}:${readingMode()}`;
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
  if (restoringReadingState || !documentState?.article) return;
  try { localStorage.setItem(readingKey(), JSON.stringify(captureReadingState())); }
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

function restoreArticleScroll(saved) {
  const scroll = saved?.scroll;
  if (!scroll) return;
  const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  const block = [...document.querySelectorAll("#article .block[data-block-id]")]
    .find(node => node.dataset.blockId === scroll.blockId);
  const target = scroll.atBottom ? max : block ?
    block.getBoundingClientRect().top + window.scrollY + (Number(scroll.offset) || 0) :
    max * Math.max(0, Math.min(1, Number(scroll.fraction) || 0));
  window.scrollTo({top:Math.max(0, Math.min(max, target)), behavior:"instant"});
}

async function restoreReadingState(saved) {
  if (!saved) { restoringReadingState = false; return; }
  await document.fonts?.ready;
  await imageSettled($("#panel-figure-image"));
  await animationFrame();
  applyPaneRatio();
  applyFigureScale(false);
  applyAllInlineFigureScales();
  await animationFrame();
  await animationFrame();
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
  try {
    const catalogResponse = await fetch("./catalog.json", {cache:"no-store"});
    if (!catalogResponse.ok) throw new Error("Catalog unavailable");
    const {articles} = await catalogResponse.json();
    if (!articles.some(item => item.id === requestedArticleId)) throw new Error("Article unavailable");
    restoringReadingState = true;
    const response = await fetch(`./data/${encodeURIComponent(requestedArticleId)}.json`, {cache:"no-store"});
    if (!response.ok) throw new Error("Article unavailable");
    documentState = await response.json();
    if (documentState.article.id !== requestedArticleId) throw new Error("Article mismatch");
    const saved = storedReadingState();
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
    updateReadingChrome();
    renderArticle();
    applyPaneRatio();
    await restoreReadingState(saved);
    if (!saved) syncFigureToScroll();
    configureReadingNavigation(articles);
  } catch(error) {
    restoringReadingState = false;
    $("#article").innerHTML = '<h1 class="article-title">阅读内容暂时无法载入</h1><p>请从文献导航重新选择文章。</p>';
  }
  $("#nav-top").addEventListener("click", () => {readingBottomIntent = false; window.scrollTo({top:0,behavior:"smooth"});});
  $("#nav-bottom").addEventListener("click", () => {readingBottomIntent = true; window.scrollTo({top:document.documentElement.scrollHeight,behavior:"smooth"});});
  window.addEventListener("wheel", event => {if(!event.ctrlKey) readingBottomIntent = false;}, {passive:true});
  window.addEventListener("touchmove", () => {readingBottomIntent = false;}, {passive:true});
  window.addEventListener("keydown", event => {if(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(event.key)) readingBottomIntent = false;});
  $("#nav-prev").addEventListener("click", event => navigateToArticle(event.currentTarget));
  $("#nav-next").addEventListener("click", event => navigateToArticle(event.currentTarget));
  $("#nav-catalog").addEventListener("click", saveReadingState);
  $("#footer-catalog").addEventListener("click", saveReadingState);
  $("#footer-top").addEventListener("click", () => {readingBottomIntent = false; window.scrollTo({top:0,behavior:"smooth"});});
  $(".topbar .brand").addEventListener("click", saveReadingState);
  window.addEventListener("pagehide", saveReadingState);
  document.addEventListener("visibilitychange", () => {if(document.visibilityState === "hidden") saveReadingState();});
  $("#article").addEventListener("scroll", scheduleReadingSave, true);
  $("#figure-stage").addEventListener("scroll", scheduleReadingSave, {passive:true});
  $("#article").addEventListener("click", scheduleReadingSave);
  $("#figure-zoom").addEventListener("click", () => setFigureFillPane(!figureFillPane));
  $("#figure-detail-zoom").addEventListener("click", () => setFigureScale(figureScale * 1.25));
  $("#figure-zoom-out").addEventListener("click", () => setFigureScale(figureScale / 1.25));
  $("#figure-fit").addEventListener("click", () => setFigureScale(1));
  $("#panel-figure-image").addEventListener("load", () => applyFigureScale(false));
  $("#figure-prev").addEventListener("click", () => chooseFigure(currentFigureIndex - 1));
  $("#figure-next").addEventListener("click", () => chooseFigure(currentFigureIndex + 1));
  $("#figure-edge-prev").addEventListener("click", () => chooseFigure(currentFigureIndex - 1));
  $("#figure-edge-next").addEventListener("click", () => chooseFigure(currentFigureIndex + 1));
  $("#figure-auto").addEventListener("click", () => setFigureAuto(!figureAuto));
  $(".left-rail").addEventListener("wheel", handleFigureWheel, {passive:false});
  const divider = $("#pane-divider");
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !window.matchMedia("(min-width: 901px)").matches) return;
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
  window.addEventListener("scroll", () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {scrollQueued = false;syncFigureToScroll();scheduleReadingSave();});
  }, {passive:true});
  window.addEventListener("resize", () => {applyPaneRatio();syncFigureToScroll();applyFigureScale();applyAllInlineFigureScales();if(readingBottomIntent)window.scrollTo({top:document.documentElement.scrollHeight,behavior:"instant"});});
}

start();
