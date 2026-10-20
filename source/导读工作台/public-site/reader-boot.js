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
  const touched = () => { readerTouched = true; };
  for (const type of ["wheel","touchstart","pointerdown","keydown"]) window.addEventListener(type,touched,{once:true,passive:true});
  if (reviewMode) {
    configureReviewNavigation();
    document.addEventListener("read-members-expired", clearPrivateReview);
  }
  loadLayoutPreference();
  $("#panel-figure-retry").addEventListener("click", retryPanelFigure);
  $("#reading-preparation-retry").addEventListener("click", () => {
    if (!documentState?.article) location.reload();
    else finishReadingPreparation(true);
  });
  try {
    let articles = [];
    if (reviewMode) {
      if (!requestedArticleId || !/^[\w-]+$/.test(requestedArticleId)) throw new Error("稿件编号无效");
      await reviewMemberBridge();
      await (window.ReadMembers.authReady || window.ReadMembers.ready);
      reviewIdentity = {epoch:window.ReadMembers.state.epoch, uid:window.ReadMembers.state.user?.id};
      assertReviewIdentity();
      const response = await fetch(`/api/member/admin/drafts/${encodeURIComponent(requestedArticleId)}${requestedVersion ? "?version="+encodeURIComponent(requestedVersion) : ""}`, {credentials:"same-origin", cache:"no-store", signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error([401,403].includes(response.status) ? "请使用管理员账号登录后查看稿件" : "稿件暂时无法载入，请重试");
      reviewDraft = await response.json();
      assertReviewIdentity();
      documentState = adaptReviewDraft(reviewDraft, requestedArticleId);
    } else {
    window.ReadPublished.catalog('./catalog.json').then(data => {
      articles = data.articles; window.ReadMembers?.setPublicCatalog?.(articles); configureReadingNavigation(articles);
    }).catch(() => {});
    documentState = await window.ReadPublished.read(requestedArticleId,`./data/${encodeURIComponent(requestedArticleId)}.json`);
    }
    restoringReadingState = true;
    const localSaved = reviewMode || window.ReadMembers?.state.authStatus === "ready" ? storedReadingState() : null;
    const saved = localSaved;
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
    updateReadingChrome();
    renderArticle();
    applyPaneRatio();
    restoreStartScrollY = window.scrollY;
    window.addEventListener("scroll", handleReadingScroll, {passive:true});
    await restoreReadingState(saved);
    syncFigureToScroll();
    await finishReadingPreparation();
    if (reviewMode) assertReviewIdentity();
    if (!reviewMode) configureReadingNavigation(articles);
    mountReadingTools(articles.find(a=>a.id===articleId()),()=>readerTouched);
  } catch(error) {
    console.error("Reader preparation failed", error);
    restoringReadingState = false;
    $("#article").innerHTML = '<h1 class="article-title">阅读内容暂时无法载入</h1><p>' + (reviewMode ? escapeHtml(error.message || "请返回稿件审核重试。") : '请从文献导航重新选择文章。') + '</p>';
    showPreparationFailure(reviewMode ? error.message || "稿件暂时无法载入，请重试。" : "阅读内容暂时无法载入，请重试。");
  }
  $("#nav-top").addEventListener("click", () => {if(window.ReadChrome?.jump)return window.ReadChrome.jump("top");readingBottomIntent = false; window.scrollTo({top:0,behavior:"smooth"});});
  $("#nav-bottom").addEventListener("click", () => {if(window.ReadChrome?.jump)return window.ReadChrome.jump("bottom");readingBottomIntent = true; window.scrollTo({top:document.documentElement.scrollHeight,behavior:"smooth"});});
  window.addEventListener("wheel", event => {if(!event.ctrlKey) readingBottomIntent = false;}, {passive:true});
  window.addEventListener("touchmove", () => {readingBottomIntent = false;}, {passive:true});
  window.addEventListener("keydown", event => {if(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "].includes(event.key)) readingBottomIntent = false;});
  $("#nav-prev").addEventListener("click", event => navigateToArticle(event.currentTarget));
  $("#nav-next").addEventListener("click", event => navigateToArticle(event.currentTarget));
  $("#nav-catalog").addEventListener("click", saveReadingState);
  $("#footer-catalog").addEventListener("click", saveReadingState);
  $("#footer-top").addEventListener("click", () => {if(window.ReadChrome?.jump)return window.ReadChrome.jump("top");readingBottomIntent = false; window.scrollTo({top:0,behavior:"smooth"});});
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
    applyPaneRatio();syncFigureToScroll();applyFigureScale();applyAllInlineFigureScales();
    if(readingBottomIntent)window.scrollTo({top:document.documentElement.scrollHeight,behavior:"instant"});
  });
}

start();
