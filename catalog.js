"use strict";

const $ = selector => document.querySelector(selector);
let catalogArticles = [];
let catalogFlight=null,catalogReadFailed=false;

function articleCard(article) {
  const card = document.createElement("article");
  card.className = "catalog-card";
  card.dataset.articleId = article.id;
  const link = document.createElement("a");
  link.className = "catalog-main-link";
  link.target = "_blank";
  link.rel = "noopener";
  link.href = `./read.html?article=${encodeURIComponent(article.id)}`;
  link.setAttribute("aria-label", `阅读 ${article.title}`);
  const cover = document.createElement("div");
  cover.className = "catalog-cover";
  const coverLink = document.createElement("a");
  coverLink.className = "catalog-cover-link";
  coverLink.href = link.href;
  coverLink.target = link.target;
  coverLink.rel = link.rel;
  coverLink.tabIndex = -1;
  coverLink.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.dataset.src = article.cover;
  image.decoding = "async";
  image.alt = `${article.journal} 论文首页题名与作者截图`;
  image.loading = "lazy";
  cover.append(image);
  window.ReadMedia?.cover(image, article);
  const body = document.createElement("div");
  body.className = "catalog-card-body";
  const meta = document.createElement("div");
  meta.className = "catalog-meta";
  const metaRow = document.createElement("div");
  metaRow.className = "card-meta-row";
  metaRow.append(meta);
  for (const value of [article.journal, article.published]) {
    const part = document.createElement("span");
    part.textContent = value;
    meta.append(part);
  }
  if (article.reviewStatus === "pending" || article.reviewStatus === "proofreading") {
    const badge = document.createElement("span");
    badge.className = "catalog-review-pending";
    badge.textContent = article.reviewStatus === "proofreading" ? "待校对" : "待审核";
    meta.append(badge);
  }
  const title = document.createElement("h3");
  title.textContent = article.title;
  const foot = document.createElement("div");
  foot.className = "catalog-card-foot";
  const doi = document.createElement("span");
  doi.textContent = article.doi;
  const read = document.createElement("span");
  read.className = "catalog-read";
  read.innerHTML = "继续阅读 <span class=ui-arrow-right aria-hidden=true></span>";
  foot.append(doi, read);
  link.append(title, foot);
  body.append(metaRow, link);
  coverLink.append(cover);
  card.append(coverLink, body);
  window.ReadCardActions?.mount(card, article);
  return card;
}

function patchArticleCard(card,article) {
  const meta=card.querySelector('.catalog-meta');
  meta.children[0].textContent=article.journal;
  (meta.querySelector('.card-date')?.firstElementChild||meta.children[1]).textContent=article.published;
  let pending=meta.querySelector('.catalog-review-pending');
  const label=article.reviewStatus==='pending'?'待审核':article.reviewStatus==='proofreading'?'待校对':'';
  if(label&&!pending){pending=document.createElement('span');pending.className='catalog-review-pending';meta.append(pending);}
  if(pending){if(label)pending.textContent=label;else pending.remove();}
  card.querySelector('h3').textContent=article.title;
  card.querySelector('.catalog-main-link').setAttribute('aria-label',`阅读 ${article.title}`);
  card.querySelector('.catalog-card-foot').firstElementChild.textContent=article.doi;
  const source=card.querySelector('.card-source-link'),url=window.ReadCardActions?.sourceUrl(article);
  if(source&&url)source.href=url;
  const image=card.querySelector('.catalog-cover img'),next=article.coverDisplay||article.cover;
  if(image.dataset.src!==next){image.removeAttribute('src');image.dataset.src=next;window.ReadMedia?.load(image,'low');}
  window.ReadCardActions?.update(card,article);
}

function startCatalog({refresh=false}={}) {
  if(catalogFlight)return catalogFlight;
  catalogFlight=(async()=>{try {
    // Static covers and article cards need not wait for the publication service.
    if (window.ReadPublished && !catalogArticles.length) {
      try {
        const initial = await (await fetch("./catalog.json")).json();
        catalogArticles = initial.articles; renderCatalog();
      } catch (_) {}
    }
    const data = window.ReadPublished ? await window.ReadPublished.catalog("./catalog.json",{refresh}) : await (await fetch("./catalog.json", {cache:"no-store"})).json();
    const {articles} = data;
    if(!Array.isArray(articles))throw Object.assign(Error('Invalid catalog'),{kind:'application',code:'invalid_catalog'});
    catalogReadFailed=false;
    if (JSON.stringify(catalogArticles) !== JSON.stringify(articles)) {
      catalogArticles = articles;
      renderCatalog();
    }
  } catch(error) {
    catalogReadFailed=true;window.ReadPublished?.reportReadFailure?.(error,'catalog');
    window.ReadToast?.show({key:'catalog-read',kind:'error',message:window.ReadPublished?.failureMessage?.(error)||'目录暂时无法读取，已保留当前列表。'});
  }})().finally(()=>{catalogFlight=null;});
  return catalogFlight;
}
window.addEventListener?.('online',()=>{if(catalogReadFailed)void startCatalog({refresh:true});});
window.addEventListener?.('focus',()=>{if(catalogReadFailed)void startCatalog({refresh:true});});

