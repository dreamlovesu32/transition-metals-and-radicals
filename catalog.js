"use strict";

const $ = selector => document.querySelector(selector);
let catalogArticles = [];

function articleCard(article) {
  const link = document.createElement("a");
  link.className = "catalog-card";
  link.target = "_blank";
  link.rel = "noopener";
  link.href = `./read.html?article=${encodeURIComponent(article.id)}`;
  link.setAttribute("aria-label", `阅读 ${article.title}`);
  const cover = document.createElement("div");
  cover.className = "catalog-cover";
  const image = document.createElement("img");
  image.dataset.src = article.cover;
  image.decoding = "async";
  image.alt = `${article.journal} 论文首页题名与作者截图`;
  image.loading = "lazy";
  cover.append(image);
  const body = document.createElement("div");
  body.className = "catalog-card-body";
  const meta = document.createElement("div");
  meta.className = "catalog-meta";
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
  body.append(meta, title, foot);
  link.append(cover, body);
  return link;
}

async function startCatalog() {
  try {
    // Static covers and article cards need not wait for the publication service.
    if (window.ReadPublished) {
      try {
        const initial = await (await fetch("./catalog.json")).json();
        catalogArticles = initial.articles; renderCatalog();
      } catch (_) {}
    }
    const data = window.ReadPublished ? await window.ReadPublished.catalog("./catalog.json") : await (await fetch("./catalog.json", {cache:"no-store"})).json();
    const {articles} = data;
    catalogArticles = articles;
    renderCatalog();
  } catch(error) {
    $("#research-list").textContent = "目录暂时无法载入，请刷新页面重试。";
  }
}

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
  for (const kind of ["research", "review"]) {
    const articles = sortedArticles(kind);
    const track = $(`#${kind}-list`);
    track.replaceChildren(...articles.map(articleCard));
    track.scrollLeft = 0;
    $(`#${kind}-count`).textContent = `${articles.length} 篇`;
    const empty = $(`#${kind}-empty`);
    if (empty) empty.hidden = articles.length > 0;
    const section = $(`#${kind}`);
    section.querySelector(".catalog-track-shell").hidden = articles.length === 0;
    section.querySelector(".catalog-expand").hidden = articles.length === 0;
    requestAnimationFrame(() => { updateTrackControls(kind); prepareCovers(track); });
  }
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
