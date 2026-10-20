"""BFF boundary. Only a trusted hosted-auth/session adapter may create Identity."""
from dataclasses import dataclass
import hmac
import json
import re
from .service import ServiceError,AssetBody

@dataclass(frozen=True)
class Identity:
    uid: str
    email: str
    csrf_token: str
    email_verified: bool=False
    active: bool=False
    operator_admin_attested: bool=False

class UnconfiguredAuth:
    configured=False
    def authenticate(self,environ): return None

class MemberApp:
    def __init__(self,service,auth=None,origin='https://metalradical.xyz'):
        self.service,self.auth,self.origin=service,auth or UnconfiguredAuth(),origin
    def __call__(self,environ,start_response):
        environ.pop('member.preauth_row',None)
        mime='application/json; charset=utf-8';stream=None
        try:
            status,result,mime=self.dispatch(environ)
            stream=result if isinstance(result,AssetBody) else None
            payload=b'' if stream else result if isinstance(result,bytes) else json.dumps(result,ensure_ascii=False).encode()
        except ServiceError as error:
            status,payload=error.status,json.dumps({'error':error.code}).encode()
        except Exception:
            # No secrets, upstream responses, tokens or internal paths are exposed.
            status,payload=503,b'{"error":"service_unavailable"}'
        labels={200:'OK',201:'Created',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',405:'Method Not Allowed',409:'Conflict',413:'Payload Too Large',428:'Precondition Required',429:'Too Many Requests',503:'Service Unavailable'}
        headers=[('Content-Type',mime),('Content-Length',str(stream.length if stream else len(payload))),('Cache-Control','no-store, private'),('X-Content-Type-Options','nosniff'),('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'"),('Referrer-Policy','no-referrer')]
        if status==200 and stream and environ.get('PATH_INFO','').startswith('/api/member/public/articles/'):
            headers=[(key,'public, max-age=31536000, immutable' if key=='Cache-Control' else value) for key,value in headers]
        headers.extend(('Set-Cookie',value) for value in environ.get('member.set_cookies',[]))
        start_response(f'{status} {labels.get(status,"Error")}', headers)
        return stream if stream else [payload]
    def dispatch(self,e):
        from urllib.parse import parse_qs
        method=e.get('REQUEST_METHOD','GET'); path=e.get('PATH_INFO',''); jsonmime='application/json; charset=utf-8'
        if path=='/api/member/literature':
            if method!='GET':raise ServiceError(405,'method_not_allowed')
            from .literature import lookup
            query=parse_qs(e.get('QUERY_STRING',''),max_num_fields=8)
            return 200,lookup(query.get('q',[''])[0],e.get('REMOTE_ADDR','')),jsonmime
        if path.startswith('/api/member/public/'):
            if method!='GET':raise ServiceError(405,'method_not_allowed')
            if path=='/api/member/public/articles':return 200,self.service.public_articles(),jsonmime
            if (match:=re.fullmatch(r'/api/member/public/articles/([\w-]+)',path)):
                return 200,self.service.public_article(match[1]),jsonmime
            if (match:=re.fullmatch(r'/api/member/public/articles/([\w-]+)/assets/([\w-]+)',path)):
                vh=parse_qs(e.get('QUERY_STRING',''),max_num_fields=4).get('v',[''])[0]
                stream=self.service.public_asset(match[1],match[2],vh)
                return 200,stream,stream.mime
            raise ServiceError(404,'endpoint_not_found')
        configured=bool(getattr(self.auth,'configured',False))
        auth_paths=('/api/member/login','/api/member/register','/api/member/verification','/api/member/verify','/api/member/logout','/api/member/reset-request','/api/member/reset-password','/api/member/captcha','/api/member/captcha/verify')
        if configured and path in auth_paths and method=='POST':
            if e.get('CONTENT_TYPE','').split(';')[0]!='application/json':raise ServiceError(400,'json_required')
            try:
                length=int(e.get('CONTENT_LENGTH','0'))
                if length<0 or length>32768:raise ServiceError(413,'body_too_large')
                auth_data=json.loads(e['wsgi.input'].read(length))
            except (ValueError,UnicodeError):raise ServiceError(400,'invalid_json')
            if not isinstance(auth_data,dict):raise ServiceError(400,'object_required')
            return 200,self.auth.handle(e,path,auth_data),jsonmime
        identity=self.auth.authenticate(e) if configured else None
        if path=='/api/member/session' and method=='GET':
            user=None; csrf=None
            if identity:
                me=self.service.me(identity.uid)
                user={'id':identity.uid,'email':identity.email,'role':'admin' if me['admin'] and ((identity.email_verified and identity.active) or identity.operator_admin_attested) else 'member'}; csrf=identity.csrf_token
            if not csrf and configured and hasattr(self.auth,'preauth_csrf'):csrf=self.auth.preauth_csrf(e)
            return 200,{'configured':configured,'user':user,'csrfToken':csrf},jsonmime
        if not identity: raise ServiceError(401,'authentication_required')
        uid=identity.uid
        if path.startswith('/api/member/admin/') and not ((identity.email_verified and identity.active) or identity.operator_admin_attested):raise ServiceError(403,'verified_active_email_required')
        if method not in ('GET','HEAD'):
            if e.get('HTTP_ORIGIN')!=self.origin: raise ServiceError(403,'origin_rejected')
            token=e.get('HTTP_X_CSRF_TOKEN','')
            if not token or not identity.csrf_token or not hmac.compare_digest(token,identity.csrf_token): raise ServiceError(403,'csrf_rejected')
        data={}
        if method in ('POST','PUT'):
            if e.get('CONTENT_TYPE','').split(';')[0]!='application/json': raise ServiceError(400,'json_required')
            try: length=int(e.get('CONTENT_LENGTH','0'))
            except ValueError: raise ServiceError(400,'invalid_length')
            if length<0 or length>32768: raise ServiceError(413,'body_too_large')
            try: data=json.loads(e['wsgi.input'].read(length) or b'{}')
            except (ValueError,UnicodeError): raise ServiceError(400,'invalid_json')
            if not isinstance(data,dict): raise ServiceError(400,'object_required')
        if path=='/api/member/favorites' and method=='GET': result=self.service.favorites(uid)
        elif (match:=re.fullmatch(r'/api/member/favorites/([\w-]+)',path)) and method in ('PUT','DELETE'): result=self.service.favorite(uid,match[1],method=='PUT')
        elif (match:=re.fullmatch(r'/api/member/progress/([\w-]+)',path)) and method in ('GET','PUT'): result=self.service.get_progress(uid,match[1]) if method=='GET' else self.service.put_progress(uid,match[1],data)
        elif path=='/api/member/notes' and method=='GET': result=self.service.notes(uid,parse_qs(e.get('QUERY_STRING','')).get('article_id',[None])[0])
        elif path=='/api/member/notes' and method=='POST': result=self.service.add_note(uid,data)
        elif (match:=re.fullmatch(r'/api/member/notes/([\w-]+)',path)) and method=='DELETE': result=self.service.delete_note(uid,match[1])
        elif path=='/api/member/admin/events' and method=='GET':
            query=parse_qs(e.get('QUERY_STRING',''));result=self.service.events(uid,query.get('after',[''])[0],query.get('after_id',[''])[0])
        elif path=='/api/member/admin/drafts' and method=='GET': result=self.service.drafts(uid)
        elif (match:=re.fullmatch(r'/api/member/admin/drafts/([\w-]+)/export-plan',path)) and method in ('GET','PUT'):
            from .article_export import snapshot, validate_plan
            query=parse_qs(e.get('QUERY_STRING',''),max_num_fields=4)
            source=query.get('source',['draft'])[0]
            if source=='history':
                if method!='GET':raise ServiceError(403,'historical_version_read_only')
                draft=self.service.draft_version(uid,match[1],query.get('version',[''])[0])
                parsed=json.loads(draft['body'])
                body={**parsed,'version_hash':draft['version_hash'],'source':'history','title':draft['title']}
                return 200,{**body,'plan':None},'application/json'
            if source=='static':
                # Static public snapshots are already delivered to everyone. Only
                # editorial IDs/title are accepted here, never HTML, images or draft data.
                from .service import version, bounded, identifier
                if not self.service.me(uid)['admin']:raise ServiceError(403,'admin_required')
                vh=version(query.get('version',[''])[0])
                body={'version_hash':vh}
                plan=None
                if method=='PUT':
                    starts=data.get('starts')
                    if data.get('version_hash')!=vh:raise ServiceError(409,'version_mismatch')
                    if not isinstance(starts,list) or len(starts)>60 or any(not isinstance(s,str) for s in starts) or len(set(starts))!=len(starts):raise ServiceError(400,'invalid_export_plan')
                    plan={'version_hash':vh,'starts':[identifier(s) for s in starts],'title':bounded(data.get('title'),300)}
            else:
                body=snapshot(self.service,uid,match[1],source)
                plan=validate_plan(body,data) if method=='PUT' else None
            saved=self.service.export_plan(uid,match[1],source,body['version_hash'],plan)
            result={**body,**saved}
        elif (match:=re.fullmatch(r'/api/member/admin/drafts/([\w-]+)/versions',path)) and method=='GET': result=self.service.draft_versions(uid,match[1])
        elif (match:=re.fullmatch(r'/api/member/admin/drafts/([\w-]+)/versions/([a-f0-9]{64})',path)) and method=='GET': result=self.service.draft_version(uid,match[1],match[2])
        elif (match:=re.fullmatch(r'/api/member/admin/drafts/([\w-]+)/versions/([a-f0-9]{64})/assets/([\w-]+)',path)) and method=='GET':
            stream=self.service.version_asset_stream(uid,match[1],match[2],match[3]); return 200,stream,stream.mime
        elif (match:=re.fullmatch(r'/api/member/admin/drafts/([\w-]+)',path)) and method=='GET':
            vh=parse_qs(e.get('QUERY_STRING','')).get('version',[''])[0]
            result=self.service.draft_version(uid,match[1],vh) if vh else self.service.draft(uid,match[1])
        elif (match:=re.fullmatch(r'/api/member/admin/drafts/([\w-]+)/assets/([\w-]+)',path)) and method=='GET':
            vh=parse_qs(e.get('QUERY_STRING','')).get('version',[''])[0]
            stream=self.service.version_asset_stream(uid,match[1],vh,match[2]) if vh else self.service.asset_stream(uid,match[1],match[2]); return 200,stream,stream.mime
        elif (match:=re.fullmatch(r'/api/member/admin/drafts/([\w-]+)/feedback',path)) and method=='POST': result=self.service.feedback(uid,match[1],data)
        elif (match:=re.fullmatch(r'/api/member/admin/drafts/([\w-]+)/feedback/([\w-]+)',path)) and method=='PUT': result=self.service.edit_feedback(uid,match[1],match[2],data)
        elif (match:=re.fullmatch(r'/api/member/admin/drafts/([\w-]+)/publish',path)) and method=='POST': result=self.service.publish(uid,match[1],data)
        elif (match:=re.fullmatch(r'/api/member/admin/drafts/([\w-]+)/reviews',path)) and method=='POST':
            # The current authenticated session, administrator authorization,
            # CSRF checks and exact draft version govern routine review.
            # Reviewing does not publish and must not force a login every 15 min.
            result=self.service.review(uid,match[1],data)
        else: raise ServiceError(404,'endpoint_not_found')
        return 200,result,jsonmime
