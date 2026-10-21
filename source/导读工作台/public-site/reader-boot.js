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
