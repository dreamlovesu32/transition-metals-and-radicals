import base64
import unittest
from member_service.cloud_assets import CloudAssetMixin
from member_service.service import ServiceError, AssetBody


class Fake(CloudAssetMixin):
    def __init__(self, raw):
        self.encoded=base64.b64encode(raw).decode();self.calls=0;self.changed=False
    def _call(self, op, **p):
        self.calls+=1
        if p['start'] and self.changed: raise ServiceError(409,'stale_asset')
        return {'mime':'image/png','length':len(base64.b64decode(self.encoded)),
                'encoded_size':len(self.encoded),'fingerprint':'f'*64,'version_hash':'a'*64,
                'chunk':self.encoded[p['start']:p['start']+196608]}


class AssetTests(unittest.TestCase):
    def test_bounded_stream(self):
        data=b'a'*200000;service=Fake(data);stream=service.asset_stream('u','d','a')
        self.assertIsInstance(stream,AssetBody)
        self.assertEqual(b''.join(stream),data)
        self.assertEqual(service.calls,2)
        self.assertTrue(stream.closed)
    def test_version_change_cannot_mix(self):
        service=Fake(b'a'*200000);stream=service.asset_stream('u','d','a');iterator=iter(stream)
        next(iterator);service.changed=True
        with self.assertRaises(ServiceError):next(iterator)
        self.assertTrue(stream.closed)
    def test_empty(self):
        self.assertEqual(Fake(b'').asset('u','d','a')[1],b'')
    def test_invalid_length(self):
        service=Fake(b'1')
        stream=service.asset_stream('u','d','a');stream.length=0
        with self.assertRaises(ServiceError):b''.join(stream)
