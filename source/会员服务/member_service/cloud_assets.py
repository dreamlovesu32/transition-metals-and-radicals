"""Bounded private image chunks pinned to content, version and admin identity."""
import base64
from .service import AssetBody, ServiceError, bounded, identifier


class CloudAssetBody(AssetBody):
    def __init__(self, service, uid, did, aid, first, operation='draft_asset_chunk'):
        self.operation = operation
        self.service, self.uid, self.did, self.aid = service, uid, did, aid
        self.first = first
        self.mime, self.length = first['mime'], first['length']
        if self.mime not in ('image/png','image/jpeg','image/webp'):
            raise ServiceError(503,'invalid_asset')
        if type(self.length) is not int or not 0 <= self.length <= 20*1024*1024:
            raise ServiceError(503,'invalid_asset')
        self.closed = False

    def __iter__(self):
        row = self.first
        start = 0
        total = 0
        try:
            while not self.closed:
                chunk = row['chunk']
                if not chunk: break
                decoded = base64.b64decode(chunk,validate=True)
                total += len(decoded)
                if total > self.length: raise ServiceError(503,'invalid_asset')
                yield decoded
                start += len(chunk)
                if start == self.first['encoded_size']: break
                if len(chunk) != 196608: raise ServiceError(503,'invalid_asset')
                row = self.service._call(self.operation, uid=self.uid,
                    draft_id=self.did, asset_id=self.aid, start=start,
                    fingerprint=self.first['fingerprint'],
                    version_hash=self.first['version_hash'])
            if not self.closed and total != self.length:
                raise ServiceError(503,'invalid_asset')
        finally: self.close()

    def close(self):
        self.closed = True
        self.first = None


class CloudAssetMixin:
    def asset_stream(self, uid, did, asset_id):
        bounded(uid,256); identifier(did); identifier(asset_id)
        first = self._call('draft_asset_chunk',uid=uid,draft_id=did,asset_id=asset_id,start=0)
        return CloudAssetBody(self,uid,did,asset_id,first)

    def version_asset_stream(self, uid, did, vh, asset_id):
        from .service import version
        bounded(uid,256); identifier(did); identifier(asset_id); version(vh)
        first=self._call('version_asset_chunk',uid=uid,draft_id=did,asset_id=asset_id,version_hash=vh,start=0)
        return CloudAssetBody(self,uid,did,asset_id,first,'version_asset_chunk')

    def asset(self, uid, did, asset_id):
        stream=self.asset_stream(uid,did,asset_id)
        return stream.mime,b''.join(stream)
