import hashlib
import json
import threading
import time
import unittest
from cryptography.fernet import Fernet

from member_service.cloudbase_pg import CloudPGOutcomeUnknown
from member_service.cloudbase_shared_auth import CloudBaseSharedAuth
from member_service.service import ServiceError


class FakeOperations:
    def __init__(self):
        self.rows = {}
        self.calls = []
        self.lock = threading.Lock()
        self.unknown_commit = False
        self.late_commit = False

    def call(self, name, p):
        with self.lock:
            self.calls.append(name)
            key = p.get('id_hash')
            row = self.rows.get(key)
            if name == 'session_create':
                self.rows[key] = dict(p, revoked=0, refresh_state='ready')
                return {'ok':True}
            if name == 'session_get':
                return dict(row) if row and not row['revoked'] else {}
            if name == 'session_revoke':
                row['revoked'] = 1
                return {'ok':True}
            if name == 'refresh_claim':
                if not row or row['revoked']:
                    return {'status':'expired'}
                if row['refresh_state'] == 'pending':
                    return {'status':'busy'}
                if row['token_cipher'] != p['token_cipher']:
                    return {'status':'updated','row':dict(row)}
                row['refresh_state'] = 'pending'
                row['refresh_owner'] = p['owner']
                row['refresh_started_at'] = int(time.time()) - (46 if self.late_commit else 0)
                return {'status':'claimed','row':dict(row)}
            if name == 'refresh_commit':
                if row['refresh_started_at'] <= int(time.time())-45 or row['expires_at'] <= int(time.time()):
                    return {'ok':False}
                if row['refresh_state'] != 'pending' or row['refresh_owner'] != p['owner']:
                    return {'ok':False}
                row['token_cipher'] = p['token_cipher']
                row['refresh_state'] = 'ready'
                row['refresh_owner'] = None
                if self.unknown_commit:
                    raise CloudPGOutcomeUnknown('unknown')
                return {'ok':True}
            if name == 'refresh_abort':
                if row['refresh_state'] == 'pending' and row['refresh_owner'] == p['owner']:
                    row['revoked'] = 1
                return {'ok':True}
            raise AssertionError(name)


class SharedAuthTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeOperations()
        class Auth(CloudBaseSharedAuth):
            def _upstream(inner, path, body=None, token=None, captcha_token=None):
                if path == '/auth/v1/token':
                    inner.refreshes += 1
                    if inner.fail_refresh:
                        raise ServiceError(503, 'auth_unavailable')
                    return {'access_token':'new-access','refresh_token':'new-refresh','expires_in':3600}
                if path == '/auth/v1/user/me':
                    return {'sub':'user','email':'u@example.org','status':'ACTIVE','email_verified':True}
                raise AssertionError(path)
        self.auth = Auth(self.store, 'https://example.invalid', Fernet.generate_key(), 'test')
        self.auth.refreshes = 0
        self.auth.fail_refresh = False
        self.e = {}
        self.auth._create(self.e, {'access_token':'old-access','refresh_token':'old-refresh',
                                   '_expires_at':0,'_auth_time':123,'_uid':'user'}, True)
        self.cookie = self.e['member.set_cookies'][0].split(';')[0]
        self.env = {'HTTP_COOKIE':self.cookie}

    def test_refresh_claim_and_commit_once(self):
        identity = self.auth.authenticate(dict(self.env))
        self.assertEqual('user', identity.uid)
        self.assertEqual(1, self.auth.refreshes)
        self.auth.authenticate(dict(self.env))
        self.assertEqual(1, self.auth.refreshes)
        self.assertEqual('ready', next(iter(self.store.rows.values()))['refresh_state'])

    def test_failed_refresh_revokes_old_token(self):
        self.auth.fail_refresh = True
        with self.assertRaises(ServiceError):
            self.auth.authenticate(dict(self.env))
        self.assertEqual(1, next(iter(self.store.rows.values()))['revoked'])
        self.assertIsNone(self.auth.authenticate(dict(self.env)))
        self.assertEqual(1, self.auth.refreshes)

    def test_unknown_commit_does_not_repeat_refresh(self):
        self.store.unknown_commit = True
        with self.assertRaises(ServiceError):
            self.auth.authenticate(dict(self.env))
        self.assertEqual(1, self.auth.refreshes)
        self.auth.authenticate(dict(self.env))
        self.assertEqual(1, self.auth.refreshes)

    def test_pending_claim_rejects_without_upstream(self):
        row = next(iter(self.store.rows.values()))
        row['refresh_state'] = 'pending'
        with self.assertRaises(ServiceError) as got:
            self.auth.authenticate(dict(self.env))
        self.assertEqual(503, got.exception.status)
        self.assertEqual(0, self.auth.refreshes)

    def test_late_commit_fails_closed_and_revokes(self):
        self.store.late_commit = True
        with self.assertRaises(ServiceError) as got:
            self.auth.authenticate(dict(self.env))
        self.assertEqual(503, got.exception.status)
        self.assertEqual(1, next(iter(self.store.rows.values()))['revoked'])
        self.assertEqual(1, self.auth.refreshes)

    def test_upstream_identity_drift_is_rejected(self):
        row = next(iter(self.store.rows.values()))
        row['uid'] = 'another-user'
        with self.assertRaises(ServiceError) as got:
            self.auth.authenticate(dict(self.env))
        self.assertEqual(401, got.exception.status)

    def test_expired_session_never_reaches_upstream(self):
        next(iter(self.store.rows.values()))['expires_at'] = 0
        self.assertIsNone(self.auth.authenticate(dict(self.env)))
        self.assertEqual(0, self.auth.refreshes)


if __name__ == '__main__':
    unittest.main()
