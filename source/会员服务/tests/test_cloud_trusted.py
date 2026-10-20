import base64
import hashlib
import json
import unittest

from member_service.cloud_trusted import TrustedCloudPG, trusted_sql, verify_and_grant_admin
from member_service.cloudbase_pg import CloudPGOutcomeUnknown, operation_sql


class TrustedAdapterTests(unittest.TestCase):
    def test_separate_operator_whitelist_and_payload_bound(self):
        with self.assertRaises(ValueError):
            operation_sql('trusted_commit_draft', {})
        with self.assertRaises(ValueError):
            trusted_sql('arbitrary_sql', {})
        with self.assertRaises(ValueError):
            trusted_sql('trusted_stage_asset', {'chunk':'x'*262145})

    def test_large_asset_is_chunked_and_committed_once(self):
        calls=[]
        def api(req):
            sql=req['Sql']
            raw=bytes.fromhex(sql.split("decode('")[1].split("','hex'")[0])
            calls.append((sql.split('read_member_private.')[1].split('(')[0], json.loads(raw)))
            return {'Columns':['result'],'Rows':[json.dumps([json.dumps({'ok':True})])]}
        pg=TrustedCloudPG(api,'test-env')
        data=b'a'*(3*1024*1024+1)
        pg.import_draft('R-1','Title','Body',{'cover':('image/png',data)},'f'*64)
        stage=[p for op,p in calls if op=='trusted_stage_asset']
        commit=[p for op,p in calls if op=='trusted_commit_draft']
        self.assertEqual(len(commit),1)
        self.assertGreater(len(stage),20)
        self.assertTrue(all(len(json.dumps(p).encode())<=262144 for p in stage))
        self.assertEqual(base64.b64decode(''.join(p['chunk'] for p in stage)),data)
        self.assertEqual(commit[0]['assets'][0]['sha256'],hashlib.sha256(data).hexdigest())

    def test_unknown_result_is_not_retried(self):
        calls=[]
        def api(req):
            calls.append(req)
            raise OSError('unknown')
        with self.assertRaises(CloudPGOutcomeUnknown):
            TrustedCloudPG(api,'test-env').import_draft('R-1','T','B',{},'f'*64)
        self.assertEqual(len(calls),1)

    def test_public_catalog_requires_explicit_id(self):
        pg=TrustedCloudPG(lambda _:None,'test-env')
        with self.assertRaises(ValueError):
            pg.update_explicit_public_catalog('new','f'*64,'e'*64,{'old'})

    def test_grant_requires_live_verified_active_identity(self):
        class Auth:
            def _tokens(self, row): return {'access_token':'opaque'}
            def _upstream(self, path, token): return {'sub':'uid1','email':'me@example.org',
                                                     'email_verified':True,'status':'ACTIVE'}
        class PG:
            def _ok(self, name, payload): return (name,payload)
        name,payload=verify_and_grant_admin(PG(),Auth(),{'uid':'uid1','email':'me@example.org'},'me@example.org')
        self.assertEqual(name,'trusted_grant_admin')
        self.assertEqual(payload['uid'],'uid1')
        class Bad(Auth):
            def _upstream(self, path, token): return {'sub':'uid1','email':'me@example.org',
                                                     'email_verified':False,'status':'ACTIVE'}
        with self.assertRaises(ValueError):
            verify_and_grant_admin(PG(),Bad(),{'uid':'uid1','email':'me@example.org'},'me@example.org')


if __name__=='__main__': unittest.main()
