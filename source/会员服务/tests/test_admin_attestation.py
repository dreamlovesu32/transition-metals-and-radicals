import unittest
from unittest.mock import Mock,patch
from member_service.cloudbase_shared_auth import operator_admin_attested
from member_service.runtime import _admin_binding
from member_service.service import ServiceError
from member_service.http import Identity,MemberApp

class AdminAttestationTests(unittest.TestCase):
    def setUp(self):
        self.binding={'uid':'fixed-uid','email':'fixed@example.org'}
        self.user={'sub':'fixed-uid','email':'fixed@example.org'}
        self.lookup=Mock(return_value={'RequestId':'synthetic-request','Data':{'Total':1,'UserList':[{'Uid':'fixed-uid','Email':'fixed@example.org','UserStatus':'ACTIVE'}]}})
    def test_missing_provider_claims_uses_independent_control_plane(self):
        self.assertTrue(operator_admin_attested(self.user,self.binding,self.lookup))
        self.lookup.assert_called_once_with('fixed-uid','fixed@example.org')
        self.assertNotIn('email_verified',self.user)
    def test_ordinary_user_does_not_call_control_plane(self):
        self.user['sub']='ordinary'
        self.assertFalse(operator_admin_attested(self.user,self.binding,self.lookup))
        self.lookup.assert_not_called()
    def test_explicit_denial_cannot_be_overridden(self):
        for extra in ({'email_verified':False},{'status':'DISABLED'},{'status':''}):
            self.assertFalse(operator_admin_attested(dict(self.user,**extra),self.binding,self.lookup))
        self.lookup.assert_not_called()
    def test_disabled_duplicate_wrong_uid_or_changed_email_rejected(self):
        for rows in ([],[{}],[{'Uid':'wrong','Email':'fixed@example.org','UserStatus':'ACTIVE'}],[{'Uid':'fixed-uid','Email':'other@example.org','UserStatus':'ACTIVE'}],[{'Uid':'fixed-uid','Email':'fixed@example.org','UserStatus':'DISABLED'}],[{},{}]):
            self.lookup.return_value={'UserList':rows}
            self.assertFalse(operator_admin_attested(self.user,self.binding,self.lookup))
    def test_control_plane_failure_is_closed_and_private_error_hidden(self):
        self.lookup.side_effect=RuntimeError('private-token')
        with self.assertRaises(ServiceError) as error:operator_admin_attested(self.user,self.binding,self.lookup)
        self.assertEqual('admin_identity_unavailable',error.exception.code)
    def test_each_request_rechecks_status(self):
        self.assertTrue(operator_admin_attested(self.user,self.binding,self.lookup))
        self.lookup.return_value['Data']['UserList'][0]['UserStatus']='DISABLED'
        self.assertFalse(operator_admin_attested(self.user,self.binding,self.lookup))
        self.assertEqual(2,self.lookup.call_count)
    def test_private_binding_validation(self):
        import json
        with patch.dict('os.environ',{'READ_MEMBER_ADMIN_BINDING':json.dumps(self.binding)}):
            self.assertEqual(self.binding,_admin_binding())
        with patch.dict('os.environ',{'READ_MEMBER_ADMIN_BINDING':'{}'}):
            with self.assertRaises(ValueError):_admin_binding()
    def test_session_role_still_requires_database_admin(self):
        auth=Mock(configured=True)
        auth.authenticate.return_value=Identity('fixed-uid','fixed@example.org','csrf',False,False,True)
        service=Mock();service.me.return_value={'admin':False}
        app=MemberApp(service,auth)
        _,result,_=app.dispatch({'PATH_INFO':'/api/member/session'})
        self.assertEqual('member',result['user']['role'])
        service.me.return_value={'admin':True}
        _,result,_=app.dispatch({'PATH_INFO':'/api/member/session'})
        self.assertEqual('admin',result['user']['role'])

    def test_operator_grant_fallback_requires_same_private_binding(self):
        from member_service.cloud_trusted import verify_and_grant_admin
        auth=Mock()
        auth.admin_binding=self.binding
        auth.admin_status_lookup=self.lookup
        auth._tokens.return_value={'access_token':'synthetic-private-token'}
        auth._upstream.return_value=self.user
        session={'uid':'fixed-uid','email':'fixed@example.org'}
        pg=Mock();pg._ok.return_value={'ok':True}
        self.assertEqual({'ok':True},verify_and_grant_admin(pg,auth,session,'fixed@example.org'))
        pg._ok.assert_called_once_with('trusted_grant_admin',self.binding)
        self.lookup.return_value['Data']['UserList'][0]['UserStatus']='DISABLED'
        pg.reset_mock()
        with self.assertRaises(ValueError):verify_and_grant_admin(pg,auth,session,'fixed@example.org')
        pg._ok.assert_not_called()

    def test_real_nested_response_requires_unique_total(self):
        self.assertTrue(operator_admin_attested(self.user,self.binding,self.lookup))
        self.lookup.return_value['Data']['Total']=2
        self.assertFalse(operator_admin_attested(self.user,self.binding,self.lookup))
        self.lookup.return_value['Data']['Total']='1'
        self.assertFalse(operator_admin_attested(self.user,self.binding,self.lookup))
    def test_malformed_explicit_data_does_not_fall_back_to_root(self):
        self.lookup.return_value={'Data':None,'UserList':[{'Uid':'fixed-uid','Email':'fixed@example.org','UserStatus':'ACTIVE'}]}
        self.assertFalse(operator_admin_attested(self.user,self.binding,self.lookup))

if __name__=='__main__':unittest.main()
