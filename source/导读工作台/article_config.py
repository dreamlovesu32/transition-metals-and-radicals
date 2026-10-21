"""Small, validated article manifest used by the shared reading interface."""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parent
IMAGE_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|jpe?g|webp)", re.I)
ARTICLE_ID = re.compile(r"[a-z0-9][a-z0-9-]{1,63}")


def confined(base: Path, value: str) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute() or "\\" in value or ":" in value:
        raise ValueError(f"Invalid relative path: {value!r}")
    target = (base / value).resolve()
    if not target.is_relative_to(base.resolve()):
        raise ValueError(f"Path leaves {base}: {value}")
    return target


def load_manifest(path: Path) -> dict:
    path = path.resolve()
    if path.parent != (ROOT / "articles").resolve():
        raise ValueError("Article manifest must be directly inside articles/")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Article manifest must be an object")
    if not ARTICLE_ID.fullmatch(data.get("id", "")):
        raise ValueError("Article id must be lowercase letters, digits or hyphens")
    if path.name != f"{data['id']}.json":
        raise ValueError("Manifest filename must match article id")
    if not isinstance(data.get("readingId"), str) or not data["readingId"]:
        raise ValueError("readingId is required")
    if not isinstance(data.get("displayNumber"), str) or not data["displayNumber"]:
        raise ValueError("displayNumber is required")
    if not isinstance(data.get("title"), dict) or not all(isinstance(data["title"].get(lang), str) and data["title"][lang] for lang in ("zh", "en")):
        raise ValueError("Both article titles are required")
    for field in ("content", "state"):
        if not isinstance(data.get(field), dict) or set(data[field]) != {"zh", "en"}:
            raise ValueError(f"{field} needs zh and en paths")
        data[field] = {lang: confined(ROOT, data[field][lang]) for lang in ("zh", "en")}
    data["sourcePdf"] = confined(WORKSPACE, data["sourcePdf"])
    source_url = data.get("sourceUrl")
    if source_url is not None:
        if not isinstance(source_url, str):
            raise ValueError("sourceUrl must be an HTTPS URL")
        parsed = urlsplit(source_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("sourceUrl must be an HTTPS URL")
    data["figuresDir"] = confined(ROOT, data["figuresDir"])
    if data.get("kind") not in ("research", "review"):
        raise ValueError("kind must be research or review")
    if "reviewStatus" not in data:
        baseline_path = ROOT / "publication-baseline.json"
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))["articles"] if baseline_path.is_file() else {}
        data["reviewStatus"] = baseline.get(data["id"], {}).get("status", "pending")
    if data["reviewStatus"] not in ("pending", "approved", "proofreading", "existing-public-baseline"):
        raise ValueError("Invalid review status")
    if not re.fullmatch(r"\d{4}\.\d{2}", data.get("published", "")):
        raise ValueError("published must be YYYY.MM")
    first_published = data.get("firstPublishedOn", "")
    if not re.fullmatch(r"\d{4}-\d{2}(?:-\d{2})?", first_published):
        raise ValueError("firstPublishedOn must be a verified YYYY-MM or YYYY-MM-DD")
    date.fromisoformat(first_published if len(first_published) == 10 else first_published + "-01")
    if first_published[:7] != data["published"].replace(".", "-"):
        raise ValueError("firstPublishedOn must match published month")
    if not isinstance(data.get("journal"), str) or not data["journal"]:
        raise ValueError("journal is required")
    if not isinstance(data.get("doi"), str) or not re.fullmatch(r"10\.\d{4,9}/\S+", data["doi"]):
        raise ValueError("doi must be a complete DOI without URL prefix or spaces")
    data["cover"] = confined(ROOT, data["cover"])
    figures = data.get("figures")
    if not isinstance(figures, list) or not figures:
        raise ValueError("figures must be a nonempty ordered list")
    names = set()
    media_stems = set()
    for figure in figures:
        if not isinstance(figure, dict) or not IMAGE_NAME.fullmatch(figure.get("file", "")):
            raise ValueError("Invalid figure filename")
        if figure["file"].lower() in names or Path(figure["file"]).stem.lower() in media_stems or type(figure.get("page")) is not int or figure["page"] < 1:
            raise ValueError("Duplicate figure or invalid source PDF page")
        if "sourceLabel" in figure and (not isinstance(figure["sourceLabel"], str) or not re.fullmatch(r"(?:扩展图式|扩展图|扩展表|图式|图|表)\d+[A-Z]{0,3}(?:（局部）)?", figure["sourceLabel"])):
            raise ValueError("Invalid source figure label")
        names.add(figure["file"].lower())
        media_stems.add(Path(figure["file"]).stem.lower())
    threshold = data.get("scrollThreshold", 0.52)
    if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not 0 < threshold < 1:
        raise ValueError("scrollThreshold must be between 0 and 1")
    data["scrollThreshold"] = threshold
    from reader_contract import reading_settings
    reading_settings(data)
    return data


