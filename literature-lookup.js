"use strict";
(() => {
  const mount = document.querySelector('[data-member-nav]');
  if (!mount) return;
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'literature-toggle';
  toggle.title = '文献直达'; toggle.setAttribute('aria-label', '文献直达');
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'literature-lookup');
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
  mount.prepend(toggle);
  const lookup = document.createElement('section');
  lookup.id = 'literature-lookup'; lookup.className = 'literature-lookup'; lookup.hidden = true;
  lookup.setAttribute('aria-label', '文献直达');
  lookup.innerHTML = '<div class="literature-heading"><h2>文献直达</h2><button class="literature-close" type="button" aria-label="关闭文献直达"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><form id="literature-form" class="literature-form" role="search"><label for="literature-query" class="literature-input-label">检索文献</label><input id="literature-query" type="search" name="q" maxlength="600" required minlength="3" placeholder="DOI、题名或期刊 年份 卷 页码" aria-describedby="literature-status"><button type="submit">检索</button></form><p id="literature-status" class="literature-status" role="status" aria-live="polite" aria-atomic="true"></p><div id="literature-results" class="literature-results" hidden><div class="literature-result-head"><h2>文献候选</h2><button id="literature-collapse" class="literature-collapse" type="button" aria-controls="literature-results">收起结果</button></div><div id="literature-candidates" class="literature-candidates"></div></div>';
  document.body.append(lookup);
  mount.classList.add('has-literature-lookup');
  const form = document.querySelector('#literature-form');
  if (!form) return;
  const input = form.querySelector('input');
  const status = document.querySelector('#literature-status');
  const panel = document.querySelector('#literature-results');
  const list = document.querySelector('#literature-candidates');
  const submit = form.querySelector('button');
  function closeLookup(restoreFocus = true) {
    lookup.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus({preventScroll: true});
  }
  toggle.addEventListener('click', () => {
    if (!lookup.hidden) { closeLookup(); return; }
    const bounds = toggle.getBoundingClientRect();
    const top = Math.max(12, Math.min(bounds.bottom + 10, window.innerHeight - 170));
    lookup.style.top = `${top}px`;
    lookup.style.maxHeight = `calc(100dvh - ${top + 12}px)`;
    lookup.hidden = false; toggle.setAttribute('aria-expanded', 'true');
    input.focus({preventScroll: true});
  });
  lookup.querySelector('.literature-close').addEventListener('click', () => closeLookup());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !lookup.hidden) { event.preventDefault(); closeLookup(); }
  });
  document.addEventListener('pointerdown', event => {
    if (!lookup.hidden && !lookup.contains(event.target) && !toggle.contains(event.target)) closeLookup(false);
  });
  document.addEventListener('focusin', event => {
    if (!lookup.hidden && !lookup.contains(event.target) && !toggle.contains(event.target)) closeLookup(false);
  });
  let controller;
  let catalogPromise;
  const doiKey = value => String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  const titleKey = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  function queryDoi(value) {
    const normalized = String(value || '').normalize('NFKC').trim();
    const doiUrl = /^https?:\/\/(?:dx\.)?doi\.org\//i.test(normalized);
    if (normalized.includes('*') || (!doiUrl && normalized.includes('?'))) return '';
    let doi = normalized.match(/10\.\d{4,9}\/[^\s<>"?#]+/i)?.[0].replace(/[.,;，。]+$/, '') || '';
    const pairs = {')': '(', ']': '[', '}': '{'};
    while (pairs[doi.at(-1)] && doi.split(doi.at(-1)).length > doi.split(pairs[doi.at(-1)]).length) doi = doi.slice(0, -1);
    return doiKey(doi);
  }
  function destination(item, catalog) {
    const doi = doiKey(item.doi);
    if (!/^10\.\d{4,9}\/[^\s<>"\x00-\x1f]+$/i.test(doi)) return null;
    const local = (catalog.articles || []).find(article => doiKey(article.doi) === doi);
    return local ? {label: '阅读本站导读', href: `./read.html?article=${encodeURIComponent(local.id)}`}
      : {label: '原文链接', href: `https://doi.org/${encodeURIComponent(doi).replace(/%2F/gi, '/')}`};
  }
  function definiteResult(query, data) {
    const results = data.results || [];
    const doi = queryDoi(query);
    const exact = doi ? results.filter(item => doiKey(item.doi) === doi)
      : !data.wildcard && !/[*?]/.test(query) ? results.filter(item => titleKey(item.title) === titleKey(query) && titleKey(query).length >= 12) : [];
    // A sole fuzzy candidate is still ambiguous; only exact DOI/title evidence qualifies.
    const unique = new Map(exact.map(item => [doiKey(item.doi), item]));
    return unique.size === 1 ? [...unique.values()][0] : null;
  }
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  async function fetchJson(url, active, timeoutMs, timeoutMessage, options = {}) {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; active.abort(); }, timeoutMs);
    try {
      const response = await fetch(url, {...options, signal: active.signal});
      const data = await response.json();
      return {response, data};
    } catch (error) {
      if (timedOut) throw new Error(timeoutMessage);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  function loadCatalog() {
    if (!catalogPromise && window.ReadPublished) return window.ReadPublished.catalog('./catalog.json');
    if (!catalogPromise) {
      catalogPromise = fetchJson('./catalog.json', new AbortController(), 5000, '导读目录加载超时。')
        .then(({response, data}) => {
          if (!response.ok) throw new Error('catalog_unavailable');
          return data;
        }).catch(() => {
          // A failed/expired catalog must be retried on the next search.
          catalogPromise = undefined;
          return {articles: [], unavailable: true};
        });
    }
    return catalogPromise;
  }
  function link(text, href) {
    const node = element('a', text); node.href = href;
    return node;
  }
  document.querySelector('#literature-collapse').addEventListener('click', () => {
    panel.hidden = true; status.textContent = '结果已收起，可再次检索。'; input.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const query = input.value.trim();
    if (query.length < 3) { status.textContent = '请至少输入 3 个字符。'; input.focus(); return; }
    controller?.abort(); controller = new AbortController();
    const active = controller;
    submit.disabled = true; form.setAttribute('aria-busy', 'true');
    status.textContent = '正在核对文献题录…'; panel.hidden = true; list.replaceChildren();
    try {
      const {response, data} = await fetchJson(`/api/member/literature?q=${encodeURIComponent(query)}`, active, 15000, '文献检索超时，请稍后重试。', {credentials: 'omit'});
      if (!response.ok) throw new Error(response.status === 429 ? '检索较频繁，请稍后再试。' : response.status === 400 ? '请补充题名、DOI 或期刊卷页信息后重试。' : '题录服务暂时无法连接，请稍后重试。');
      const catalog = await loadCatalog();
      if (active !== controller) return;
      const definite = definiteResult(query, data);
      // If the catalog is unavailable, do not assume this site lacks a guide.
      const direct = definite && !catalog.unavailable && destination(definite, catalog);
      if (direct) {
        status.textContent = direct.label === '阅读本站导读' ? '已确认文献，正在打开本站导读…' : '已确认文献，正在打开原文…';
        window.location.assign(direct.href);
        return;
      }
      for (const item of data.results || []) {
        const card = element('article', '', 'literature-card');
        card.append(element('h3', item.title || '题名未提供'));
        card.append(element('p', (item.authors || []).join('; ') || '作者信息未提供', 'literature-authors'));
        card.append(element('p', [item.journal, item.year, item.volume, item.pages].filter(Boolean).join(' · ')));
        card.append(element('p', item.doi, 'literature-doi'));
        if (data.wildcard) card.append(element('p', item.patternMatch ? '本次候选：符合通配模式' : '相关候选：未严格符合通配模式', 'literature-match'));
        const actions = element('div', '', 'literature-actions');
        const target = destination(item, catalog);
        if (target) actions.append(link(target.label, target.href));
        const copy = element('button', '复制引文'); copy.type = 'button';
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(item.citation); status.textContent = '引文已复制。'; }
          catch { const text = element('textarea'); text.value = item.citation; text.readOnly = true; text.setAttribute('aria-label', '请手动复制引文'); card.append(text); text.focus(); text.select(); status.textContent = '请复制已选中的引文。'; }
        }); actions.append(copy);
        card.append(actions); list.append(card);
      }
      status.textContent = data.results?.length ? `找到 ${data.results.length} 条候选。${data.notice || ''}` : '本次未返回候选；可补充题名、作者或期刊卷页后再试，这不代表文献不存在。';
      if (catalog.unavailable && data.results?.length) status.textContent += ' 本站导读目录暂未加载，原文链接和引文仍可使用。';
      panel.hidden = !data.results?.length;
    } catch (error) {
      if (active === controller && error.name !== 'AbortError') status.textContent = error.message || '检索失败，请重试。';
    } finally {
      if (active === controller) { submit.disabled = false; form.removeAttribute('aria-busy'); }
    }
  });
})();
