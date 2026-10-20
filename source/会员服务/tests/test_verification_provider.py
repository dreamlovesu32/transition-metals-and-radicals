"""Provider-shape and shared-store regression tests, with no network requests."""
import hashlib
import time
import unittest
from cryptography.fernet import Fernet
from member_service.cloudbase_shared_auth import CloudBaseSharedAuth
from member_service.cloudbase_pg import CloudPGError
from member_service.service import ServiceError

class Store:
    def __init__(self):
        self.issued={}; self.fail=False
    def call(self,name,p):
        if name=='rate_limit':return {'attempts':1}
        if name=='verification_create':
            if self.fail:raise CloudPGError('private-detail-must-not-leak')
            self.issued[p['id_hash']]=p
            return {'ok':True}
        if name=='verification_get':return self.issued.get(p['id_hash'],{})
        if name=='verification_consume':return {'ok':True}
        return {'ok':True}

class Auth(CloudBaseSharedAuth):
    def _row(self,e):return {'id_hash':'session','csrf':'csrf'}
    def _consume_captcha(self,row,data):return 'private-captcha'
    def _upstream(self,path,body=None,token=None,captcha_token=None):
        self.paths.append(path)
        if path=='/auth/v1/verification':return self.response
        if path=='/auth/v1/verification/verify':return {'verification_token':'private-proof'}
        if path=='/auth/v1/reset':return {}
        raise AssertionError(path)
    def _create(self,*args,**kwargs):return 'csrf'

class VerificationProviderTests(unittest.TestCase):
    def setUp(self):
        self.store=Store();self.auth=Auth(self.store,'https://example.invalid',Fernet.generate_key(),'test')
        self.auth.paths=[];self.auth.response={'verification_id':'x'*1024,'expires_in':None}
        self.env={'HTTP_ORIGIN':'https://metalradical.xyz','HTTP_X_CSRF_TOKEN':'csrf'}
    def issue(self,recovery=False):
        return self.auth.handle(dict(self.env),'/api/member/reset-request' if recovery else '/api/member/verification',{'email':'private@example.org'})
    def test_long_provider_id_and_null_expiry_persist(self):
        result=self.issue()
        self.assertEqual(1024,len(result['verification_id']))
        self.assertEqual(300,result['expires_in'])
        row=next(iter(self.store.issued.values()))
        self.assertEqual('signin',row['usage'])
        self.assertGreater(row['expires_at'],time.time())
    def test_missing_expiry_defaults(self):
        self.auth.response={'verification_id':'valid'}
        self.assertEqual(300,self.issue()['expires_in'])
    def test_invalid_response_is_503_and_logs_no_private_values(self):
        for response in ({'verification_id':'x'*4097},{'verification_id':None},{'verification_id':'private-id','expires_in':'private-invalid'}):
            self.auth.response=response
            with self.assertLogs('member_service.cloudbase_auth',level='WARNING') as logs:
                with self.assertRaises(ServiceError) as error:self.issue()
            self.assertEqual((503,'verification_response_invalid'),(error.exception.status,error.exception.code))
            self.assertNotIn('private',str(logs.output))
        self.assertFalse(self.store.issued)
    def test_persistence_failure_never_claims_send_success(self):
        self.store.fail=True
        with self.assertLogs('member_service.cloudbase_auth',level='WARNING') as logs:
            with self.assertRaises(ServiceError) as error:self.issue()
        self.assertEqual('verification_persistence_failed',error.exception.code)
        self.assertNotIn('private',str(logs.output))
    def test_reset_accepts_long_id_and_requires_recovery_usage(self):
        result=self.issue(recovery=True)
        payload={'email':'private@example.org','verification_id':result['verification_id'],'verification_code':'123456','new_password':'replacement-password'}
        answer=self.auth.handle(dict(self.env),'/api/member/reset-password',payload)
        self.assertTrue(answer['reauthentication_required'])
        self.assertIn('/auth/v1/reset',self.auth.paths)
    def test_signin_proof_cannot_reset_password(self):
        result=self.issue()
        with self.assertRaises(ServiceError) as error:
            self.auth.handle(dict(self.env),'/api/member/reset-password',{'email':'private@example.org','verification_id':result['verification_id'],'verification_code':'123456','new_password':'replacement-password'})
        self.assertEqual('verification_wrong_usage',error.exception.code)
        self.assertNotIn('/auth/v1/reset',self.auth.paths)

class AuthLatencyTests(unittest.TestCase):
    def test_preauth_consumes_same_request_row_once(self):
        class CountingAuth(CloudBaseSharedAuth):
            count=0
            def _row(self,e):
                self.count+=1
                return {'csrf':'fresh-csrf','token_cipher':self.cipher.encrypt(b'{}').decode()}
        auth=CountingAuth(Store(),'https://example.invalid',Fernet.generate_key(),'test')
        env={}
        self.assertIsNone(auth.authenticate(env))
        self.assertEqual('fresh-csrf',auth.preauth_csrf(env))
        self.assertEqual(1,auth.count)
        self.assertNotIn('member.preauth_row',env)
        self.assertIsNone(auth.authenticate(env))
        self.assertEqual(2,auth.count)
    def test_timing_labels_never_include_upstream_input(self):
        class TimedAuth(CloudBaseSharedAuth):
            def _request_upstream(self,*args,**kwargs):return {'private':'private-token'}
        auth=TimedAuth(Store(),'https://example.invalid',Fernet.generate_key(),'test')
        with self.assertLogs('member_service.cloudbase_auth',level='WARNING') as logs:
            auth._upstream('/unknown?private-email@example.org',{'password':'private-password'},'private-token','private-captcha')
        self.assertIn('stage=upstream_other',str(logs.output))
        self.assertNotIn('private',str(logs.output))
        with self.assertLogs('member_service.cloudbase_shared_auth',level='WARNING') as logs:
            auth._call('session_create',email='private-email@example.org',token_cipher='private-token')
        self.assertIn('stage=database_session_create',str(logs.output))
        self.assertNotIn('private',str(logs.output))

if __name__=='__main__':unittest.main()
