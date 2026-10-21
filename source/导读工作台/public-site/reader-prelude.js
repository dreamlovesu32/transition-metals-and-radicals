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
