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
  // The reader precedes members.js in the deferred script queue.
  if (!window.ReadMembers && document.readyState !== "complete") await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, {once:true}));
  if (!window.ReadMembers) throw new Error("账号组件暂时无法载入，请刷新重试");
  return window.ReadMembers;
}
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
const ui = {zh:{source:"原文 / 第",page:"页",figureNote:"论文原图裁切 · 下方按钮缩放，放大后可双向滚动"}};
function tr(key) { return ui.zh[key]; }
function articleId() { return documentState?.article?.id || requestedArticleId; }
function articleAsset(path) {
  if (reviewMode) {
    const assetId = documentState?.asset_map?.[path];
    if (!assetId || !/^[\w-]+$/.test(assetId)) throw new Error("稿件图片尚未就绪");
    return requestedVersion ? `/api/member/admin/drafts/${encodeURIComponent(articleId())}/versions/${encodeURIComponent(requestedVersion)}/assets/${encodeURIComponent(assetId)}` : `/api/member/admin/drafts/${encodeURIComponent(articleId())}/assets/${encodeURIComponent(assetId)}`;
  }
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
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
function inlineMarkdown(text) { return window.ReadInline.html(text); }

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
