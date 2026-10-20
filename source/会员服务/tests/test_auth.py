import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from cryptography.fernet import Fernet
from member_service import MemberApp,MemberService,SQLiteStore,ServiceError
from member_service.cloudbase_auth import CloudBaseAuth

class AuthTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=SQLiteStore(Path(self.tmp.name)/'auth.db');self.store.initialize()
        class FakeUpstream(CloudBaseAuth):
            calls=[]
            reject=False
            def _upstream(inner,path,body=None,token=None,captcha_token=None):
                inner.calls.append(path)
                if inner.reject:raise ServiceError(401,'auth_rejected')
                if path=='/auth/v1/user/me':return {'sub':'verified-user','email':'user@example.org','status':'ACTIVE','email_verified':True}
                if path=='/auth/v1/captcha/data':return {'data':'data:image/gif;base64,R0lGODlh','token':'challenge-secret','expires_in':300}
                if path=='/auth/v1/captcha/data/verify':
                    if body.get('key')!='ABCD':raise ServiceError(428,'captcha_required')
                    return {'captcha_token':'official-proof','expires_in':300}
                if path=='/auth/v1/verification':
                    if captcha_token=='bad':raise ServiceError(428,'captcha_required')
                    return {'verification_id':'issued-verification','expires_in':300}
                if path=='/auth/v1/verification/verify':return {'verification_token':'verified-proof'}
                if path=='/auth/v1/reset':return {}
                if path=='/auth/v1/user/signout':return {}
                return {'access_token':'secret-access','refresh_token':'secret-refresh','expires_in':3600}
        self.auth=FakeUpstream(self.store,'https://example.invalid',Fernet.generate_key(),'test-env')
        self.app=MemberApp(MemberService(self.store),self.auth)
    def tearDown(self):self.tmp.cleanup()
    def request(self,path,method='GET',data=None,cookie='',csrf='',origin='https://metalradical.xyz'):
        raw=json.dumps(data or {}).encode();env={'REQUEST_METHOD':method,'PATH_INFO':path,'CONTENT_TYPE':'application/json','CONTENT_LENGTH':str(len(raw)),'wsgi.input':io.BytesIO(raw),'HTTP_COOKIE':cookie,'HTTP_X_CSRF_TOKEN':csrf,'HTTP_ORIGIN':origin,'REMOTE_ADDR':'127.0.0.1'}
        out=[];body=b''.join(self.app(env,lambda status,headers:out.append((int(status.split()[0]),headers))))
        return out[0][0],out[0][1],json.loads(body)
    def login(self):
        status,headers,payload=self.request('/api/member/session');self.assertEqual(200,status)
        cookie=next(v.split(';')[0] for k,v in headers if k=='Set-Cookie')
        self.assertIsNone(payload['user'])
        status,headers,_=self.request('/api/member/login','POST',{'username':'user@example.org','password':'example password'},cookie,payload['csrfToken'])
        self.assertEqual(200,status)
        cookie=next(v.split(';')[0] for k,v in headers if k=='Set-Cookie')
        return cookie
    def test_pre_auth_csrf_session_rotation_and_encrypted_persistence(self):
        cookie=self.login()
        status,_,payload=self.request('/api/member/session',cookie=cookie)
        self.assertEqual('verified-user',payload['user']['id']);self.assertEqual('member',payload['user']['role'])
        with self.store.transaction() as tx:rows=tx.all('SELECT * FROM sessions')
        self.assertEqual(2,len(rows));self.assertEqual(1,sum(r['revoked'] for r in rows))
        self.assertNotIn('secret-access',str(rows));self.assertNotIn('secret-refresh',str(rows));self.assertNotIn(cookie.split('=')[1],str(rows))
    def test_login_csrf_rejected(self):
        status,_,_=self.request('/api/member/login','POST',{'username':'user','password':'pass'})
        self.assertEqual(403,status)
    def test_logout_revoke_even_upstream_failure(self):
        cookie=self.login();_,_,payload=self.request('/api/member/session',cookie=cookie)
        self.auth.reject=True
        self.assertEqual(401,self.request('/api/member/logout','POST',{},cookie,payload['csrfToken'])[0])
        self.auth.reject=False
        self.assertIsNone(self.request('/api/member/session',cookie=cookie)[2]['user'])
    def test_refresh_and_expired_session(self):
        cookie=self.login()
        with self.store.transaction() as tx:
            row=tx.one('SELECT * FROM sessions WHERE revoked=0');tokens=self.auth._tokens(row);tokens['_expires_at']=0
            tx.execute('UPDATE sessions SET token_cipher=? WHERE id_hash=?',(self.auth.cipher.encrypt(json.dumps(tokens).encode()).decode(),row['id_hash']))
        self.assertEqual(200,self.request('/api/member/session',cookie=cookie)[0]);self.assertIn('/auth/v1/token',self.auth.calls)
        with self.store.transaction() as tx:tx.execute('UPDATE sessions SET expires_at=0')
        self.assertEqual(401,self.request('/api/member/favorites',cookie=cookie)[0])
    def test_persistent_rate_limit(self):
        self.auth.rate_limit('bucket',1,60)
        with self.assertRaises(ServiceError) as error:self.auth.rate_limit('bucket',1,60)
        self.assertEqual(429,error.exception.status)
    def test_upstream_auth_failure_never_becomes_identity(self):
        cookie=self.login();self.auth.reject=True
        self.assertEqual(401,self.request('/api/member/favorites',cookie=cookie)[0])

    def test_upstream_identity_drift_is_rejected(self):
        cookie=self.login()
        with self.store.transaction() as tx:
            tx.execute('UPDATE sessions SET uid=? WHERE revoked=0',('another-user',))
        self.assertEqual(401,self.request('/api/member/favorites',cookie=cookie)[0])

    def preauth(self):
        _,headers,payload=self.request('/api/member/session')
        return next(v.split(';')[0] for k,v in headers if k=='Set-Cookie'),payload['csrfToken']
    def issue_code(self,cookie,csrf,recovery=False):
        self.auth.captcha_hosts={'captcha.example.org'}
        status,_,challenge=self.request('/api/member/captcha','POST',{},cookie,csrf)
        self.assertEqual(200,status)
        verified=self.request('/api/member/captcha/verify','POST',{'state':challenge['state'],'key':'ABCD'},cookie,csrf)
        self.assertEqual(200,verified[0])
        data={'email':'user@example.org','captcha_state':challenge['state']}
        status,_,result=self.request('/api/member/reset-request' if recovery else '/api/member/verification','POST',data,cookie,csrf)
        self.assertEqual(200,status)
        return result
    def test_unverified_captcha_cannot_issue_codes(self):
        cookie,csrf=self.preauth()
        self.assertEqual(403,self.request('/api/member/verification','POST',{'email':'user@example.org','captcha_state':'forged','captcha_token':'anything'},cookie,csrf)[0])
    def test_captcha_bound_to_session_and_upstream_checks_key(self):
        cookie,csrf=self.preauth()
        _,_,challenge=self.request('/api/member/captcha','POST',{},cookie,csrf)
        self.assertTrue(challenge['image_data'].startswith('data:image/gif;base64,'));self.assertNotIn('token',challenge)
        bad=self.request('/api/member/captcha/verify','POST',{'state':challenge['state'],'key':'BAD'},cookie,csrf)
        self.assertEqual(428,bad[0])
        with self.store.transaction() as tx:
            self.assertEqual([],tx.all('SELECT * FROM issued_verifications'))
            self.assertNotIn('challenge-secret',str(tx.all('SELECT * FROM captcha_images')))
        verified=self.request('/api/member/captcha/verify','POST',{'state':challenge['state'],'key':'ABCD'},cookie,csrf)
        self.assertEqual(200,verified[0]);self.assertNotIn('captcha_token',verified[2])
        data={'email':'user@example.org','captcha_state':challenge['state']}
        self.assertEqual(200,self.request('/api/member/verification','POST',data,cookie,csrf)[0])
        self.assertEqual(403,self.request('/api/member/verification','POST',data,cookie,csrf)[0])
    def test_signup_short_password_does_not_consume_otp_and_replay_rejected(self):
        cookie,csrf=self.preauth();code=self.issue_code(cookie,csrf)
        data={'email':'user@example.org','password':'short','verification_id':code['verification_id'],'verification_code':'123456'}
        self.assertEqual(400,self.request('/api/member/register','POST',data,cookie,csrf)[0])
        with self.store.transaction() as tx:self.assertEqual([],tx.all('SELECT * FROM used_verifications'))
        data['password']='long-enough-password'
        self.assertEqual(200,self.request('/api/member/register','POST',data,cookie,csrf)[0])
        # Rotate cookies on login; a consumed proof cannot authenticate another session.
        other_cookie,other_csrf=self.preauth()
        self.assertEqual(403,self.request('/api/member/register','POST',data,other_cookie,other_csrf)[0])
    def test_reset_revokes_all_matching_sessions(self):
        first=self.login();second=self.login();cookie,csrf=self.preauth();code=self.issue_code(cookie,csrf,True)
        data={'email':'user@example.org','new_password':'replacement-password','verification_id':code['verification_id'],'verification_code':'123456'}
        self.assertEqual(200,self.request('/api/member/reset-password','POST',data,cookie,csrf)[0])
        self.assertIsNone(self.request('/api/member/session',cookie=first)[2]['user'])
        self.assertIsNone(self.request('/api/member/session',cookie=second)[2]['user'])

    def test_concurrent_refresh_rotates_once(self):
        from concurrent.futures import ThreadPoolExecutor
        cookie=self.login()
        with self.store.transaction() as tx:
            row=tx.one('SELECT * FROM sessions WHERE revoked=0');tokens=self.auth._tokens(row);tokens['_expires_at']=0
            tx.execute('UPDATE sessions SET token_cipher=? WHERE id_hash=?',(self.auth.cipher.encrypt(json.dumps(tokens).encode()).decode(),row['id_hash']))
        self.auth.calls=[]
        with ThreadPoolExecutor(max_workers=4) as pool:
            identities=list(pool.map(lambda _:self.auth.authenticate({'HTTP_COOKIE':cookie}),range(4)))
        self.assertEqual(4,len(identities));self.assertEqual(1,self.auth.calls.count('/auth/v1/token'))
    def test_concurrent_rate_limit_is_atomic(self):
        from concurrent.futures import ThreadPoolExecutor
        def attempt(_):
            try:self.auth.rate_limit('concurrent',3,60);return True
            except ServiceError as error:
                self.assertEqual(429,error.status);return False
        with ThreadPoolExecutor(max_workers=8) as pool:accepted=list(pool.map(attempt,range(12)))
        self.assertEqual(3,sum(accepted))

    def test_remember_cookie_policy(self):
        for remember in (True,False):
            cookie,csrf=self.preauth()
            status,headers,_=self.request('/api/member/login','POST',{'username':'user@example.org','password':'example password','remember':remember},cookie,csrf)
            self.assertEqual(200,status)
            value=next(v for k,v in headers if k=='Set-Cookie')
            self.assertEqual(remember,'Max-Age=' in value)
            self.assertIn('Secure; HttpOnly; SameSite=Strict',value)

if __name__=='__main__':unittest.main()
