"""Read-only checks before activating a new article manifest."""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from article_config import ROOT, load_manifest

FIGURE_LINE = re.compile(r"!\[.*?\]\(figures/([a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|jpe?g|webp))\)", re.I)


def validate(path: Path) -> list[str]:
    article = load_manifest(path)
    errors = []
    names = [figure["file"] for figure in article["figures"]]
    if not article["sourcePdf"].is_file():
        errors.append(f"Source PDF missing: {article['sourcePdf']}")
    for name in names:
        if not (article["figuresDir"] / name).is_file():
            errors.append(f"Figure missing: {article['figuresDir'] / name}")
    for lang, source in article["content"].items():
        if not source.is_file():
            if lang == "zh":
                errors.append(f"Chinese guide missing: {source}")
            continue  # English can be published later; the UI shows its preparing state.
        markdown = source.read_text(encoding="utf-8")
        used = [match.group(1) for line in markdown.splitlines() if (match := FIGURE_LINE.fullmatch(line.strip()))]
        if used != names:
            errors.append(f"{lang} figure lines {used!r} do not match manifest order {names!r}")
        if not any(line.startswith("# ") for line in markdown.splitlines()):
            errors.append(f"{lang} guide needs an H1 title")
    for lang, state in article["state"].items():
        if state.exists():
            errors.append(f"State already exists: {state} (preserve edits; do not re-import)")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="Article manifest inside articles/")
    parser.add_argument("--existing", action="store_true", help="Inspect an already active article without treating state files as errors")
    args = parser.parse_args()
    errors = validate(args.manifest)
    if args.existing:
        errors = [error for error in errors if not error.startswith("State already exists:")]
    for error in errors:
        print("ERROR:", error)
    if errors:
        return 1
    print("Article data valid:", args.manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
