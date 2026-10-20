"""Bounded, anonymous bibliographic lookup against the fixed Crossref endpoint."""
from collections import OrderedDict, deque
import copy
import fnmatch
import html
import json
import re
import threading
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler
from .service import ServiceError

_JOURNALS = {
    'jacs': 'Journal of the American Chemical Society',
    'j am chem soc': 'Journal of the American Chemical Society',
    'angew chem int ed': 'Angewandte Chemie International Edition',
    'angew chem': 'Angewandte Chemie',
    'nat chem': 'Nature Chemistry', 'nat catal': 'Nature Catalysis',
    'chem rev': 'Chemical Reviews', 'chem soc rev': 'Chemical Society Reviews',
    'org lett': 'Organic Letters', 'j org chem': 'The Journal of Organic Chemistry',
    'acs catal': 'ACS Catalysis', 'chem sci': 'Chemical Science',
    'chem commun': 'Chemical Communications', 'nat commun': 'Nature Communications',
}
_LOCK = threading.Lock()
_CACHE = OrderedDict()
_CLIENTS = OrderedDict()
# Limits/cache are per service process; hosting may additionally limit across instances.
_GLOBAL = deque()


def normalize(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value))).strip()


def expand_journals(value):
    value = value.replace('.', '')
    for short, full in sorted(_JOURNALS.items(), key=lambda x: -len(x[0])):
        value = re.sub(r'(?<!\w)' + re.escape(short) + r'(?!\w)', full, value, flags=re.I)
    return value


def _text(value):
    return normalize(html.unescape(re.sub(r'<[^>]*>', '', str(value))))[:1500]


def _candidate(item):
    if not isinstance(item, dict): return None
    doi = normalize(item.get('DOI', '')).lower()
    if not re.fullmatch(r'10\.\d{4,9}/[^\s<>"\x00-\x1f]+', doi):
        return None
    raw_authors = item.get('author') or []
    authors = [_text(' '.join(str(value) for value in [a.get('given'), a.get('family')] if value) or a.get('name', '')) for a in (raw_authors if isinstance(raw_authors, list) else [])[:40] if isinstance(a, dict)]
    date_source = item.get('published') or item.get('issued') or {}
    dates = date_source.get('date-parts', [[]]) if isinstance(date_source, dict) else [[]]
    year = str(dates[0][0]) if isinstance(dates, list) and dates and isinstance(dates[0], list) and dates[0] else ''
    titles, journals = item.get('title') or [''], item.get('container-title') or ['']
    title = _text(titles[0] if isinstance(titles, list) else titles)
    journal = _text(journals[0] if isinstance(journals, list) else journals)
    volume, pages = _text(item.get('volume', '')), _text(item.get('page', item.get('article-number', '')))
    citation = f"{'; '.join(authors)}. {title}. {journal} {year}, {volume}, {pages}. https://doi.org/{doi}"
    return dict(doi=doi, title=title, authors=authors, journal=journal, year=year,
                volume=volume, pages=pages, url='https://doi.org/' + quote(doi, safe='/'), citation=citation)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ServiceError(503, 'literature_unavailable')


def _fetch(path):
    request = Request('https://api.crossref.org/works' + path,
                      headers={'User-Agent': 'MetalRadical-LiteratureLookup/1.0 (https://metalradical.xyz)', 'Accept': 'application/json'})
    try:
        with build_opener(_NoRedirect).open(request, timeout=8) as response:
            data = response.read(1_000_001)
            if len(data) > 1_000_000:
                raise ServiceError(503, 'literature_unavailable')
            return json.loads(data)['message']
    except HTTPError as error:
        if error.code == 404:
            return None
        raise ServiceError(503, 'literature_unavailable') from None
    except (URLError, TimeoutError, ValueError, KeyError, OSError):
        raise ServiceError(503, 'literature_unavailable') from None


def _limit(key, now):
    with _LOCK:
        for queue in (_GLOBAL,):
            while queue and now - queue[0] >= 60: queue.popleft()
        queue = _CLIENTS.setdefault(str(key)[:128], deque())
        _CLIENTS.move_to_end(str(key)[:128])
        while queue and now - queue[0] >= 60: queue.popleft()
        if len(queue) >= 12 or len(_GLOBAL) >= 60:
            raise ServiceError(429, 'literature_rate_limited')
        queue.append(now); _GLOBAL.append(now)
        while len(_CLIENTS) > 512: _CLIENTS.popitem(last=False)


