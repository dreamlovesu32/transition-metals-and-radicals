"""Build the explicitly authorized static site. Never copy the workbench tree."""
from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import uuid
from pathlib import Path

from article_config import ROOT, catalog_entry, load_article
from media_assets import export_media, dimensions


DEST = ROOT.parent / "发布" / "github-pages"
PUBLIC_IDS = ("paper01", "r20261017-01", "r20261017-02", "r20261017-04", "r20261017-05", "r20261018-01")
BASELINE = json.loads((ROOT / "publication-baseline.json").read_text(encoding="utf-8"))["articles"]
PUBLIC_SOURCE = ROOT / "public-site"
EXPORT_MARKER = ".nojekyll"

def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def public_reader_script() -> str:
    """The same complete runtime serves local, published and private review pages."""
    sources = (ROOT / "reader-contract.js", PUBLIC_SOURCE / "reader-prelude.js",
               ROOT / "reader-core.js", PUBLIC_SOURCE / "reader-boot.js")
    result = "\n\n".join(path.read_text(encoding="utf-8").strip() for path in sources) + "\n"
    forbidden = ("/source.pdf", "openEditor", "captureSelection", "renderSelections",
                 "openLightbox", "closeLightbox", "#lightbox", "selection", "editor", "audit")
    present = [token for token in forbidden if token.lower() in result.lower()]
    if present:
        raise RuntimeError(f"Private reader code leaked into static build: {present}")
    if "/api/" in result.replace("/api/member/admin/drafts/", ""):
        raise RuntimeError("Unexpected private API in static reader")
    return result


def public_stylesheet(source: str) -> str:
    """Discard unused private-tool rules while retaining the reading layout."""
    excluded = (".right-rail", ".tool-", ".tools-", ".edit-", ".edited",
                ".selection-", ".source-audit", ".lightbox", ".zoom-chip",
                ".figure-media", "#toast", ".private-badge", ".private-dot",
                ".saved-", ".language-switch", ".export", ".shortcut")

    def clean(match: re.Match[str]) -> str:
        selector, declarations = match.groups()
        kept = [part for part in selector.split(",") if not any(token in part for token in excluded)]
        return ",".join(kept) + "{" + declarations + "}" if kept else ""

    result = re.sub(r"([^{}]+)\{([^{}]*)\}", clean, source)
    if result.count("{") != result.count("}"):
        raise RuntimeError("Public stylesheet has unbalanced braces")
    return result