function sortedArticles(kind) {
  const mode = $("#catalog-sort").value;
  const key = article => mode === "published" ? article.firstPublishedOn : Date.parse(article.updatedAt);
  return catalogArticles.filter(article => article.kind === kind).sort((a,b) => {
    const left = key(a), right = key(b);
    if (left !== right) return left < right ? 1 : -1;
    return b.readingId.localeCompare(a.readingId);
  });
}

function updateTrackControls(kind) {
  const section = $(`#${kind}`);
  const track = $(`#${kind}-list`);
  const expanded = section.classList.contains("is-expanded");
  const max = Math.max(0, track.scrollWidth - track.clientWidth);
  section.querySelector(".catalog-arrow-prev").disabled = expanded || track.scrollLeft <= 2;
  section.querySelector(".catalog-arrow-next").disabled = expanded || track.scrollLeft >= max - 2;
}

function renderCatalog() {
  window.ReadMembers?.setPublicCatalog(catalogArticles);
  document.querySelector('.catalog-main')?.removeAttribute('aria-busy');
  for (const kind of ["research", "review"]) {
    const articles = sortedArticles(kind);
    const track = $(`#${kind}-list`);
    // Initial loading placeholders have no stable identity; remove every one.
    [...track.children].filter(card=>!card.dataset.articleId).forEach(card=>card.remove());
    const previous=new Map([...track.children].map(card=>[card.dataset.articleId,card]));
    const left=track.scrollLeft,focused=track.contains(document.activeElement)?document.activeElement:null;
    for (const [index,article] of articles.entries()) {
      const card=previous.get(article.id)||articleCard(article);
      if(previous.has(article.id))patchArticleCard(card,article);
      previous.delete(article.id);
      if(track.children[index]!==card)track.insertBefore(card,track.children[index]||null);
    }
    previous.forEach(card=>card.remove());
    track.scrollLeft=left;
    if(focused?.isConnected&&document.activeElement!==focused)focused.focus({preventScroll:true});
    $(`#${kind}-count`).textContent = `${articles.length} 篇`;
    const empty = $(`#${kind}-empty`);
    if (empty) empty.hidden = articles.length > 0;
    const section = $(`#${kind}`);
    section.querySelector(".catalog-track-shell").hidden = articles.length === 0;
    section.querySelector(".catalog-expand").hidden = articles.length === 0;
    requestAnimationFrame(() => { updateTrackControls(kind); prepareCovers(track); });
  }
  window.ReadCardActions?.hydrate(catalogArticles);
}

function moveTrack(kind, direction) {
  const track = $(`#${kind}-list`);
  const card = track.querySelector(".catalog-card");
  if (!card) return;
  const gap = parseFloat(getComputedStyle(track).columnGap) || 14;
  const width = card.getBoundingClientRect().width;
  const visible = Math.max(1, Math.round((track.clientWidth + gap) / (width + gap)));
  track.scrollBy({left:direction * visible * (width + gap), behavior:"smooth"});
}

function toggleExpanded(kind) {
  const section = $(`#${kind}`);
  const expanded = section.classList.toggle("is-expanded");
  const button = section.querySelector(".catalog-expand");
  button.setAttribute("aria-expanded", String(expanded));
  button.textContent = expanded ? "收起" : "展开全部";
  if (!expanded) section.querySelector(".catalog-track").scrollLeft = 0;
  updateTrackControls(kind);
}

$("#catalog-sort").addEventListener("change", renderCatalog);
for (const kind of ["research", "review"]) {
  $(`#${kind}-list`).addEventListener("scroll", () => updateTrackControls(kind), {passive:true});
  $(`#${kind} .catalog-expand`).addEventListener("click", () => toggleExpanded(kind));
  for (const direction of [-1, 1]) {
    const selector = direction < 0 ? ".catalog-arrow-prev" : ".catalog-arrow-next";
    $(`#${kind} ${selector}`).addEventListener("click", () => moveTrack(kind, direction));
  }
}
window.addEventListener("resize", () => {updateTrackControls("research");updateTrackControls("review");});

startCatalog();

function prepareCovers(track) {
  if (window.ReadMedia) { window.ReadMedia.prepare(track); return; }
  const images = [...track.querySelectorAll('img[data-src]')];
  const load = (image, priority) => {
    if (image.getAttribute('src')) return;
    image.fetchPriority = priority; image.src = image.dataset.src;
  };
  const observer = new IntersectionObserver(entries => {
    for (const item of entries) if (item.isIntersecting) { load(item.target, 'high'); observer.unobserve(item.target); }
  }, {root:track, rootMargin:'0px', threshold:0.01});
  images.forEach(image => observer.observe(image));
  // Yield to visible covers, then warm the remaining cards in display order.
  setTimeout(async () => {
    for (const image of images) {
      if (!image.isConnected) break;
      if (image.getAttribute('src')) continue;
      image.loading = 'eager'; load(image, 'low');
      await Promise.race([image.decode().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,8000))]);
    }
    observer.disconnect();
  }, 1500);
}
