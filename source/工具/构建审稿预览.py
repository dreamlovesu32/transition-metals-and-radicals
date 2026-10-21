"""Build a local static review preview. This directory is never a deploy source."""
from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import sys
import uuid
from pathlib import Path

APP = Path(r"D:\Read\导读工作台")
DEST = Path(r"D:\Read\审稿预览")
sys.path.insert(0, str(APP))
from article_config import CATALOG_IDS, catalog_entry, load_catalog  # noqa: E402
from export_github_pages import public_blocks, public_reader_script, public_stylesheet, write_text, export_members  # noqa: E402
from media_assets import export_media, dimensions  # noqa: E402


def build() -> None:
    if DEST.resolve() != Path(r"D:\Read\审稿预览").resolve():
        raise RuntimeError("Unexpected preview destination")
    stage = DEST.parent / f".review-preview-stage-{uuid.uuid4().hex[:8]}"
    stage.mkdir()
    try:
        articles = load_catalog()
        if {item["id"] for item in articles} != set(CATALOG_IDS):
            raise RuntimeError("Unexpected review catalog")
        export_members(stage)
        catalog = []
        for item in articles:
            state = json.loads(item["state"]["zh"].read_text(encoding="utf-8"))
            blocks = public_blocks(state, item, require_approval=False)
            public = {
                "id": item["id"], "readingId": item["readingId"],
                "displayNumber": item["displayNumber"], "title": item["title"], "kind": item["kind"],
                "sourceUrl": item["sourceUrl"],
                "figurePages": {f"figures/{figure['file']}": figure["page"] for figure in item["figures"]},
                "scrollThreshold": item["scrollThreshold"],
                "figureMedia": export_media(stage, item),
            }
            if "reading" in item:
                public["reading"] = item["reading"]
            write_text(stage / "data" / f"{item['id']}.json", json.dumps({"article": public, "blocks": blocks, "version_hash": hashlib.sha256(json.dumps(blocks, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()}, ensure_ascii=False, indent=2) + "\n")
            (stage / "covers").mkdir(exist_ok=True)
            shutil.copyfile(item["cover"], stage / "covers" / f"{item['id']}.png")
            figure_dir = stage / "figures" / item["id"]
            figure_dir.mkdir(parents=True)
            for figure in item["figures"]:
                shutil.copyfile(item["figuresDir"] / figure["file"], figure_dir / figure["file"])
            catalog.append({**catalog_entry(item, f"./covers/{item['id']}.png"),
                            "coverDisplay": f"./media/{item['id']}/cover.webp",
                            "coverPreview": f"./media/{item['id']}/cover-small.webp",
                            "coverWidth": dimensions(item["cover"])["width"],
                            "coverHeight": dimensions(item["cover"])["height"]})
        write_text(stage / "catalog.json", json.dumps({"articles": catalog}, ensure_ascii=False, indent=2) + "\n")
        html = (APP / "catalog.html").read_text(encoding="utf-8")
        html = html.replace('href="/card-actions.css', 'href="./card-actions.css').replace('src="/card-actions.js', 'src="./card-actions.js')
        html = html.replace('href="/progressive-media.css', 'href="./progressive-media.css').replace('src="/progressive-media.js', 'src="./progressive-media.js')
        html = html.replace('href="/literature-lookup.css', 'href="./literature-lookup.css').replace('src="/literature-lookup.js', 'src="./literature-lookup.js')
        html = html.replace('href="/"', 'href="./index.html"').replace('href="/catalog.css', 'href="./catalog.css').replace('src="/catalog.js', 'src="./catalog.js').replace('href="/member-system/', 'href="./member-system/').replace('src="/member-system/', 'src="./member-system/')
        write_text(stage / "index.html", html)
        for name in ('member-loader.js', 'toast.js', 'toast.css', 'literature-lookup.js', 'literature-lookup.css', 'reader-chrome.js', 'reader-chrome.css', 'inline-format.js', 'progressive-media.js', 'progressive-media.css', 'card-actions.js', 'card-actions.css'):
            content = (APP / name).read_text(encoding='utf-8')
            if name.endswith('.js'):
                content = content.replace("'/api/catalog'", "'./catalog.json'").replace('`/read?article=', '`./read.html?article=')
            write_text(stage / name, content)
        script = (APP / "catalog.js").read_text(encoding="utf-8")
        script = script.replace('fetch("/api/catalog"', 'fetch("./catalog.json"').replace('`/read?article=', '`./read.html?article=')
        write_text(stage / "catalog.js", script)
        write_text(stage / "catalog.css", public_stylesheet((APP / "catalog.css").read_text(encoding="utf-8")))
        write_text(stage / "read.html", (APP / "public-site" / "read.html").read_text(encoding="utf-8"))
        write_text(stage / "reader.js", public_reader_script())
        write_text(stage / "app.css", public_stylesheet((APP / "app.css").read_text(encoding="utf-8")))
        write_text(stage / "published-library.js", (APP / "public-site" / "published-library.js").read_text(encoding="utf-8"))
        # Use the same reader dependency order and cache binding as the public builder,
        # while retaining this preview's private, complete catalog above.
        for html_path in stage.rglob("*.html"):
            html = html_path.read_text(encoding="utf-8")
            library_src = "../published-library.js" if html_path.parent.name == "member-system" else "./published-library.js"
            html = html.replace("<head>", '<head><script defer src="' + library_src + '"></script>', 1)
            def version_asset(match):
                attr, url = match.group(1), match.group(2)
                relative = url.split("?", 1)[0]
                if relative.startswith(("http:", "https:", "//")):
                    return match.group(0)
                asset = stage / relative.lstrip("/") if relative.startswith("/") else html_path.parent / relative
                if asset.suffix not in (".js", ".css") or not asset.is_file():
                    return match.group(0)
                digest = hashlib.sha256(asset.read_bytes()).hexdigest()[:16]
                return f'{attr}="{relative}?v={digest}"'
            html = re.sub(r'(src|href)="([^"]+)"', version_asset, html)
            write_text(html_path, html)
        write_text(stage / "审稿预览-禁止上传.txt", "仅供本机预览：2026-10-18 新稿待审核。请只使用独立发布目录部署，勿上传本目录。\n")
        if DEST.exists():
            if not DEST.is_dir() or not (DEST / "审稿预览-禁止上传.txt").is_file():
                raise RuntimeError("Unrecognized review preview directory")
            expected = {p.relative_to(stage) for p in stage.rglob("*") if p.is_file()}
            found = set()
            for base, dirs, files in os.walk(DEST):
                found.update((Path(base) / name).relative_to(DEST) for name in files)
            if found - expected:
                raise RuntimeError(f"Unexpected files in review preview: {found - expected}")
            for source in stage.rglob("*"):
                if source.is_file():
                    target = DEST / source.relative_to(stage)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
        else:
            stage.rename(DEST)
        print(f"Local review preview ready: {DEST}; articles={len(catalog)}")
    finally:
        if stage.exists() and stage.resolve().parent == DEST.parent.resolve():
            shutil.rmtree(stage)


if __name__ == "__main__":
    build()
