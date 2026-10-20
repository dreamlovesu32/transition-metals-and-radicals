"""Private, dependency-free reading workbench. Run only on 127.0.0.1."""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import tempfile
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from article_config import load_active_article, load_article, public_article, public_catalog, CATALOG_IDS

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
BACKUPS = DATA / "backups"
LOCK = threading.RLock()
PORT = int(os.environ.get("READING_WORKBENCH_PORT", "8765"))
def language(value):
    if value not in ("zh", "en"):
        raise ValueError("Unsupported language")
    return value


def now():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def source_blocks(markdown):
    """Split an authored guide into individually editable reading units."""
    blocks = []
    lines = markdown.replace("\r\n", "\n").split("\n")
    paragraph = []

    def add(kind, value, **extra):
        value = value.strip()
        if not value:
            return
        digest = hashlib.sha256((kind + "\0" + value).encode("utf-8")).hexdigest()[:12]
        blocks.append({"id": f"b{len(blocks)+1:03d}-{digest}", "kind": kind, "text": value, **extra})

    def flush():
        if paragraph:
            add("paragraph", "\n".join(paragraph))
            paragraph.clear()

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush()
            continue
        image = re.fullmatch(r"!\[(.*?)\]\((figures/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|jpe?g|webp))\)", stripped, re.I)
        if image:
            flush()
            add("figure", image.group(1), src=image.group(2))
        elif stripped.startswith("#") and re.match(r"^#{1,6}\s+", stripped):
            flush()
            marks, heading = stripped.split(" ", 1)
            add("title" if len(marks) == 1 and not blocks else "heading", heading, level=len(marks))
        elif re.match(r"^[-*] \S", stripped):
            flush()
            add("bullet", stripped[2:])
        elif re.match(r"^\d+\. \S", stripped):
            flush()
            add("number", re.sub(r"^\d+\.\s+", "", stripped))
        elif stripped.startswith("> "):
            flush()
            add("quote", stripped[2:])
        elif stripped.startswith("|"):
            flush()
            add("table", stripped)
        else:
            paragraph.append(stripped)
    flush()
    return blocks


def read_state(article, lang):
    source, state_path = article["content"][lang], article["state"][lang]
    DATA.mkdir(parents=True, exist_ok=True)
    BACKUPS.mkdir(parents=True, exist_ok=True)
    if state_path.exists():
        return json.loads(state_path.read_text(encoding="utf-8"))
    if not source.exists():
        return {"revision": 0, "sourceReady": False, "blocks": [], "selections": [], "language": lang}
    raw = source.read_text(encoding="utf-8")
    state = {"revision": 1, "sourceReady": True, "sourceSha256": hashlib.sha256(raw.encode()).hexdigest(),
             "createdAt": now(), "updatedAt": now(), "blocks": source_blocks(raw), "selections": [], "language": lang}
    persist(article, lang, state, backup=False)
    return state


