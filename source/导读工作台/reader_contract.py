"""Pure article reading contract. No writes, approval changes, or state migration."""
from __future__ import annotations

import math


def _fraction(value, name, *, open_interval=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    if not (0 < value < 1 if open_interval else 0 <= value <= 1):
        raise ValueError(f"{name} is outside its allowed range")
    return value


def reading_settings(article: dict) -> dict:
    reading = article.get("reading", {})
    if not isinstance(reading, dict) or set(reading) - {"version", "downThreshold", "upBuffer", "endBuffer", "switches"}:
        raise ValueError("Invalid reading settings or unknown field")
    if "reading" in article and (isinstance(reading.get("version"), bool) or not isinstance(reading.get("version"), (int, float)) or reading["version"] != 1):
        raise ValueError("reading.version must be 1")
    switches = reading.get("switches", [])
    if not isinstance(switches, list):
        raise ValueError("reading.switches must be a list")
    return {
        "version": 1,
        "downThreshold": _fraction(reading.get("downThreshold", article.get("scrollThreshold", .52)), "downThreshold", open_interval=True),
        "upBuffer": _fraction(reading.get("upBuffer", .18), "upBuffer"),
        "endBuffer": _fraction(reading.get("endBuffer", .25), "endBuffer"),
        "switches": switches,
    }


def compile_reading_plan(article: dict, blocks: list[dict]) -> dict:
    settings = reading_settings(article)
    if not isinstance(blocks, list) or not blocks:
        raise ValueError("Article requires nonempty blocks")
    ids = set()
    figures = []
    names = {"figures/" + figure["file"] for figure in article["figures"]}
    for block in blocks:
        block_id = block.get("id") if isinstance(block, dict) else None
        if not isinstance(block_id, str) or not block_id.strip() or block_id in ids:
            raise ValueError(f"Missing or duplicate block id: {block_id!r}")
        ids.add(block_id)
        if block.get("kind") not in ("title", "heading", "paragraph", "figure", "bullet", "number", "quote", "table"):
            raise ValueError(f"Unsupported block kind: {block.get('kind')}")
        if block["kind"] == "heading":
            level = block.get("level", 2)
            if isinstance(level, bool) or not isinstance(level, (int, float)) or level not in (2, 3, 4):
                raise ValueError("Heading level must be an integer from 2 to 4")
        if block.get("kind") == "figure":
            if not isinstance(block.get("src"), str) or block["src"] not in names:
                raise ValueError(f"Unlisted figure asset: {block.get('src')}")
            figures.append(block)
        elif "scrollTrigger" in block:
            raise ValueError("scrollTrigger is only valid on a figure")
    if not figures:
        raise ValueError("Article requires at least one figure block")
    figure_ids = {block["id"] for block in figures}
    overrides = {}
    for item in settings["switches"]:
        if not isinstance(item, dict) or set(item) - {"figureId", "trigger", "anchorId"}:
            raise ValueError("Invalid reading switch or unknown field")
        figure_id = item.get("figureId")
        if not isinstance(figure_id, str) or figure_id not in figure_ids or figure_id in overrides:
            raise ValueError(f"Unknown or duplicate figureId: {figure_id!r}")
        if item.get("trigger") not in ("block", "article-end"):
            raise ValueError("Switch trigger must be block or article-end")
        if item["trigger"] == "article-end" and (figure_id != figures[-1]["id"] or "anchorId" in item):
            raise ValueError("article-end is only valid for final figure without anchorId")
        anchor_id = item.get("anchorId", figure_id)
        if item["trigger"] == "block" and (not isinstance(anchor_id, str) or anchor_id not in ids):
            raise ValueError(f"Unknown anchorId: {anchor_id!r}")
        overrides[figure_id] = item
    plan = []
    for block in figures:
        legacy = block.get("scrollTrigger")
        if legacy is not None and (legacy != "article-end" or block is not figures[-1]):
            raise ValueError("Legacy article-end trigger must belong to final figure")
        item = overrides.get(block["id"], {"figureId": block["id"], "trigger": legacy or "block"})
        entry = {"figureId": block["id"], "trigger": item["trigger"]}
        if item["trigger"] == "block":
            entry["anchorId"] = item.get("anchorId", block["id"])
        plan.append(entry)
    return {**settings, "switches": plan}