def lookup(query, client_key=''):
    query = normalize(query)
    if len(query) < 3 or len(query) > 600 or not isinstance(query, str):
        raise ServiceError(400, 'literature_query_invalid')
    if not re.search(r'[\w\u4e00-\u9fff]', re.sub(r'[*?]', '', query)):
        raise ServiceError(400, 'literature_query_invalid')
    now = time.monotonic()
    _limit(client_key, now)
    with _LOCK:
        cached = _CACHE.get(query)
        if cached and now - cached[0] < 3600:
            _CACHE.move_to_end(query)
            return copy.deepcopy(cached[1])
    doi_match = re.search(r'10\.\d{4,9}/[^\s<>"?#]+', query, re.I)
    doi = doi_match.group().rstrip('.,;，。').lower() if doi_match else ''
    # Citation wrapping punctuation may be removed; balanced DOI parentheses stay.
    while doi and doi[-1:] in (')', ']', '}') and doi.count(doi[-1]) > doi.count({')':'(', ']':'[', '}':'{'}[doi[-1]]):
        doi = doi[:-1]
    doi_url = bool(re.search(r'https?://(?:dx\.)?doi\.org/', query, re.I))
    wildcard = '*' in query or ('?' in query and not doi_url)
    if doi_match and not wildcard:
        item = _fetch('/' + quote(doi, safe=''))
        raw = [item] if item else []
    else:
        # Wildcards are local candidate tests, never passed off as Crossref syntax.
        terms = re.sub(r'[*?]', ' ', expand_journals(query))
        if len(re.sub(r'\W', '', terms)) < 3:
            raise ServiceError(400, 'literature_query_invalid')
        params = {'query.bibliographic': terms, 'rows': 5, 'filter': 'type:journal-article'}
        year = re.search(r'(?<!\d)((?:19|20)\d{2})(?!\d)', terms)
        if year:
            params['filter'] += f',from-pub-date:{year.group()}-01-01,until-pub-date:{year.group()}-12-31'
        # Separate the recognized journal from numeric citation fields; Crossref's
        # combined bibliographic query otherwise overweights the journal name.
        for journal in sorted(set(_JOURNALS.values()), key=len, reverse=True):
            if journal.lower() in terms.lower():
                params['query.container-title'] = journal
                rest = re.sub(re.escape(journal), ' ', terms, flags=re.I)
                if year: rest = rest.replace(year.group(), ' ')
                params['query.bibliographic'] = normalize(rest) or terms
                break
        message = _fetch('?' + urlencode(params))
        raw_items = message.get('items', []) if isinstance(message, dict) else []
        raw = raw_items[:5] if isinstance(raw_items, list) else []
    results = [candidate for item in raw if (candidate := _candidate(item))]
    if wildcard:
        pattern = expand_journals(query).lower()
        for result in results:
            fields = [result['title'], result['doi'], result['journal'], result['citation']]
            corpus = expand_journals(' '.join(fields)).lower()
            # Citation field order is arbitrary. Each term is checked independently;
            # * spans any text and ? one character within this candidate only.
            tokens = re.findall(r'[\w*?]+(?:[-/][\w*?]+)*', pattern)
            result['patternMatch'] = all(fnmatch.fnmatchcase(corpus, '*' + token + '*') for token in tokens if token.strip('*?'))
        results.sort(key=lambda result: not result['patternMatch'])
    result = {'query': query, 'results': results, 'wildcard': wildcard,
              'notice': ('通配符仅在本次返回的候选题录中比对；未匹配不代表全库无结果，请核对候选或补充完整信息。' if wildcard else '候选来自 Crossref 题录，请核对题名、作者及期刊后打开。')}
    with _LOCK:
        _CACHE[query] = (now, result)
        _CACHE.move_to_end(query)
        while len(_CACHE) > 128: _CACHE.popitem(last=False)
    return copy.deepcopy(result)