def discover_articles() -> dict[str, Path]:
    """Discover private manifests afresh; this does not grant publication approval."""
    result = {}
    reading_ids = set()
    state_paths = set()
    for path in sorted((ROOT / "articles").glob("*.json")):
        article = load_manifest(path)
        article_id = article["id"]
        if article_id in result:
            raise ValueError(f"Duplicate article id: {article_id}")
        if article["readingId"] in reading_ids:
            raise ValueError(f"Duplicate readingId: {article['readingId']}")
        for state_path in article["state"].values():
            if state_path in state_paths:
                raise ValueError(f"Shared state path: {state_path}")
            state_paths.add(state_path)
        result[article_id] = path
        reading_ids.add(article["readingId"])
    return result


class _CatalogIds:
    """Retain existing import sites while discovering additions without source edits."""
    def __iter__(self):
        return iter(discover_articles())

    def __contains__(self, article_id):
        return article_id in discover_articles()

    def __len__(self):
        return len(discover_articles())


CATALOG_IDS = _CatalogIds()


def load_active_article() -> dict:
    pointer = json.loads((ROOT / "active-article.json").read_text(encoding="utf-8"))
    manifest = confined(ROOT, pointer["manifest"])
    return load_manifest(manifest)


def load_article(article_id: str | None = None) -> dict:
    if article_id is None:
        return load_active_article()
    manifests = discover_articles()
    if article_id not in manifests:
        raise ValueError("Unknown article")
    return load_manifest(manifests[article_id])


def load_catalog() -> list[dict]:
    articles = [load_manifest(path) for path in discover_articles().values()]
    articles.sort(key=lambda item: (item["published"], item["readingId"]), reverse=True)
    return articles


def catalog_entry(article: dict, cover: str) -> dict:
    public_ids=json.loads((ROOT / "publication-baseline.json").read_text(encoding="utf-8"))["articles"]
    state = json.loads(article["state"]["zh"].read_text(encoding="utf-8"))
    updated_at = state.get("updatedAt")
    if not isinstance(updated_at, str):
        raise ValueError(f"Missing state updatedAt: {article['id']}")
    datetime.fromisoformat(updated_at)
    return {"id": article["id"], "readingId": article["readingId"],
             "title": article["title"]["zh"], "journal": article["journal"],
             "published": article["published"], "firstPublishedOn": article["firstPublishedOn"],
             "updatedAt": updated_at, "kind": article["kind"],
             "doi": article["doi"], "sourceUrl": article.get("sourceUrl"), "cover": cover, "public": article["id"] in public_ids,
             "reviewStatus": article.get("reviewStatus", "existing-public-baseline")}


def public_catalog() -> list[dict]:
    from media_assets import dimensions
    # Private manifests may arrive before the standard build creates their state.
    # Existing states still pass catalog_entry validation; corruption is never hidden.
    return [{**catalog_entry(article, f"/covers/{article['id']}.png"),
             "coverDisplay": f"/media/{article['id']}/cover.webp",
             "coverPreview": f"/media/{article['id']}/cover-small.webp",
             "coverWidth": dimensions(article["cover"])["width"],
             "coverHeight": dimensions(article["cover"])["height"]} for article in load_catalog() if article["state"]["zh"].is_file()]


def public_article(config: dict) -> dict:
    from media_assets import article_media
    result = {"id": config["id"], "readingId": config["readingId"],
            "displayNumber": config["displayNumber"], "title": config["title"],
            "sourceUrl": config.get("sourceUrl"),
            "journal": config["journal"], "published": config["published"],
            "kind": config["kind"], "doi": config["doi"],
            "figurePages": {f"figures/{f['file']}": f["page"] for f in config["figures"]},
            "scrollThreshold": config["scrollThreshold"],
            "figureMedia": article_media(config, f"/media/{config['id']}")}
    labels = {f"figures/{f['file']}": f["sourceLabel"] for f in config["figures"] if "sourceLabel" in f}
    if labels:
        result["figureSourceLabels"] = labels
    if "reading" in config:
        result["reading"] = config["reading"]
    return result
