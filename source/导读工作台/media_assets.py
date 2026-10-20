"""Small derived previews; source PNGs and scientific content stay byte-identical."""
from __future__ import annotations

import hashlib
from pathlib import Path
from PIL import Image, ImageOps

CACHE = Path(__file__).resolve().parent.parent / "tmp" / "media-previews"


def preview(source: Path, width: int) -> Path:
    signature = f"{source.resolve()}:{source.stat().st_mtime_ns}:{source.stat().st_size}:{width}:v1"
    target = CACHE / (hashlib.sha256(signature.encode()).hexdigest() + ".webp")
    if not target.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((width, width * 3), Image.Resampling.LANCZOS)
            image.save(target, "WEBP", quality=72, method=6)
    return target


def dimensions(source: Path) -> dict:
    with Image.open(source) as image:
        return {"width": image.width, "height": image.height}


def article_media(article: dict, prefix: str) -> dict:
    return {f"figures/{figure['file']}": {
        **dimensions(article["figuresDir"] / figure["file"]),
        "preview": f"{prefix}/{Path(figure['file']).stem}.webp",
    } for figure in article["figures"]}


def export_media(stage: Path, article: dict) -> dict:
    import shutil
    folder = stage / "media" / article["id"]
    folder.mkdir(parents=True, exist_ok=True)
    for name, width in (("cover-small.webp", 96), ("cover.webp", 640)):
        shutil.copyfile(preview(article["cover"], width), folder / name)
    for figure in article["figures"]:
        shutil.copyfile(preview(article["figuresDir"] / figure["file"], 320), folder / (Path(figure["file"]).stem + ".webp"))
    return article_media(article, f"./media/{article['id']}")
