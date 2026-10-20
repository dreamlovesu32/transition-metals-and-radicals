"""CloudBase hosted Auth BFF. No password database; never logs tokens.
Requires cryptography and a separately-provisioned TLS PostgreSQL DSN in production.
"""
import hashlib
import hmac
import json
import logging
import secrets
import time
import urllib.request
import urllib.error
from http.cookies import SimpleCookie
from .http import Identity
from .service import ServiceError, bounded

class CloudBaseAuth:
    configured=True
    verification_id_limit=4096
    cookie_name='__Host-read_session'
    def __init__(self,store,base_url,encryption_key,client_id,origin='https://metalradical.xyz',captcha_hosts=()):
        from cryptography.fernet import Fernet
        from urllib.parse import urlparse
        parsed=urlparse(base_url)
        if parsed.scheme!='https' or not parsed.hostname or parsed.path not in ('','/') or parsed.query or parsed.fragment: raise ValueError('HTTPS Auth origin required')
        self.store,self.base,self.origin=store,base_url.rstrip('/'),origin
        self.cipher=Fernet(encryption_key)
        self.client_id=bounded(client_id,256)
        self.captcha_hosts=set(captcha_hosts)
    def _upstream(self,path,body=None,token=None,captcha_token=None):
        # Route labels come from a fixed allowlist, never URLs or user input.
        labels={'/auth/v1/captcha/data':'captcha_generate',
                '/auth/v1/captcha/data/verify':'captcha_verify',
                '/auth/v1/verification':'email_verification_send',
                '/auth/v1/verification/verify':'email_verification_verify',
                '/auth/v1/signin':'signin','/auth/v1/signup':'signup',
                '/auth/v1/reset':'password_reset','/auth/v1/user/me':'identity',
                '/auth/v1/token':'refresh','/auth/v1/user/signout':'signout'}
        stage=labels.get(path,'other')
        started=time.monotonic()
        outcome='failed'
        try:
            result=self._request_upstream(path,body,token,captcha_token)
            outcome='ok'
            return result
        finally:
            logging.getLogger(__name__).warning('auth_timing stage=upstream_%s outcome=%s elapsed_ms=%d',stage,outcome,int((time.monotonic()-started)*1000))
    def _request_upstream(self,path,body=None,token=None,captcha_token=None):
        headers={'Content-Type':'application/json'}
        if token: headers['Authorization']='Bearer '+token
        if captcha_token:headers['x-captcha-token']=captcha_token
        request=urllib.request.Request(self.base+path+('?'+'client_id='+urllib.parse.quote(self.client_id,safe='') if not token else ''),data=json.dumps(body).encode() if body is not None else None,headers=headers)
        try:
            with urllib.request.urlopen(request,timeout=12) as response:
                raw=response.read(1024*1024+1)
                if len(raw)>1024*1024: raise ServiceError(503,'auth_unavailable')
                result=json.loads(raw)
                if not isinstance(result,dict): raise ServiceError(503,'auth_unavailable')
                return result
        except urllib.error.HTTPError as error:
            try:
                detail=json.loads(error.read(65536))
                code=str(detail.get('error',detail.get('code',''))).lower()
                if 'captcha' in code:raise ServiceError(428,'captcha_required')
            except (ValueError,AttributeError):pass
            raise ServiceError(401 if error.code in (400,401,403) else 503,'auth_rejected' if error.code in (400,401,403) else 'auth_unavailable') from None
        except (OSError,ValueError): raise ServiceError(503,'auth_unavailable') from None
    def _row(self,e):
        try:
            cookie=SimpleCookie();cookie.load(e.get('HTTP_COOKIE','')); sid=cookie[self.cookie_name].value
        except (KeyError,ValueError):return None
        if len(sid)!=64:return None
        key=hashlib.sha256(sid.encode()).hexdigest()
        row=self._session_get(key)
        if not row or row['expires_at']<=int(time.time()): return None
        return row
    def _create(self,e,tokens=None,remember=True):
        sid=secrets.token_hex(32);csrf=secrets.token_urlsafe(32);expiry=int(time.time())+((30*86400 if remember else 12*3600) if tokens else 900)
        encoded=self.cipher.encrypt(json.dumps(tokens or {}).encode()).decode()
        self._session_create(hashlib.sha256(sid.encode()).hexdigest(),encoded,(tokens or {}).get('_uid',''),(tokens or {}).get('_email',''),csrf,expiry)
        persistent=f'; Max-Age={expiry-int(time.time())}' if (remember or not tokens) else ''
        e.setdefault('member.set_cookies',[]).append(f'{self.cookie_name}={sid}; Path=/; Secure; HttpOnly; SameSite=Strict'+persistent)
        return csrf
    def _tokens(self,row):return json.loads(self.cipher.decrypt(row['token_cipher'].encode()))
    def _session_get(self,key):
        with self.store.transaction() as tx:return tx.one('SELECT * FROM sessions WHERE id_hash=? AND revoked=0',(key,))
    def _session_create(self,key,encoded,uid,email,csrf,expiry):
        with self.store.transaction() as tx:tx.execute('INSERT INTO sessions VALUES (?,?,?,?,?,?,0)',(key,encoded,uid,email,csrf,expiry))
    def _session_revoke(self,key):
        with self.store.transaction() as tx:tx.execute('UPDATE sessions SET revoked=1 WHERE id_hash=?',(key,))
    def _sessions_revoke_email(self,email):
        with self.store.transaction() as tx:tx.execute('UPDATE sessions SET revoked=1 WHERE email=?',(email,))
    def _revoke(self,row):
        if row:
            self._session_revoke(row['id_hash'])
    def authenticate(self,e):
        row=self._row(e)
        e['member.preauth_row']=(self,row)
        if not row:return None
        tokens=self._tokens(row)
        if not tokens.get('access_token'):return None
        if tokens.get('_expires_at',0)<=time.time()+30:
            # Serialize refresh-token rotation on the persisted session row.
            with self.store.transaction() as tx:
                lock=' FOR UPDATE' if tx.postgres else ''
                fresh=tx.one('SELECT * FROM sessions WHERE id_hash=? AND revoked=0'+lock,(row['id_hash'],))
                if not fresh or fresh['expires_at']<=int(time.time()):raise ServiceError(401,'session_expired')
                tokens=self._tokens(fresh)
                if tokens.get('_expires_at',0)<=time.time()+30:
                    renewed=self._upstream('/auth/v1/token',{'client_id':self.client_id,'grant_type':'refresh_token','refresh_token':tokens.get('refresh_token')})
                    renewed['_expires_at']=int(time.time())+int(renewed.get('expires_in',0))
                    renewed['_auth_time']=tokens.get('_auth_time',0)
                    if not renewed.get('refresh_token'):renewed['refresh_token']=tokens.get('refresh_token')
                    tokens=renewed
                    tx.execute('UPDATE sessions SET token_cipher=? WHERE id_hash=? AND revoked=0',(self.cipher.encrypt(json.dumps(tokens).encode()).decode(),row['id_hash']))
        e['member.auth_time']=tokens.get('_auth_time',0)
        # Live validation on every API request. Revoked upstream sessions fail closed.
        user=self._upstream('/auth/v1/user/me',token=tokens['access_token'])
        uid=user.get('sub')
        if user.get('status') not in (None,'ACTIVE','active'):raise ServiceError(401,'account_inactive')
        if not isinstance(uid,str) or not uid or uid!=row['uid']:raise ServiceError(401,'invalid_identity')
        return Identity(uid,user.get('email',''),row['csrf'],user.get('email_verified') is True,user.get('status')=='ACTIVE')
    def preauth_csrf(self,e):
        cached=e.pop('member.preauth_row',None)
        row=cached[1] if isinstance(cached,tuple) and len(cached)==2 and cached[0] is self else self._row(e)
        if row:return row['csrf']
        self.rate_limit('preauth:'+e.get('REMOTE_ADDR','unknown'),30,3600)
        return self._create(e)
    def rate_limit(self,bucket,limit,seconds):
        now=int(time.time());key=hashlib.sha256(bucket.encode()).hexdigest();threshold=now-seconds
        if self._rate_attempt(key,now,threshold)>limit:raise ServiceError(429,'rate_limited')
    def _rate_attempt(self,key,now,threshold):
        with self.store.transaction() as tx:
            row=tx.one('INSERT INTO rate_limits VALUES (?,?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN rate_limits.window_start<=? THEN 1 ELSE rate_limits.attempts+1 END,window_start=CASE WHEN rate_limits.window_start<=? THEN excluded.window_start ELSE rate_limits.window_start END RETURNING attempts',(key,now,threshold,threshold))
        return row['attempts']
    def _consume_captcha(self,row,data):
        state=bounded(data.get('captcha_state'),256)
        state_hash=hashlib.sha256(state.encode()).hexdigest()
        challenge=self._captcha_consume(state_hash,row['id_hash'])
        if not challenge:raise ServiceError(403,'captcha_required')
        return self.cipher.decrypt(challenge['verified_cipher'].encode()).decode()
    def _captcha_consume(self,state_hash,session_hash):
        with self.store.transaction() as tx:
            challenge=tx.one('SELECT * FROM captcha_images WHERE state_hash=? AND session_hash=? AND consumed=0',(state_hash,session_hash))
            if not challenge or challenge['expires_at']<=int(time.time()) or not challenge['verified_cipher']:return None
            tx.execute('UPDATE captcha_images SET consumed=1 WHERE state_hash=?',(state_hash,))
        return challenge
    def _captcha_create(self,state_hash,session_hash,token_cipher,expiry):
        with self.store.transaction() as tx:tx.execute('INSERT INTO captcha_images VALUES (?,?,?,?,?,0)',(state_hash,session_hash,token_cipher,expiry,''))
    def _captcha_get(self,state_hash,session_hash):
        with self.store.transaction() as tx:return tx.one('SELECT * FROM captcha_images WHERE state_hash=? AND session_hash=? AND consumed=0',(state_hash,session_hash))
    def _captcha_verify(self,state_hash,session_hash,verified_cipher,expiry):
        with self.store.transaction() as tx:tx.execute('UPDATE captcha_images SET verified_cipher=?,expires_at=? WHERE state_hash=? AND session_hash=? AND consumed=0',(verified_cipher,expiry,state_hash,session_hash))
    def _verification_create(self,id_hash,session_hash,email,usage,expiry):
        with self.store.transaction() as tx:tx.execute('INSERT INTO issued_verifications VALUES (?,?,?,?,?)',(id_hash,session_hash,email,usage,expiry))
    def _verification_get(self,id_hash,session_hash):
        with self.store.transaction() as tx:
            issued=tx.one('SELECT * FROM issued_verifications WHERE id_hash=? AND session_hash=?',(id_hash,session_hash))
            if issued and tx.one('SELECT id_hash FROM used_verifications WHERE id_hash=?',(id_hash,)):raise ServiceError(409,'verification_already_used')
            return issued
    def _verification_consume(self,id_hash):
        with self.store.transaction() as tx:
            if tx.one('SELECT id_hash FROM used_verifications WHERE id_hash=?',(id_hash,)):raise ServiceError(409,'verification_already_used')
            tx.execute('INSERT INTO used_verifications VALUES (?,?)',(id_hash,int(time.time())))
    def _verification_exchange(self,id_hash,session_hash,vid,code):
        verification=self._upstream('/auth/v1/verification/verify',{'verification_id':vid,'verification_code':code})
        self._verification_consume(id_hash)
        return verification
    def handle(self,e,path,data):
        row=self._row(e)
        if e.get('HTTP_ORIGIN')!=self.origin or not row or not hmac.compare_digest(e.get('HTTP_X_CSRF_TOKEN',''),row['csrf']):raise ServiceError(403,'csrf_rejected')
        ip=e.get('REMOTE_ADDR','unknown') # Never trust client supplied forwarding headers.
        self.rate_limit('auth-ip:'+ip,20,900)
        if path=='/api/member/logout':
            try:
                tokens=self._tokens(row)
                if tokens.get('access_token'):self._upstream('/auth/v1/user/signout',{},tokens['access_token'])
            finally:
                self._revoke(row)
                e.setdefault('member.set_cookies',[]).append(f'{self.cookie_name}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0')
            return {'ok':True}
        if path=='/api/member/captcha':
            self.rate_limit('captcha:'+ip,10,900)
            state=secrets.token_urlsafe(32)
            response=self._upstream('/auth/v1/captcha/data',{'state':state,'redirect_uri':''})
            image=bounded(response.get('data'),180000)
            import re,base64
            match=re.fullmatch(r'data:image/(gif|png|jpeg);base64,([A-Za-z0-9+/=]+)',image)
            if not match:raise ServiceError(503,'unsupported_captcha_type')
            try:image_bytes=base64.b64decode(match[2],validate=True)
            except ValueError:raise ServiceError(503,'invalid_captcha_image')
            valid=(match[1]=='gif' and image_bytes[:6] in (b'GIF87a',b'GIF89a')) or (match[1]=='png' and image_bytes.startswith(b'\x89PNG\r\n\x1a\n')) or (match[1]=='jpeg' and image_bytes.startswith(b'\xff\xd8\xff'))
            if not valid or len(image_bytes)>131072:raise ServiceError(503,'invalid_captcha_image')
            challenge_token=bounded(response.get('token'),8192)
            expiry=max(1,min(int(response.get('expires_in',300)),600))
            self._captcha_create(hashlib.sha256(state.encode()).hexdigest(),row['id_hash'],self.cipher.encrypt(challenge_token.encode()).decode(),int(time.time())+expiry)
            return {'image_data':image,'state':state,'type':'image','expires_in':expiry}
        if path=='/api/member/captcha/verify':
            state=bounded(data.get('state'),256);key=bounded(data.get('key'),4).strip()
            if not key:raise ServiceError(400,'invalid_captcha_key')
            state_hash=hashlib.sha256(state.encode()).hexdigest()
            self.rate_limit('captcha-verify:'+state_hash,5,900)
            challenge=self._captcha_get(state_hash,row['id_hash'])
            if not challenge or challenge['expires_at']<=int(time.time()) or challenge['verified_cipher']:raise ServiceError(403,'captcha_expired_or_used')
            token=self.cipher.decrypt(challenge['token_cipher'].encode()).decode()
            result=self._upstream('/auth/v1/captcha/data/verify',{'token':token,'key':key})
            verified=bounded(result.get('captcha_token'),4096)
            expiry=min(challenge['expires_at'],int(time.time())+max(1,int(result.get('expires_in',300))))
            self._captcha_verify(state_hash,row['id_hash'],self.cipher.encrypt(verified.encode()).decode(),expiry)
            return {'ok':True,'state':state}
        if path in ('/api/member/verification','/api/member/reset-request'):
            email=bounded(data.get('email'),254).strip().lower()
            self.rate_limit('email-send:'+email,3,3600);self.rate_limit('ip-send:'+ip,5,3600)
            captcha=self._consume_captcha(row,data)
            request={'email':email,'target':'USER' if path.endswith('reset-request') else 'ANY'}
            if path.endswith('reset-request'):request['usage']='recovery'
            try:
                response=self._upstream('/auth/v1/verification',request,captcha_token=captcha)
            except ServiceError:
                logging.getLogger(__name__).warning('auth_stage=verification_upstream error=verification_upstream_failed')
                raise
            try:
                verification_id=bounded(response.get('verification_id'),self.verification_id_limit)
                raw_expiry=response.get('expires_in')
                if raw_expiry is None:
                    raw_expiry=300
                if isinstance(raw_expiry,bool) or not isinstance(raw_expiry,(str,int)):
                    raise ValueError()
                expires=max(1,min(int(raw_expiry),900))
            except (ServiceError,TypeError,ValueError,OverflowError):
                logging.getLogger(__name__).warning('auth_stage=verification_response error=verification_response_invalid')
                raise ServiceError(503,'verification_response_invalid') from None
            try:
                self._verification_create(hashlib.sha256(verification_id.encode()).hexdigest(),row['id_hash'],email,request.get('usage','signin'),int(time.time())+expires)
            except Exception:
                # Only fixed stage/error labels are logged. Never log provider
                # payloads, email addresses, IDs, codes, tokens or exception text.
                logging.getLogger(__name__).warning('auth_stage=verification_persist error=verification_persistence_failed')
                raise ServiceError(503,'verification_persistence_failed') from None
            return {'verification_id':verification_id,'expires_in':expires}
        if path=='/api/member/login':
            username=bounded(data.get('username'),254);password=bounded(data.get('password'),1024)
            self.rate_limit('login-account:'+username.lower(),8,900)
            captcha=self._consume_captcha(row,data) if data.get('captcha_state') else None
            tokens=self._upstream('/auth/v1/signin',{'username':username,'password':password},captcha_token=captcha)
        elif path in ('/api/member/verify','/api/member/register','/api/member/reset-password'):
            if path in ('/api/member/register','/api/member/reset-password'):
                password_candidate=bounded(data.get('password') if path.endswith('register') else data.get('new_password'),1024)
                if len(password_candidate)<12:raise ServiceError(400,'password_too_short')
            vid=bounded(data.get('verification_id'),self.verification_id_limit);code=bounded(data.get('verification_code'),32)
            self.rate_limit('otp:'+vid,5,900)
            verification_hash=hashlib.sha256(vid.encode()).hexdigest()
            issued=self._verification_get(verification_hash,row['id_hash'])
            if not issued or issued['expires_at']<=int(time.time()):raise ServiceError(403,'verification_not_issued')
            if path=='/api/member/reset-password' and issued['usage']!='recovery':raise ServiceError(403,'verification_wrong_usage')
            if path=='/api/member/register' and issued['usage']=='recovery':raise ServiceError(403,'verification_wrong_usage')
            if path in ('/api/member/register','/api/member/reset-password') and str(data.get('email','')).strip().lower()!=issued['email']:raise ServiceError(403,'verification_email_mismatch')
            verification=self._verification_exchange(verification_hash,row['id_hash'],vid,code)
            if path=='/api/member/reset-password':
                email=bounded(data.get('email'),254).strip().lower();new_password=bounded(data.get('new_password'),1024)
                if len(new_password)<12:raise ServiceError(400,'password_too_short')
                self._upstream('/auth/v1/reset',{'email':email,'new_password':new_password,'verification_token':verification['verification_token']})
                self._sessions_revoke_email(email)
                self._revoke(row);self._create(e)
                return {'ok':True,'reauthentication_required':True}
            if path=='/api/member/register':
                email=bounded(data.get('email'),254);password=bounded(data.get('password'),1024)
                if len(password)<12:raise ServiceError(400,'password_too_short')
                tokens=self._upstream('/auth/v1/signup',{'email':email,'password':password,'verification_token':verification['verification_token'],'verification_code':code})
            else:tokens=self._upstream('/auth/v1/signin',{'verification_token':verification['verification_token']})
        else:raise ServiceError(404,'endpoint_not_found')
        # Verify upstream identity before persisting or granting any permissions.
        user=self._upstream('/auth/v1/user/me',token=tokens.get('access_token'))
        if not user.get('sub') or user.get('status') not in (None,'ACTIVE','active'):raise ServiceError(401,'invalid_identity')
        tokens['_uid']=user['sub']
        tokens['_email']=str(user.get('email','')).strip().lower()
        tokens['_auth_time']=int(time.time());tokens['_expires_at']=int(time.time())+int(tokens.get('expires_in',0))
        remember=data.get('remember',True)
        if type(remember) is not bool:raise ServiceError(400,'invalid_remember')
        self._revoke(row);self._create(e,tokens,remember=remember)
        return {'ok':True}
