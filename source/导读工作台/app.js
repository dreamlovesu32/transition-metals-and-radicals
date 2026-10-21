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
  for (const type of ["wheel","touchstart","pointerdown","keydown"]) window.addEventListener(type,()=>{readerTouched=true;window.ReadReaderTouched=true;},{once:true,passive:true});
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
    const saved=null;readingPreparationSaved=null;pendingPanelViewport=null;pendingInlinePositions=null;
    currentFigureIndex=0;saveReadingState.progressed=false;window.ReadReaderTouched=false;
    window.scrollTo({top:0,behavior:"instant"});
    primeCurrentFigure();
    updateLanguageChrome();
    renderArticle();
    applyPaneRatio();
    if (READING_TOOLS_ENABLED) renderSelections();
    restoreStartScrollY = window.scrollY;
    window.addEventListener("scroll", handleReadingScroll, {passive:true});
    await restoreReadingState(null);
    window.scrollTo({top:0,behavior:"instant"});
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
window.ReadBlockTools = {attach(block, wrap) {
  if (!READING_TOOLS_ENABLED) return;
  const edit = document.createElement("button");
  edit.type = "button"; edit.className = "edit-trigger"; edit.textContent = tr("edit");
  edit.setAttribute("aria-label", `${tr("edit")} ${blockName(block.kind)}`);
  edit.addEventListener("click", () => openEditor(block, wrap)); wrap.prepend(edit);
}};

start();