def persist(article, lang, state, backup=True):
    state_path = article["state"][lang]
    state_path.parent.mkdir(parents=True, exist_ok=True)
    BACKUPS.mkdir(parents=True, exist_ok=True)
    if backup and state_path.exists():
        old = state_path.read_bytes()
        stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")
        (BACKUPS / f"{article['id']}-{lang}-r{state['revision']-1}-{stamp}.json").write_bytes(old)
    payload = json.dumps(state, ensure_ascii=False, indent=2) + "\n"
    fd, temp = tempfile.mkstemp(prefix=f".{article['id']}-{lang}-", suffix=".json", dir=state_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, state_path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


from local_demo import DemoMixin

class Handler(DemoMixin, BaseHTTPRequestHandler):
    server_version = "ReadingWorkbench/1.0"

    def log_message(self, fmt, *args):
        print(f"[{now()}] {self.address_string()} {fmt % args}", flush=True)

    def json_response(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def file_response(self, path, content_type=None):
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        if path.suffix == ".html":
            data = self.demo_html(data)
        self.send_response(200)
        self.send_header("Content-Type", content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.demo_handle(): return
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path in ("/", "/catalog", "/index.html"):
            return self.file_response(ROOT / "catalog.html", "text/html; charset=utf-8")
        if path in ("/read", "/read.html"):
            return self.file_response(ROOT / "index.html", "text/html; charset=utf-8")
        member_file = re.fullmatch(r"/member-system/(members\.js|members\.css|article-export\.js|account\.html|favorites\.html|admin\.html)", path)
        if member_file:
            return self.file_response(ROOT / "member-system" / member_file.group(1))
        if path == "/catalog.css":
            return self.file_response(ROOT / "catalog.css", "text/css; charset=utf-8")
        if path == "/catalog.js":
            return self.file_response(ROOT / "catalog.js", "text/javascript; charset=utf-8")
        if path in ('/literature-lookup.js', '/literature-lookup.css', '/reader-chrome.js', '/reader-chrome.css'):
            return self.file_response(ROOT / path[1:])
        if path == '/api/member/literature':
            import sys
            member_root = str(ROOT.parent / '会员服务')
            if member_root not in sys.path: sys.path.insert(0, member_root)
            from member_service.literature import lookup
            from member_service.service import ServiceError
            try:
                return self.json_response(200, lookup(query.get('q', [''])[0], self.client_address[0]))
            except ServiceError as error:
                return self.json_response(error.status, {'error': error.code})
        if path == "/app.css":
            return self.file_response(ROOT / "app.css", "text/css; charset=utf-8")
        if path == "/inline-format.js":
            return self.file_response(ROOT / "inline-format.js", "text/javascript; charset=utf-8")
        if path == "/app.js":
            return self.file_response(ROOT / "app.js", "text/javascript; charset=utf-8")
        if path in ("/api/catalog", "/catalog.json"):
            return self.json_response(200, {"articles": public_catalog()})
        if path == "/api/info":
            return self.json_response(200, {"workspace": str(ROOT.parent), "workbench": str(ROOT), "article": load_active_article()["id"]})
        try:
            article = load_article(query.get("article", [None])[0])
        except ValueError:
            return self.json_response(404, {"error": "Unknown article"})
        if path == "/api/document":
            try:
                lang = language(query.get("lang", ["zh"])[0])
            except ValueError:
                return self.json_response(400, {"error": "Unsupported language"})
            with LOCK:
                state = read_state(article, lang)
                if lang == "zh":
                    from local_demo import LOCK as DEMO_LOCK, snapshot as demo_snapshot
                    with DEMO_LOCK: demo_snapshot(article["id"])
                from export_github_pages import public_blocks
                blocks = public_blocks(state, article, require_approval=False)
                version_hash = hashlib.sha256(json.dumps(blocks, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
                return self.json_response(200, {**state, "article": public_article(article), "version_hash": version_hash})
        if path == "/api/export-selections":
            try:
                lang = language(query.get("lang", ["zh"])[0])
            except ValueError:
                return self.json_response(400, {"error": "Unsupported language"})
            with LOCK:
                selections = read_state(article, lang)["selections"]
            text = (("待讨论的划词 — 文献 " if lang == "zh" else "Unfamiliar words and phrases — Paper ") + article["displayNumber"]) + "\n\n"
            for i, entry in enumerate(selections, 1):
                text += f"{i}. {entry['text']}\n   Context: {entry['context']}\n   Saved: {entry['createdAt']}\n\n"
            data = text.encode("utf-8-sig")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{article["id"]}-words-{lang}.txt"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if path == "/source.pdf":
            return self.file_response(article["sourcePdf"], "application/pdf")
        cover = re.fullmatch(r"/covers/([a-z0-9-]+)\.png", path)
        if cover and cover.group(1) in CATALOG_IDS:
            return self.file_response(load_article(cover.group(1))["cover"], "image/png")
        image = re.fullmatch(r"/figures/([a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|jpe?g|webp))", path, re.I)
        if image and image.group(1) in {figure["file"] for figure in article["figures"]}:
            return self.file_response(article["figuresDir"] / image.group(1))
        self.send_error(404)

    def do_POST(self):
        if self.demo_handle(): return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return self.json_response(415, {"error": "JSON required"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > 200_000:
                return self.json_response(413, {"error": "Invalid request size"})
            body = json.loads(self.rfile.read(size))
        except (ValueError, json.JSONDecodeError):
            return self.json_response(400, {"error": "Invalid JSON"})
        path = urlparse(self.path).path
        try:
            lang = language(body.get("language", "zh"))
        except ValueError:
            return self.json_response(400, {"error": "Unsupported language"})
        try:
            article = load_article(body.get("article"))
        except ValueError:
            return self.json_response(404, {"error": "Unknown article"})
        with LOCK:
            state = read_state(article, lang)
            if path == "/api/block":
                if body.get("revision") != state["revision"]:
                    return self.json_response(409, {"error": "Article changed elsewhere. Reload before saving."})
                block = next((b for b in state["blocks"] if b["id"] == body.get("id")), None)
                value = body.get("text")
                if block is None or not isinstance(value, str) or not value.strip() or len(value) > 20_000:
                    return self.json_response(400, {"error": "Invalid edit"})
                if block["text"] != value.strip():
                    if lang == "zh":
                        from local_demo import LOCK as DEMO_LOCK, snapshot as demo_snapshot
                        with DEMO_LOCK: demo_snapshot(article["id"])
                    block["text"] = value.strip()
                    block["editedAt"] = now()
                    state["revision"] += 1
                    state["updatedAt"] = now()
                    persist(article, lang, state)
                    if lang == "zh":
                        with DEMO_LOCK: demo_snapshot(article["id"])
                return self.json_response(200, {"revision": state["revision"], "block": block})
            if path == "/api/selection":
                value = body.get("text")
                context = body.get("context")
                block_id = body.get("blockId")
                if not isinstance(value, str) or not value.strip() or len(value) > 500 or not isinstance(context, str) or len(context) > 4000:
                    return self.json_response(400, {"error": "Select a short word or phrase"})
                if not any(b["id"] == block_id for b in state["blocks"]):
                    return self.json_response(400, {"error": "Select text from the article"})
                value = value.strip()
                if any(s["text"].casefold() == value.casefold() and s["blockId"] == block_id for s in state["selections"]):
                    return self.json_response(409, {"error": "Already saved in this paragraph"})
                entry = {"id": os.urandom(8).hex(), "text": value, "context": context.strip(), "blockId": block_id, "createdAt": now()}
                state["selections"].append(entry)
                state["revision"] += 1
                state["updatedAt"] = now()
                persist(article, lang, state)
                return self.json_response(201, {"revision": state["revision"], "selection": entry})
            if path == "/api/selection/delete":
                old = len(state["selections"])
                state["selections"] = [s for s in state["selections"] if s["id"] != body.get("id")]
                if len(state["selections"]) == old:
                    return self.json_response(404, {"error": "Selection not found"})
                state["revision"] += 1
                state["updatedAt"] = now()
                persist(article, lang, state)
                return self.json_response(200, {"revision": state["revision"]})
        self.send_error(404)


if __name__ == "__main__":
    print(f"Reading workbench: http://127.0.0.1:{PORT}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
