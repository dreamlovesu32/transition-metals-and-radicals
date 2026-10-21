"""Operator-only CloudBase adapter. Never route this object from HTTP handlers.

The ordinary member operation whitelist intentionally excludes these names.
Each request is one private function call; writes have no automatic retry.
"""
import base64
import hashlib
import importlib
import json
import mimetypes
import re
import sys
import uuid
from pathlib import Path

from .cloudbase_pg import CloudPGOutcomeUnknown, decode_result

TRUSTED_OPERATIONS = frozenset({
    'trusted_stage_asset', 'trusted_commit_draft', 'trusted_archive_draft', 'trusted_set_version_note', 'trusted_catalog_upsert',
    'trusted_review_snapshot', 'trusted_feedback_page', 'trusted_grant_admin',
})
PART_CHARS = 131072  # JSON plus metadata remain well below 262144 bytes.
IDENTIFIER = re.compile(r'[A-Za-z0-9_-]{1,100}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')


def trusted_sql(operation, payload):
    if operation not in TRUSTED_OPERATIONS or not isinstance(payload, dict):
        raise ValueError('unknown_trusted_operation')
    raw = json.dumps(payload, ensure_ascii=False, allow_nan=False,
                     separators=(',', ':')).encode('utf-8')
    if len(raw) > 262144 or b'\\u0000' in raw:
        raise ValueError('operation_payload_limit')
    return (f"SELECT read_member_private.{operation}("
            f"convert_from(decode('{raw.hex()}','hex'),'UTF8')::jsonb) AS result")


class TrustedCloudPG:
    def __init__(self, api_call, env_id):
        if not re.fullmatch(r'[a-zA-Z0-9-]{1,128}', env_id):
            raise ValueError('invalid_environment')
        self.api_call, self.env_id = api_call, env_id

    def call(self, operation, payload):
        sql = trusted_sql(operation, payload)
        try:
            response = self.api_call({'EnvId': self.env_id,
                                      'Role': 'service_role', 'Sql': sql})
        except Exception:
            raise CloudPGOutcomeUnknown('database_outcome_unknown') from None
        return decode_result(response)

    def _ok(self, operation, payload):
        result = self.call(operation, payload)
        if result.get('error'):
            raise ValueError(result['error'])
        return result

    def import_draft(self, draft_id, title, body, assets, version_hash,
                     expected_version='absent', batch_id=None, archive=False, digest_payload=None, note=''):
        """Stage derived raster assets, then atomically replace draft and assets.

        A retry after an unknown final result must first inspect the draft and
        asset state; this method intentionally propagates outcome-unknown.
        """
        if not IDENTIFIER.fullmatch(draft_id) or not HASH.fullmatch(version_hash):
            raise ValueError('invalid_draft')
        if expected_version != 'absent' and not HASH.fullmatch(expected_version):
            raise ValueError('invalid_expected_version')
        if not isinstance(title, str) or len(title) > 500 or not isinstance(body, str) or len(body) > 200000:
            raise ValueError('invalid_draft_text')
        if not isinstance(assets, dict) or len(assets) > 100:
            raise ValueError('invalid_assets')
        batch = batch_id or uuid.uuid4().hex
        if not re.fullmatch(r'[a-f0-9]{32}', batch):
            raise ValueError('invalid_batch')
        manifest = []
        for asset_id, (mime, payload) in assets.items():
            if not IDENTIFIER.fullmatch(asset_id) or mime not in ('image/png','image/jpeg','image/webp'):
                raise ValueError('invalid_asset')
            if not isinstance(payload, bytes) or len(payload) > 20 * 1024 * 1024:
                raise ValueError('invalid_asset')
            encoded = base64.b64encode(payload).decode('ascii')
            parts = [encoded[i:i+PART_CHARS] for i in range(0, len(encoded), PART_CHARS)]
            if not parts:  # Empty image is not useful and has no stage row.
                raise ValueError('empty_asset')
            for part, chunk in enumerate(parts):
                self._ok('trusted_stage_asset', {'batch_id':batch,'draft_id':draft_id,
                    'asset_id':asset_id,'part':part,'mime':mime,'chunk':chunk})
            manifest.append({'id':asset_id,'mime':mime,'sha256':hashlib.sha256(payload).hexdigest(),
                             'parts':len(parts)})
        return self._ok('trusted_archive_draft' if archive else 'trusted_commit_draft', {'digest_payload':digest_payload,'note':note,'batch_id':batch,'draft_id':draft_id,
            'title':title,'body':body,'version_hash':version_hash,
            'expected_version':expected_version,'assets':manifest})

    def update_explicit_public_catalog(self, article_id, version_hash,
                                       review_version_hash, explicit_public_ids):
        if article_id not in explicit_public_ids:
            raise ValueError('article_not_in_explicit_public_list')
        return self._ok('trusted_catalog_upsert', {'article_id':article_id,
            'explicit_public_id':article_id,'version_hash':version_hash,
            'review_version_hash':review_version_hash})

    def review_snapshot(self, article_id):
        if not IDENTIFIER.fullmatch(article_id):
            raise ValueError('invalid_article_id')
        return self._ok('trusted_review_snapshot', {'article_id':article_id})

    def feedback_page(self, after='', after_id=''):
        return self._ok('trusted_feedback_page', {'after':after,'after_id':after_id})


