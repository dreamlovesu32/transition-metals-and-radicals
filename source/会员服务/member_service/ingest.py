"""Explicit local ingestion of derived guides only; never uploads source PDF/SI.
Reads the existing, validated manifest and exporter sanitizer without changing it.
"""
import hashlib
import json
import mimetypes
import sys
from pathlib import Path

def import_workbench(service,workbench,article_ids,public_ids):
    workbench=Path(workbench).resolve()
    sys.path.insert(0,str(workbench))
    try:
        from article_config import load_article, public_article
        from export_github_pages import public_blocks,publication_digest
        output=[]
        for aid in article_ids:
            article=load_article(aid)
            state=json.loads(article['state']['zh'].read_text(encoding='utf-8'))
            blocks=public_blocks(state,article,require_approval=False)
            public_hash=hashlib.sha256(json.dumps(blocks,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            bundle_hash=publication_digest(article,blocks)
            assets={};mapping={}
            paths=[('cover',article['cover'])]+[(f'figure-{n}',article['figuresDir']/f['file']) for n,f in enumerate(article['figures'],1)]
            for asset_id,path in paths:
                path=path.resolve()
                if not path.is_relative_to(workbench):raise ValueError('Asset outside derived workbench')
                if path.suffix.lower() not in ('.png','.jpg','.jpeg','.webp'):raise ValueError('Only derived raster figures are allowed')
                if path.stat().st_size>20*1024*1024:raise ValueError('Asset too large')
                assets[asset_id]=(mimetypes.guess_type(path.name)[0],path.read_bytes())
                mapping['cover' if asset_id=='cover' else 'figures/'+path.name]=asset_id
            body=json.dumps({'article':public_article(article),'blocks':blocks,'asset_map':mapping,'version_hash':public_hash},ensure_ascii=False)
            service.import_draft(aid,article['title']['zh'],body,assets,approval_hash=bundle_hash)
            with service.store.transaction() as tx:
                tx.execute('INSERT INTO articles VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version_hash=excluded.version_hash,published=excluded.published',(aid,public_hash,int(aid in public_ids)))
            output.append({'id':aid,'version_hash':public_hash,'review_version_hash':bundle_hash,'published':aid in public_ids})
        return output
    finally:sys.path.pop(0)
