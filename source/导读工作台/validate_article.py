"""Validate, inspect, and initialize article data using the shared reader template."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path

from article_config import ROOT, discover_articles, load_manifest
from reader_contract import compile_reading_plan


def article_blocks(article: dict, lang: str = "zh") -> list[dict]:
    """Saved state is authoritative; Markdown only initializes a missing state."""
    state = article["state"][lang]
    if state.is_file():
        data = json.loads(state.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("blocks"), list):
            raise ValueError(f"Invalid state blocks: {state}")
        return data["blocks"]
    from server import source_blocks
    return source_blocks(article["content"][lang].read_text(encoding="utf-8"))


def validate(path: Path, *, existing: bool = False) -> list[str]:
    errors = []
    try:
        article = load_manifest(path)
        discover_articles()  # Reject conflicting ids/reading ids/shared state ownership.
    except (ValueError, TypeError, KeyError, OSError) as exc:
        return [str(exc)]
    for label, asset in (("Source PDF", article["sourcePdf"]), ("Cover", article["cover"]),
                         *(("Figure", article["figuresDir"] / f["file"]) for f in article["figures"])):
        if not asset.is_file():
            errors.append(f"{label} missing: {asset}")
    for lang in ("zh", "en"):
        state, source = article["state"][lang], article["content"][lang]
        if state.exists() and not existing:
            errors.append(f"State already exists: {state} (preserve edits; use --existing)")
        if not source.is_file() and not state.is_file():
            if lang == "zh":
                errors.append(f"Chinese guide missing: {source}")
            continue  # English is optional.
        try:
            if state.is_file():
                payload = json.loads(state.read_text(encoding="utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("State must be an object")
                if not payload.get("sourceReady") and not payload.get("blocks") and lang == "en":
                    continue
                if payload.get("sourceReady") is not True or type(payload.get("revision")) is not int or payload["revision"] < 1:
                    raise ValueError("Existing guide needs sourceReady and a positive integer revision")
            blocks = article_blocks(article, lang)
            compile_reading_plan(article, blocks)
            if not blocks or blocks[0].get("kind") != "title":
                raise ValueError("Guide must start with an H1 title")
            if sum(b.get("kind") == "title" for b in blocks) != 1:
                raise ValueError("Guide must have exactly one title")
            used = [b.get("src") for b in blocks if b.get("kind") == "figure"]
            names = ["figures/" + f["file"] for f in article["figures"]]
            # Reusing one crop in several figure blocks is supported; assets appear
            # in manifest order on their first occurrence.
            if list(dict.fromkeys(used)) != names:
                raise ValueError(f"Figure asset order {used!r} does not match manifest {names!r}")
            for block in blocks:
                if block.get("kind") not in ("title", "heading", "paragraph", "figure", "bullet", "number", "quote", "table"):
                    raise ValueError(f"Unsupported block kind: {block.get('kind')}")
                if not isinstance(block.get("text"), str) or not block["text"].strip():
                    raise ValueError(f"Empty block/caption: {block.get('id')}")
        except (ValueError, TypeError, KeyError, OSError) as exc:
            errors.append(f"{lang}: {exc}")
    return errors


def plan(path: Path) -> dict:
    errors = validate(path, existing=True)
    if errors:
        raise ValueError("; ".join(errors))
    article = load_manifest(path)
    blocks = article_blocks(article)
    return {"articleId": article["id"], "scope": "local-private",
            "reading": compile_reading_plan(article, blocks),
            "anchors": [{"id": block["id"], "kind": block["kind"], "textPreview": block["text"][:100]}
                        for block in blocks]}


def build(path: Path, *, preview: bool = False) -> dict:
    """Create missing state only. No active pointer, existing state, or approval writes."""
    errors = validate(path, existing=True)
    if errors:
        raise ValueError("; ".join(errors))
    article = load_manifest(path)
    created, preserved = [], []
    for lang in ("zh", "en"):
        target, source = article["state"][lang], article["content"][lang]
        if target.exists():
            preserved.append(str(target))
            continue
        if not source.is_file():
            continue
        raw = source.read_text(encoding="utf-8")
        blocks = article_blocks(article, lang)
        compile_reading_plan(article, blocks)
        timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
        payload = {"revision": 1, "sourceReady": True,
                   "sourceSha256": hashlib.sha256(raw.encode()).hexdigest(),
                   "createdAt": timestamp, "updatedAt": timestamp,
                   "blocks": blocks, "selections": [], "language": lang}
        target.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation also protects an edit that arrived after validation.
        with target.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        created.append(str(target))
    if preview:
        script = ROOT.parent / "工具" / "构建审稿预览.py"
        spec = importlib.util.spec_from_file_location("read_local_preview_builder", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.build()
    return {"articleId": article["id"], "scope": "local-private", "created": created, "preserved": preserved,
            "preview": preview, "localReadUrl": f"http://127.0.0.1:8765/read?article={article['id']}",
            "previewDirectory": str(ROOT.parent / "审稿预览"),
            "previewCommand": f"python validate_article.py build articles/{article['id']}.json --preview"}


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    argv = list(sys.argv[1:] if argv is None else argv)
    # Retain the original `validate_article.py manifest --existing` entry point.
    if argv and argv[0] not in ("validate", "plan", "build", "-h", "--help"):
        argv.insert(0, "validate")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("validate", "plan", "build"):
        sub = commands.add_parser(command)
        sub.add_argument("manifest", type=Path, help="Article manifest inside articles/")
        sub.add_argument("--existing", action="store_true", help="Preserve and inspect existing state as the authority")
        if command == "build":
            sub.add_argument("--preview", action="store_true", help="Also run the existing local review preview builder; never publish")
    args = parser.parse_args(argv)
    errors = validate(args.manifest, existing=args.existing or args.command in ("plan", "build"))
    if errors:
        for error in errors:
            print("ERROR:", error)
        return 1
    try:
        if args.command == "validate":
            print("Article data valid:", args.manifest)
        else:
            result = plan(args.manifest) if args.command == "plan" else build(args.manifest, preview=args.preview)
            print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, TypeError, KeyError, OSError, RuntimeError) as exc:
        print("ERROR:", exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
