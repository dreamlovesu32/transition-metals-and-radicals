"""Admin-only editorial plans over immutable article blocks; no source files."""
import json
from .service import ServiceError


def snapshot(service, uid, did, source):
    # draft() performs the database administrator check, including published exports.
    draft = service.draft(uid, did)
    if source == 'draft':
        body = json.loads(draft['body'])
        revision = draft['version_hash']
    elif source == 'published':
        body = service.public_article(did)
        revision = body['review_version_hash']
    else:
        raise ServiceError(400, 'invalid_export_source')
    return {'article': body['article'], 'blocks': body['blocks'], 'content_hash':body.get('version_hash'),
            'asset_map': body['asset_map'], 'version_hash': revision,
            'title': body.get('title') or body['article'].get('title',{}).get('zh') or (draft['title'] if source=='draft' else ''), 'source': source}


def validate_plan(body, data):
    if data.get('version_hash') != body['version_hash']:
        raise ServiceError(409, 'version_mismatch')
    sections = [b['id'] for b in body['blocks'] if b['kind'] == 'heading']
    starts = data.get('starts', [])
    if not isinstance(starts, list) or len(starts) > 60 or any(not isinstance(s, str) or s not in sections for s in starts):
        raise ServiceError(400, 'invalid_export_plan')
    if len(set(starts)) != len(starts) or starts != sorted(starts, key=sections.index):
        raise ServiceError(400, 'invalid_export_plan')
    title = data.get('title', body['title'])
    if not isinstance(title, str) or not title.strip() or len(title) > 300:
        raise ServiceError(400, 'invalid_export_plan')
    return {'version_hash': body['version_hash'], 'starts': starts, 'title': title.strip()}