def verify_and_grant_admin(pg, auth, session, email):
    """Operator call only: fresh hosted /user/me evidence plus DB session guard.

    `session` is a persisted private session row fetched by the operator; no
    browser-provided UID, email_verified flag, or token is trusted here.
    """
    email = email.strip().lower()
    if not email or session.get('email', '').strip().lower() != email:
        raise ValueError('explicit_email_mismatch')
    tokens = auth._tokens(session)
    access = tokens.get('access_token')
    if not access:
        raise ValueError('live_access_required')
    user = auth._upstream('/auth/v1/user/me', token=access)
    uid = session.get('uid')
    from .cloudbase_shared_auth import operator_admin_attested
    attested=operator_admin_attested(user,getattr(auth,'admin_binding',None),
                                       getattr(auth,'admin_status_lookup',None))
    if (not isinstance(user, dict) or not uid or user.get('sub') != uid
            or str(user.get('email','')).strip().lower() != email
            or not ((user.get('email_verified') is True and user.get('status') == 'ACTIVE') or attested)):
        raise ValueError('verified_active_identity_required')
    return pg._ok('trusted_grant_admin', {'uid':uid,'email':email})


def prepare_derived_workbench(workbench, article_ids, explicit_public_ids=(), state_overrides=None):
    """Read and validate every derived article before any cloud write."""
    workbench = Path(workbench).resolve(strict=True)
    listed = set(explicit_public_ids)
    if not listed.issubset(set(article_ids)):
        raise ValueError('public_id_not_in_import')
    baseline = json.loads((workbench/'publication-baseline.json').read_text(encoding='utf-8'))['articles']
    if not listed.issubset(baseline):
        raise ValueError('public_id_not_in_existing_baseline')
    sys.path.insert(0, str(workbench))
    try:
        config = importlib.import_module('article_config')
        exporter = importlib.import_module('export_github_pages')
        if (Path(config.__file__).resolve().parent != workbench or
                Path(exporter.__file__).resolve().parent != workbench):
            raise ValueError('workbench_import_mismatch')
        bundles = []
        for aid in article_ids:
            if not IDENTIFIER.fullmatch(aid):
                raise ValueError('invalid_article_id')
            article = config.load_article(aid)
            state_path=(state_overrides or {}).get(aid,article['state']['zh'])
            state = json.loads(Path(state_path).read_text(encoding='utf-8'))
            blocks = exporter.public_blocks(state, article, require_approval=False)
            public_hash = hashlib.sha256(json.dumps(blocks, ensure_ascii=False,
                sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
            review_hash = exporter.publication_digest(article, blocks)
            if aid in listed and (baseline[aid]['sourceBundleSha256'] != review_hash or
                                  baseline[aid]['publicBlocksSha256'] != public_hash):
                raise ValueError('public_version_not_in_existing_baseline')
            assets, mapping = {}, {}
            paths = [('cover',article['cover'])] + [
                (f'figure-{n}',article['figuresDir']/figure['file'])
                for n,figure in enumerate(article['figures'],1)]
            for asset_id, path in paths:
                path = path.resolve(strict=True)
                if (not path.is_relative_to(workbench) or
                        path.suffix.lower() not in ('.png','.jpg','.jpeg','.webp')):
                    raise ValueError('derived_raster_only')
                if path.stat().st_size > 20*1024*1024:
                    raise ValueError('asset_too_large')
                mime = mimetypes.guess_type(path.name)[0]
                assets[asset_id] = (mime,path.read_bytes())
                mapping['cover' if asset_id=='cover' else 'figures/'+path.name] = asset_id
            public_meta = {**config.public_article(article), 'firstPublishedOn':article.get('firstPublishedOn',''),
                'updatedAt':state.get('updatedAt',''), 'reviewStatus':article.get('reviewStatus','pending')}
            body = json.dumps({'article':public_meta,'blocks':blocks,
                'asset_map':mapping,'version_hash':public_hash,
                'review_baseline':({'version_hash':review_hash,'status':baseline[aid]['status']}
                    if aid in listed else None)},ensure_ascii=False)
            metadata={key:article[key] for key in ('id','readingId','displayNumber','title','doi','sourceUrl','journal','published','firstPublishedOn','kind','scrollThreshold')}
            metadata['reviewStatus']=article.get('reviewStatus','existing-public-baseline')
            metadata['figures']=article['figures']
            if 'reading' in article:
                metadata['reading']=article['reading']
            digest_payload=json.dumps({'metadata':metadata,'blocks':blocks},ensure_ascii=False,sort_keys=True,separators=(',',':'))
            bundles.append({'digest_payload':digest_payload,'id':aid,'title':article['title']['zh'],'body':body,
                'assets':assets,'review_version_hash':review_hash,
                'version_hash':public_hash,'catalog_updated':aid in listed})
        return bundles
    finally:
        sys.path.pop(0)


def import_derived_workbench(pg, workbench, article_ids, explicit_public_ids=()):
    """Explicit operator import of derived guides; never reads PDF or SI."""
    bundles = prepare_derived_workbench(workbench,article_ids,explicit_public_ids)
    listed = set(explicit_public_ids)
    results=[]
    for bundle in bundles:
        aid=bundle['id']
        try:
            prior = pg.review_snapshot(aid)['version_hash']
        except ValueError as exc:
            if str(exc) != 'draft_not_found':
                raise
            prior = 'absent'
        pg.import_draft(aid,bundle['title'],bundle['body'],bundle['assets'],
                        bundle['review_version_hash'],expected_version=prior)
        if aid in listed:
            pg.update_explicit_public_catalog(aid,bundle['version_hash'],
                                              bundle['review_version_hash'],listed)
        results.append({'id':aid,'review_version_hash':bundle['review_version_hash'],
                        'version_hash':bundle['version_hash'],
                        'catalog_updated':aid in listed})
    return results
