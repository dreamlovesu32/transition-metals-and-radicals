import io,json,tempfile,unittest
from pathlib import Path
from member_service import MemberService,SQLiteStore,ServiceError,MemberApp
from member_service.http import Identity

class FeedbackEditTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.store=SQLiteStore(Path(self.temp.name)/'test.db');self.store.initialize();self.service=MemberService(self.store)
  with self.store.transaction() as tx:
   tx.execute('INSERT INTO admins VALUES (?)',('admin',));tx.execute('INSERT INTO admins VALUES (?)',('other-admin',))
  self.vh=self.service.import_draft('paper','synthetic','{}',{})
  self.feedback=self.service.feedback('admin','paper',{'version_hash':self.vh,'target':{'type':'paragraph','id':'synthetic'},'quote':'quote','comment':'original'})
 def tearDown(self):self.temp.cleanup()
 def data(self,**extra):return dict(version_hash=self.vh,comment='edited',edit_revision=0,**extra)
 def test_edit_preserves_id_original_comment_and_cursor_event(self):
  before=self.service.events('admin');row=self.service.edit_feedback('admin','paper',self.feedback['id'],self.data())
  self.assertEqual(row['id'],self.feedback['id']);self.assertEqual(row['edit_revision'],1)
  with self.store.transaction() as tx:self.assertEqual(tx.one('SELECT comment FROM feedback')['comment'],'original')
  self.assertEqual(self.service.draft('admin','paper')['feedback'][0]['comment'],'edited')
  later=self.service.events('admin',**before['cursor']);self.assertEqual(len(later['events']),1);event=later['events'][0]
  self.assertEqual(event['event_type'],'feedback_edit');self.assertEqual(event['feedback_id'],self.feedback['id']);self.assertNotEqual(event['id'],self.feedback['id']);self.assertEqual(event['version_hash'],self.vh)
  original=self.service.events('admin')['events'][0];self.assertEqual(original,before['events'][0]);self.assertNotIn('feedback_id',original)
 def test_owner_admin_current_version_and_optimistic_revision(self):
  for uid,status in [('member',403),('other-admin',403)]:
   with self.assertRaises(ServiceError) as c:self.service.edit_feedback(uid,'paper',self.feedback['id'],self.data())
   self.assertEqual(c.exception.status,status)
  self.service.edit_feedback('admin','paper',self.feedback['id'],self.data())
  with self.assertRaises(ServiceError) as c:self.service.edit_feedback('admin','paper',self.feedback['id'],self.data())
  self.assertEqual(c.exception.code,'feedback_conflict')
  current=self.service.import_draft('paper','synthetic','new',{})
  with self.assertRaises(ServiceError) as c:self.service.edit_feedback('admin','paper',self.feedback['id'],{'version_hash':self.vh,'comment':'x','edit_revision':1})
  self.assertEqual(c.exception.code,'stale_feedback')
  with self.assertRaises(ServiceError) as c:self.service.edit_feedback('admin','paper',self.feedback['id'],{'version_hash':current,'comment':'x','edit_revision':1})
  self.assertEqual(c.exception.code,'stale_feedback')
 def test_http_requires_session_origin_csrf_and_never_takes_client_uid(self):
  class Auth:
   configured=True
   def authenticate(self,e):return Identity('admin','synthetic@example.invalid','csrf',True,True)
  raw=json.dumps({**self.data(),'uid':'other-admin'}).encode();env={'PATH_INFO':'/api/member/admin/drafts/paper/feedback/'+self.feedback['id'],'REQUEST_METHOD':'PUT','HTTP_ORIGIN':'https://metalradical.xyz','CONTENT_TYPE':'application/json','CONTENT_LENGTH':str(len(raw)),'wsgi.input':io.BytesIO(raw)}
  for app,code in [(MemberApp(self.service),'authentication_required'),(MemberApp(self.service,Auth()),'csrf_rejected')]:
   with self.assertRaises(ServiceError) as c:app.dispatch(env)
   self.assertEqual(c.exception.code,code)
  env['HTTP_X_CSRF_TOKEN']='csrf';result=MemberApp(self.service,Auth()).dispatch(env)[1];self.assertEqual(result['uid'],'admin')

if __name__=='__main__':unittest.main()
