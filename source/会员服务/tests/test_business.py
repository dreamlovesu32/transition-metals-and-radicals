import io
import json
import tempfile
import unittest
from pathlib import Path
from member_service import MemberService, ServiceError, SQLiteStore, MemberApp
from member_service.http import Identity

class BusinessTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.store=SQLiteStore(Path(self.temp.name)/'test.db'); self.store.initialize(); self.service=MemberService(self.store)
        with self.store.transaction() as tx:
            tx.execute('INSERT INTO admins VALUES (?)',('admin',))
            tx.execute('INSERT INTO articles VALUES (?,?,?)',('paper','a'*64,1))
            tx.execute('INSERT INTO articles VALUES (?,?,?)',('secret','b'*64,0))
        self.vh=self.service.import_draft('draft','Title','<p>Private</p>',{'figure':('image/png',b'private image')})
    def tearDown(self): self.temp.cleanup()
    def error(self,status,fn,*args,**kwargs):
        with self.assertRaises(ServiceError) as caught: fn(*args,**kwargs)
        self.assertEqual(status,caught.exception.status)
    def test_favorites_idempotent_persisted_isolated(self):
        for _ in range(2): self.service.favorite('alice','paper',True)
        self.assertEqual(['paper'],[row['article_id'] for row in MemberService(SQLiteStore(self.store.path)).favorites('alice')])
        self.assertEqual([],self.service.favorites('bob'))
        for _ in range(2): self.service.favorite('alice','paper',False)
        self.assertEqual([],self.service.favorites('alice'))
    def test_private_articles_and_assets_are_admin_only(self):
        self.error(404,self.service.favorite,'alice','secret',True)
        for fn,args in [(self.service.drafts,()),(self.service.draft,('draft',)),(self.service.asset,('draft','figure'))]: self.error(403,fn,'alice',*args)
        self.assertEqual(b'private image',self.service.asset('admin','draft','figure')[1])
    def note(self,**kwargs):
        data={'article_id':'paper','version_hash':'a'*64,'anchor':'paragraph-1','quote':'quoted','text':'my note'}; data.update(kwargs)
        return self.service.add_note('alice',data)
    def test_notes_owner_scope_and_version(self):
        note=self.note(); self.assertEqual([],self.service.notes('bob','paper'))
        self.error(404,self.service.delete_note,'bob',note['id'])
        self.assertEqual(1,len(self.service.notes('alice','paper')))
        self.error(409,self.note,version_hash='c'*64)
        self.service.delete_note('alice',note['id']); self.assertEqual([],self.service.notes('alice','paper'))
    def test_input_constraints_and_parameterized_sql(self):
        self.error(400,self.note,text='x'*10001)
        self.error(400,self.note,anchor='x'*501)
        self.error(400,self.service.favorite,'alice',"x';DROP TABLE articles;--",True)
        note=self.note(text='<script>alert(1)</script>'); self.assertEqual('<script>alert(1)</script>',note['text'])
    def test_review_immutable_hash_and_no_publish(self):
        self.error(403,self.service.review,'alice','draft',{'version_hash':self.vh,'decision':'approved'})
        approval=self.service.review('admin','draft',{'version_hash':self.vh,'decision':'approved'})
        self.assertFalse(approval['published'])
        newer=self.service.import_draft('draft','Title','new body',{'figure':('image/png',b'changed')})
        self.assertNotEqual(self.vh,newer)
        self.error(409,self.service.review,'admin','draft',{'version_hash':self.vh,'decision':'approved'})
        self.assertEqual(self.vh,self.service.draft('admin','draft')['reviews'][0]['version_hash'])
    def test_review_accepts_old_valid_session_but_keeps_authorization_and_version(self):
        class Auth:
            configured=True
            uid='admin'
            valid=True
            def handle(self,*args): raise AssertionError('review must not start login')
            def authenticate(self,e):
                e['member.auth_time']=1
                return Identity(self.uid,'admin@example.org','csrf',True,True) if self.valid else None
        auth=Auth();app=MemberApp(self.service,auth)
        path='/api/member/admin/drafts/draft/reviews'
        data={'version_hash':self.vh,'decision':'approved'}
        def send(csrf='csrf'):return self.request(app,path,'POST',data,'https://metalradical.xyz',csrf)
        status,_,body=send();self.assertEqual(200,status);self.assertFalse(json.loads(body)['published'])
        self.assertEqual(403,send('wrong')[0])
        auth.uid='ordinary';self.assertEqual(403,send()[0])
        auth.uid='admin';data['version_hash']='c'*64;self.assertEqual(409,send()[0])
        auth.valid=False;self.assertEqual(401,send()[0])
    def request(self,app,path,method='GET',body=None,origin=None,csrf=None):
        raw=json.dumps(body or {}).encode(); env={'REQUEST_METHOD':method,'PATH_INFO':path,'wsgi.input':io.BytesIO(raw),'CONTENT_LENGTH':str(len(raw)),'CONTENT_TYPE':'application/json'}
        if origin:env['HTTP_ORIGIN']=origin
        if csrf:env['HTTP_X_CSRF_TOKEN']=csrf
        response=[]; payload=b''.join(app(env,lambda status,headers:response.append((status,dict(headers)))))
        return int(response[0][0].split()[0]),response[0][1],payload
    def test_http_fail_closed_and_secure_headers(self):
        app=MemberApp(self.service)
        status,headers,body=self.request(app,'/api/member/session'); self.assertEqual(200,status); self.assertFalse(json.loads(body)['configured'])
        for path in ['/api/member/admin/drafts/draft','/api/member/admin/drafts/draft/assets/figure','/api/member/favorites']:self.assertEqual(401,self.request(app,path)[0])
        self.assertEqual('no-store, private',headers['Cache-Control'])
    def test_http_csrf_and_origin(self):
        class Auth:
            configured=True
            def authenticate(self,e):return Identity('alice','alice@example.org','csrf')
        app=MemberApp(self.service,Auth())
        args=('/api/member/favorites/paper','PUT',{})
        self.assertEqual(403,self.request(app,*args)[0])
        self.assertEqual(403,self.request(app,*args,origin='https://evil.invalid',csrf='csrf')[0])
        self.assertEqual(403,self.request(app,*args,origin='https://metalradical.xyz',csrf='bad')[0])
        self.assertEqual(200,self.request(app,*args,origin='https://metalradical.xyz',csrf='csrf')[0])

    def test_highlight_without_text_and_empty_note_rejected(self):
        self.assertEqual('',self.note(text='')['text'])
        self.error(400,self.note,text='',quote='')
    def test_progress_cas_and_version_isolation(self):
        self.assertEqual(0,self.service.get_progress('alice','paper')['revision'])
        data={'revision':0,'version_hash':'a'*64,'position':{'blockId':'p1'}}
        saved=self.service.put_progress('alice','paper',data)
        self.assertEqual(1,saved['revision'])
        self.error(409,self.service.put_progress,'alice','paper',data)
        self.assertEqual(0,self.service.get_progress('bob','paper')['revision'])
        data.update(revision=1,version_hash='c'*64)
        self.error(409,self.service.put_progress,'alice','paper',data)
    def test_feedback_version_and_incremental_events(self):
        data={'version_hash':self.vh,'target':{'type':'paragraph','id':'p1'},'quote':'original quote','comment':'original comment'}
        self.error(403,self.service.feedback,'alice','draft',data)
        row=self.service.feedback('admin','draft',data)
        events=self.service.events('admin')
        self.assertEqual('original quote',events['events'][0]['quote'])
        self.assertEqual([],self.service.events('admin',**events['cursor'])['events'])
        data['version_hash']='c'*64
        self.error(409,self.service.feedback,'admin','draft',data)
    def test_asset_stream_bounded_chunks_and_exact_bytes(self):
        payload=b'x'*250000
        self.service.import_draft('stream','Title','body',{'image':('image/png',payload)})
        stream=self.service.asset_stream('admin','stream','image');chunks=list(stream)
        self.assertEqual(payload,b''.join(chunks));self.assertEqual(len(payload),stream.length)
        self.assertLessEqual(max(map(len,chunks)),49152)

if __name__=='__main__':unittest.main()

