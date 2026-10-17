"use strict";

const $ = selector => document.querySelector(selector);

function articleCard(article) {
  const link = document.createElement("a");
  link.className = "catalog-card";
  link.href = `./read.html?article=${encodeURIComponent(article.id)}`;
  link.setAttribute("aria-label", `阅读 ${article.title}`);
  const cover = document.createElement("div");
  cover.className = "catalog-cover";
  const image = document.createElement("img");
  image.src = article.cover;
  image.alt = `${article.journal} 论文首页题名与作者截图`;
  image.loading = "lazy";
  cover.append(image);
  const body = document.createElement("div");
  body.className = "catalog-card-body";
  const meta = document.createElement("div");
  meta.className = "catalog-meta";
  for (const value of [article.readingId, article.journal, article.published]) {
    const part = document.createElement("span");
    part.textContent = value;
    meta.append(part);
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
    const response = await fetch("./catalog.json", {cache:"no-store"});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const {articles} = await response.json();
    const research = articles.filter(article => article.kind === "research");
    const reviews = articles.filter(article => article.kind === "review");
    research.forEach(article => $("#research-list").append(articleCard(article)));
    reviews.forEach(article => $("#review-list").append(articleCard(article)));
    $("#research-count").textContent = `${research.length} 篇`;
    $("#review-count").textContent = `${reviews.length} 篇`;
    $("#review-empty").hidden = reviews.length > 0;
  } catch(error) {
    $("#research-list").textContent = "目录暂时无法载入，请刷新页面重试。";
  }
}

startCatalog();