def publication_digest(article: dict, blocks: list[dict]) -> str:
    """Bind approval to displayed metadata, text, captions, cover, and figure bytes."""
    metadata = {key: article[key] for key in ("id", "readingId", "displayNumber", "title", "doi", "sourceUrl", "journal", "published", "firstPublishedOn", "kind", "scrollThreshold")}
    metadata["reviewStatus"] = article.get("reviewStatus", "existing-public-baseline")
    metadata["figures"] = article["figures"]
    if "reading" in article:
        metadata["reading"] = article["reading"]
    payload = json.dumps({"metadata": metadata, "blocks": blocks}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(payload)
    for image in [article["cover"], *(article["figuresDir"] / item["file"] for item in article["figures"])]:
        digest.update(image.read_bytes())
    return digest.hexdigest()


def public_blocks(state: dict, article: dict, *, require_approval: bool = True) -> list[dict]:
    if require_approval:
        status = article.get("reviewStatus", "existing-public-baseline")
        if status == "pending":
            raise RuntimeError(f"Review pending: {article['id']}")
        approval = BASELINE.get(article["id"])
        if not approval or approval.get("status") not in ("existing-public-baseline", "approved", "proofreading"):
            raise RuntimeError(f"No public baseline or user approval: {article['id']}")
        if status != approval["status"]:
            raise RuntimeError(f"Review status changed without authorization: {article['id']}")
        if state.get("revision") != approval["revision"] or not state.get("sourceReady"):
            raise RuntimeError(f"Unreviewed article revision: {article['id']}")
    elif not state.get("sourceReady"):
        raise RuntimeError(f"Article not ready even for local preview: {article['id']}")
    allowed = {"title", "heading", "paragraph", "figure", "bullet", "number", "quote", "table"}
    figure_names = {f"figures/{figure['file']}" for figure in article["figures"]}
    blocks = []
    last_figure = next((block for block in reversed(state["blocks"]) if block.get("kind") == "figure"), None)
    for block in state["blocks"]:
        if block.get("kind") not in allowed:
            raise RuntimeError(f"Unsupported public block kind: {block.get('kind')}")
        text = block.get("text", "")
        if not isinstance(text, str) or not text or re.search(r"(?<![A-Za-z])[A-Za-z]:[\\/]|file://|(?:\.\./)", text):
            raise RuntimeError(f"Unsafe public block text in {article['id']}")
        if block["kind"] == "heading" and re.search(r"^(?:原文核对|来源核查|Source audit)", text, re.I):
            raise RuntimeError("Internal source audit must not be published")
        clean = {key: block[key] for key in ("id", "kind", "text")}
        if block["kind"] == "heading":
            clean["level"] = block.get("level", 2)
        if block["kind"] == "figure":
            if block.get("src") not in figure_names:
                raise RuntimeError(f"Unlisted figure in {article['id']}")
            clean["src"] = block["src"]
        if block.get("scrollTrigger") is not None:
            if block["kind"] != "figure" or block is not last_figure or block["scrollTrigger"] != "article-end":
                raise RuntimeError("Article-end trigger must belong to the final figure")
            clean["scrollTrigger"] = "article-end"
        blocks.append(clean)
    if not blocks or blocks[0]["kind"] != "title":
        raise RuntimeError(f"No public article title in {article['id']}")
    from reader_contract import compile_reading_plan
    compile_reading_plan(article, blocks)
    if require_approval:
        digest = hashlib.sha256(json.dumps(blocks, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        if digest != approval["publicBlocksSha256"]:
            raise RuntimeError(f"Public content hash changed without approval: {article['id']}")
        if publication_digest(article, blocks) != approval["sourceBundleSha256"]:
            raise RuntimeError(f"Public title, metadata or image changed without approval: {article['id']}")
    return blocks


def export_article(stage: Path, article: dict) -> dict:
    article_id = article["id"]
    state = json.loads(article["state"]["zh"].read_text(encoding="utf-8"))
    blocks = public_blocks(state, article)
    public = {
        "id": article_id, "readingId": article["readingId"],
        "displayNumber": article["displayNumber"], "title": article["title"],
        "kind": article["kind"],
        "sourceUrl": article["sourceUrl"],
        "figurePages": {f"figures/{figure['file']}": figure["page"] for figure in article["figures"]},
        "scrollThreshold": article["scrollThreshold"],
        "figureMedia": export_media(stage, article),
    }
    labels = {f"figures/{f['file']}": f["sourceLabel"] for f in article["figures"] if "sourceLabel" in f}
    if labels:
        public["figureSourceLabels"] = labels
    if "reading" in article:
        public["reading"] = article["reading"]
    write_text(stage / "data" / f"{article_id}.json", json.dumps({"article": public, "blocks": blocks, "version_hash": hashlib.sha256(json.dumps(blocks, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()}, ensure_ascii=False, indent=2) + "\n")
    shutil.copyfile(article["cover"], stage / "covers" / f"{article_id}.png")
    (stage / "figures" / article_id).mkdir(parents=True, exist_ok=True)
    for figure in article["figures"]:
        shutil.copyfile(article["figuresDir"] / figure["file"], stage / "figures" / article_id / figure["file"])
    return {**catalog_entry(article, f"./covers/{article_id}.png"),
            "coverDisplay": f"./media/{article_id}/cover.webp",
            "coverPreview": f"./media/{article_id}/cover-small.webp",
            "coverWidth": dimensions(article["cover"])["width"],
            "coverHeight": dimensions(article["cover"])["height"],
            "reviewVersion": BASELINE[article_id]["sourceBundleSha256"],
            "version_hash": BASELINE[article_id]["publicBlocksSha256"]}


def export_members(stage: Path) -> None:
    for name in ("members.js", "members.css", "article-export.js", "account.html", "favorites.html", "admin.html"):
        text = (ROOT / "member-system" / name).read_text(encoding="utf-8")
        if name == "members.js":
            text = text.replace("'/api/catalog'", "new URL('catalog.json',scriptRoot).href")
            if "/api/" in text.replace("/api/member/", ""):
                raise RuntimeError("Non-member private API leaked into member client")
        write_text(stage / "member-system" / name, text)


def build() -> None:
    publication_root = (ROOT.parent / "发布").resolve()
    dest = DEST.resolve()
    if dest.parent != publication_root or dest.name != "github-pages":
        raise RuntimeError("Unexpected public output directory")
    publication_root.mkdir(parents=True, exist_ok=True)
    stage = publication_root / f".github-pages-stage-{uuid.uuid4().hex[:8]}"
    stage.mkdir()
    try:
        if set(BASELINE) != set(PUBLIC_IDS):
            raise RuntimeError("Public article whitelist changed")
        articles = [load_article(article_id) for article_id in PUBLIC_IDS]
        articles.sort(key=lambda item: (item["published"], item["readingId"]), reverse=True)
        (stage / "covers").mkdir()
        (stage / "figures").mkdir()
        export_members(stage)
        catalog = [export_article(stage, article) for article in articles]
        write_text(stage / "catalog.json", json.dumps({"articles": catalog}, ensure_ascii=False, indent=2) + "\n")
        catalog_html = (ROOT / "catalog.html").read_text(encoding="utf-8")
        catalog_html = catalog_html.replace('href="/card-actions.css', 'href="./card-actions.css').replace('src="/card-actions.js', 'src="./card-actions.js')
        catalog_html = catalog_html.replace('href="/progressive-media.css', 'href="./progressive-media.css').replace('src="/progressive-media.js', 'src="./progressive-media.js')
        catalog_html = catalog_html.replace('href="/literature-lookup.css', 'href="./literature-lookup.css').replace('src="/literature-lookup.js', 'src="./literature-lookup.js')
        catalog_html = catalog_html.replace('href="/"', 'href="./index.html"').replace('href="/catalog.css', 'href="./catalog.css').replace('src="/catalog.js', 'src="./catalog.js').replace('href="/member-system/', 'href="./member-system/').replace('src="/member-system/', 'src="./member-system/')
        write_text(stage / "index.html", catalog_html)
        for name in ("member-loader.js", "toast.js", "toast.css", "literature-lookup.js", "literature-lookup.css", "reader-chrome.js", "reader-chrome.css", "inline-format.js", "progressive-media.js", "progressive-media.css", "card-actions.js", "card-actions.css"):
            content = (ROOT / name).read_text(encoding="utf-8")
            if name.endswith('.js'):
                content = content.replace("'/api/catalog'", "'./catalog.json'").replace('`/read?article=', '`./read.html?article=')
                if '/api/' in content.replace('/api/member/literature', ''):
                    raise RuntimeError('Unexpected private lookup endpoint')
            write_text(stage / name, content)
        catalog_js = (ROOT / "catalog.js").read_text(encoding="utf-8")
        catalog_js = catalog_js.replace('fetch("/api/catalog"', 'fetch("./catalog.json"').replace('`/read?article=', '`./read.html?article=')
        catalog_js = catalog_js.replace("请检查本机阅读服务。", "请刷新页面重试。")
        if "/api/" in catalog_js or "`/read?" in catalog_js:
            raise RuntimeError("Catalog still points at the local server")
        write_text(stage / "catalog.js", catalog_js)
        write_text(stage / "read.html", (PUBLIC_SOURCE / "read.html").read_text(encoding="utf-8"))
        write_text(stage / "reader.js", public_reader_script())
        write_text(stage / "catalog.css", public_stylesheet((ROOT / "catalog.css").read_text(encoding="utf-8")))
        write_text(stage / "app.css", public_stylesheet((ROOT / "app.css").read_text(encoding="utf-8")))
        write_text(stage / "published-library.js", (PUBLIC_SOURCE / "published-library.js").read_text(encoding="utf-8"))
        # Bind every page to the exact exported JS/CSS, including member pages.
        # Otherwise returning users can keep executing a cached pre-fix client.
        for html_path in stage.rglob('*.html'):
            html = html_path.read_text(encoding='utf-8')
            library_src = "../published-library.js" if html_path.parent.name == "member-system" else "./published-library.js"
            html = html.replace("<head>", '<head><script defer src="' + library_src + '"></script>', 1)
            def version_asset(match):
                attr, url = match.group(1), match.group(2)
                relative = url.split('?', 1)[0]
                if relative.startswith(('http:', 'https:', '//')):
                    return match.group(0)
                asset = (stage / relative.lstrip('/')) if relative.startswith('/') else (html_path.parent / relative)
                if asset.suffix not in ('.js', '.css') or not asset.is_file():
                    return match.group(0)
                digest = hashlib.sha256(asset.read_bytes()).hexdigest()[:16]
                return f'{attr}="{relative}?v={digest}"'
            html = re.sub(r'(src|href)="([^"]+)"', version_asset, html)
            write_text(html_path, html)
        (stage / EXPORT_MARKER).touch()
        if dest.exists():
            if not dest.is_dir() or not ((dest / EXPORT_MARKER).is_file() or (dest / ".git").is_dir()):
                raise RuntimeError("Refusing to update an unrecognized public output directory")
            if dest.resolve() != DEST.resolve() or dest.parent.resolve() != publication_root:
                raise RuntimeError("Public output target escaped the named directory")
            expected = {path.relative_to(stage) for path in stage.rglob("*") if path.is_file()}
            present = set()
            for base, dirs, files in os.walk(dest):
                dirs[:] = [directory for directory in dirs if directory != ".git"]
                if Path(base) == dest:
                    # Independently audited repository source is preserved here,
                    # never copied into the exact CloudBase deployment stage.
                    dirs[:] = [directory for directory in dirs if directory != "source"]
                present.update((Path(base) / name).relative_to(dest) for name in files)
            extra = present - expected
            if extra:
                raise RuntimeError(f"Unexpected files in public output; refusing to delete: {sorted(map(str, extra))}")
            for source in stage.rglob("*"):
                if source.is_file():
                    target = dest / source.relative_to(stage)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
        else:
            stage.rename(dest)
        print(f"Built {dest} with {len(catalog)} authorized articles")
    finally:
        if stage.exists() and stage.resolve().parent == publication_root:
            shutil.rmtree(stage)


if __name__ == "__main__":
    build()
