"""Member business API over one atomic CloudBase PostgreSQL call per action.

Identity is supplied by the trusted HTTP/auth boundary, never by a browser
selected UID. Database functions enforce article visibility and admin status.
"""
import hashlib
import json

from .service import ServiceError, bounded, identifier, version
from .cloud_assets import CloudAssetMixin


class CloudMemberService(CloudAssetMixin):
    def __init__(self, operations):
        self.operations = operations

    def _call(self, name, **payload):
        result = self.operations.call(name, payload)
        if 'error' in result:
            code = result['error']
            status = {
                'historical_version_read_only': 403, 'invalid_publication': 409, 'admin_required': 403, 'article_not_found': 404,
                'note_not_found': 404, 'note_deleted': 409,
                'draft_not_found': 404, 'version_mismatch': 409,
                'stale_review': 409, 'stale_feedback': 409,
                'progress_conflict': 409, 'idempotency_conflict': 409,
                'asset_not_found': 404, 'stale_asset': 409, 'invalid_asset_offset': 400,
            }.get(code)
            if status is None:
                raise RuntimeError('unexpected_database_error')
            raise ServiceError(status, code)
        return result

    def me(self, uid):
        return self._call('member_me', uid=bounded(uid, 256))

    def favorites(self, uid):
        return self._call('favorites_list', uid=bounded(uid, 256))['items']

    def favorite(self, uid, article_id, enabled):
        if type(enabled) is not bool:
            raise ServiceError(400, 'invalid_input')
        return self._call('favorite_set', uid=bounded(uid, 256),
                          article_id=identifier(article_id), enabled=enabled)

    def notes(self, uid, article_id=None):
        return self._call('notes_list', uid=bounded(uid, 256),
                          article_id=identifier(article_id) if article_id is not None else None)['items']

    def add_note(self, uid, data):
        uid = bounded(uid, 256)
        aid = identifier(data.get('article_id'))
        vh = version(data.get('version_hash'))
        anchor = bounded(data.get('anchor'), 500)
        quote = bounded(data.get('quote', ''), 2000, True)
        note_text = bounded(data.get('text', ''), 10000, True)
        if not note_text.strip() and not quote.strip():
            raise ServiceError(400, 'empty_note')
        client_id = identifier(data['client_id']) if data.get('client_id') is not None else None
        request_hash = hashlib.sha256(json.dumps(
            [aid, vh, anchor, quote, note_text], ensure_ascii=False,
            separators=(',', ':')).encode()).hexdigest()
        return self._call('note_add', uid=uid, article_id=aid, version_hash=vh,
                          anchor=anchor, quote=quote, text=note_text,
                          client_id=client_id, request_hash=request_hash)

    def delete_note(self, uid, nid):
        return self._call('note_delete', uid=bounded(uid, 256), note_id=identifier(nid))

    def get_progress(self, uid, aid):
        return self._call('progress_get', uid=bounded(uid, 256), article_id=identifier(aid))

    def put_progress(self, uid, aid, data):
        vh = version(data.get('version_hash'))
        expected = data.get('revision')
        if type(expected) is not int or expected < 0:
            raise ServiceError(400, 'invalid_revision')
        position = data.get('position')
        if not isinstance(position, dict):
            raise ServiceError(400, 'invalid_position')
        try:
            encoded = json.dumps(position, ensure_ascii=False, allow_nan=False,
                                 separators=(',', ':'))
        except (TypeError, ValueError):
            raise ServiceError(400, 'invalid_position') from None
        if len(encoded) > 4000:
            raise ServiceError(400, 'invalid_position')
        return self._call('progress_set', uid=bounded(uid, 256),
                          article_id=identifier(aid), version_hash=vh,
                          revision=expected, position=position, encoded_position=encoded)

    def drafts(self, uid):
        return self._call('drafts_list', uid=bounded(uid, 256))['items']

    def draft_versions(self, uid, did):
        return self._call('draft_versions',uid=bounded(uid,256),draft_id=identifier(did))

    def draft_version(self, uid, did, vh):
        return self._call('draft_version_get',uid=bounded(uid,256),draft_id=identifier(did),version_hash=version(vh))

    def draft(self, uid, did):
        return self._call('draft_get', uid=bounded(uid, 256), draft_id=identifier(did))

    def export_plan(self, uid, did, source, vh, plan=None):
        payload={'uid':bounded(uid,256),'draft_id':identifier(did),'source':source,'version_hash':version(vh)}
        if plan is not None:payload['plan']=plan
        return self._call('export_plan',**payload)

    def review(self, uid, did, data):
        vh = version(data.get('version_hash'))
        decision = data.get('decision')
        comment = bounded(data.get('comment', ''), 10000, True)
        if decision not in ('approved', 'changes_requested'):
            raise ServiceError(400, 'invalid_decision')
        return self._call('review_add', uid=bounded(uid, 256), draft_id=identifier(did),
                          version_hash=vh, decision=decision, comment=comment)

    def feedback(self, uid, did, data):
        vh = version(data.get('version_hash'))
        target = data.get('target', {})
        if not isinstance(target, dict) or target.get('type') not in ('article', 'paragraph', 'figure'):
            raise ServiceError(400, 'invalid_target')
        target_id = bounded(target.get('id', did), 500)
        comment = bounded(data.get('comment'), 10000)
        quote = bounded(data.get('quote', ''), 2000, True)
        return self._call('feedback_add', uid=bounded(uid, 256), draft_id=identifier(did),
                          version_hash=vh, target_type=target['type'], target_id=target_id,
                          target=target, comment=comment, quote=quote)

    def events(self, uid, after='', after_id=''):
        return self._call('feedback_list', uid=bounded(uid, 256),
                          after=bounded(after, 100, True),
                          after_id=bounded(after_id, 100, True))

    def publish(self, uid, did, data):
        return self._call('draft_publish', uid=bounded(uid,256), draft_id=identifier(did),
                          version_hash=version(data.get('version_hash')))

    def public_articles(self):
        return self._call('public_articles')

    def public_article(self, aid):
        return self._call('public_article', article_id=identifier(aid))

    def public_asset(self, did, aid, vh):
        from .cloud_assets import CloudAssetBody
        identifier(did); identifier(aid); version(vh)
        first=self._call('public_asset_chunk',draft_id=did,asset_id=aid,version_hash=vh,start=0)
        return CloudAssetBody(self,None,did,aid,first,'public_asset_chunk')
