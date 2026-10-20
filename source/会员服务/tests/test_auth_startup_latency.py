import threading
import time
import unittest
from unittest.mock import Mock
from member_service.cloudbase_shared_auth import CloudBaseSharedAuth
from member_service.service import ServiceError


class AuthStartupTests(unittest.TestCase):
    def setUp(self):
        self.auth = object.__new__(CloudBaseSharedAuth)
        self.auth.admin_binding = {'uid': 'admin', 'email': 'a@example.org'}
        self.auth._row = Mock(return_value={'uid': 'admin', 'email': 'a@example.org', 'csrf': 'csrf'})
        self.auth._tokens = Mock(return_value={'access_token': 'test-only', '_expires_at': time.time()+3600})
        self.user = {'sub': 'admin', 'email': 'a@example.org'}
        self.auth._upstream = Mock(side_effect=lambda *a, **k: dict(self.user))
        self.response = {'Data': {'Total': 1, 'UserList': [{'Uid': 'admin', 'Email': 'a@example.org', 'UserStatus': 'ACTIVE'}]}}
        self.auth.admin_status_lookup = Mock(side_effect=lambda *a: self.response)

    def test_independent_live_checks_overlap_without_cached_identity(self):
        barrier = threading.Barrier(2, timeout=2)
        def provider(*args, **kwargs):
            barrier.wait()
            return dict(self.user)
        def operator(*args):
            barrier.wait()
            return self.response
        self.auth._upstream.side_effect = provider
        self.auth.admin_status_lookup.side_effect = operator
        for path in ('/api/member/session', '/api/member/admin/drafts'):
            identity = self.auth.authenticate({'PATH_INFO': path})
            self.assertTrue(identity.operator_admin_attested)
        self.assertEqual(2, self.auth._upstream.call_count)
        self.assertEqual(2, self.auth.admin_status_lookup.call_count)

    def test_ordinary_personal_data_routes_do_not_need_admin_lookup(self):
        for path in ('/api/member/favorites', '/api/member/notes', '/api/member/progress/article'):
            identity = self.auth.authenticate({'PATH_INFO': path})
            self.assertEqual('admin', identity.uid)
            self.assertFalse(identity.operator_admin_attested)
        self.auth.admin_status_lookup.assert_not_called()
        self.assertEqual(3, self.auth._upstream.call_count)

    def test_live_denial_and_uid_mismatch_still_fail(self):
        for patch in ({'status': 'DISABLED'}, {'sub': 'other'}):
            self.user.update(patch)
            with self.assertRaises(ServiceError):
                self.auth.authenticate({'PATH_INFO': '/api/member/session'})
            self.user = {'sub': 'admin', 'email': 'a@example.org'}

    def test_changed_email_and_explicit_unverified_cannot_attest(self):
        for patch in ({'email': 'other@example.org'}, {'email_verified': False}):
            self.user.update(patch)
            identity = self.auth.authenticate({'PATH_INFO': '/api/member/session'})
            self.assertFalse(identity.operator_admin_attested)
            self.user = {'sub': 'admin', 'email': 'a@example.org'}

    def test_operator_failure_is_sanitized_and_not_cached(self):
        self.auth.admin_status_lookup.side_effect = RuntimeError('private secret')
        with self.assertRaises(ServiceError) as caught:
            self.auth.authenticate({'PATH_INFO': '/api/member/session'})
        self.assertEqual('admin_identity_unavailable', caught.exception.code)
        self.auth.admin_status_lookup.side_effect = lambda *a: self.response
        self.assertTrue(self.auth.authenticate({'PATH_INFO': '/api/member/session'}).operator_admin_attested)
        self.response['Data']['UserList'][0]['UserStatus'] = 'DISABLED'
        self.assertFalse(self.auth.authenticate({'PATH_INFO': '/api/member/session'}).operator_admin_attested)

    def test_unmatched_persisted_email_still_validates_live_identity(self):
        self.auth._row.return_value['email'] = 'old@example.org'
        identity = self.auth.authenticate({'PATH_INFO': '/api/member/session'})
        self.assertTrue(identity.operator_admin_attested)
        self.auth.admin_status_lookup.assert_called_once()
