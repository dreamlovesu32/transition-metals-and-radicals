import io,json,unittest
from member_service.http import MemberApp,Identity
from member_service.cloud_member_service import CloudMemberService
from member_service.service import ServiceError
class Ops:
 def call(self,name,p):
  self.last=(name,p)
  return {'published':True} if name=='draft_publish' else {'items':[]}
class Auth:
 configured=True
 def authenticate(self,e):return Identity('admin','a@b.c','token',True,True)
class Tests(unittest.TestCase):
 def test_publish_validates_version_before_db(self):
  s=CloudMemberService(Ops())
  with self.assertRaises(ServiceError):s.publish('admin','paper',{'version_hash':'wrong'})
 def test_payload_cannot_choose_uid(self):
  o=Ops();s=CloudMemberService(o);s.publish('real','paper',{'version_hash':'a'*64,'uid':'forged'})
  self.assertEqual(o.last,('draft_publish',{'uid':'real','draft_id':'paper','version_hash':'a'*64}))
 def test_public_does_not_authenticate(self):
  class NoAuth:
   configured=True
   def authenticate(self,e):raise AssertionError('public endpoint invoked auth')
  app=MemberApp(CloudMemberService(Ops()),NoAuth())
  self.assertEqual(app.dispatch({'PATH_INFO':'/api/member/public/articles'})[1],{'items':[]})
 def test_publish_requires_session_and_csrf(self):
  path='/api/member/admin/drafts/paper/publish'
  with self.assertRaises(ServiceError) as c:MemberApp(CloudMemberService(Ops())).dispatch({'PATH_INFO':path,'REQUEST_METHOD':'POST'})
  self.assertEqual(c.exception.status,401)
  app=MemberApp(CloudMemberService(Ops()),Auth())
  with self.assertRaises(ServiceError) as c:app.dispatch({'PATH_INFO':path,'REQUEST_METHOD':'POST','HTTP_ORIGIN':'https://metalradical.xyz'})
  self.assertEqual(c.exception.code,'csrf_rejected')
 def test_publish_route(self):
  raw=json.dumps({'version_hash':'a'*64}).encode()
  result=MemberApp(CloudMemberService(Ops()),Auth()).dispatch({'PATH_INFO':'/api/member/admin/drafts/paper/publish','REQUEST_METHOD':'POST','HTTP_ORIGIN':'https://metalradical.xyz','HTTP_X_CSRF_TOKEN':'token','CONTENT_TYPE':'application/json','CONTENT_LENGTH':str(len(raw)),'wsgi.input':io.BytesIO(raw)})
  self.assertTrue(result[1]['published'])
