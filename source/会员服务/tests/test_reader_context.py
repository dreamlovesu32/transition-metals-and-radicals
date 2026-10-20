"""Synthetic coverage for a single live-authorized reader bootstrap request."""
import io
import json
import unittest
from unittest.mock import Mock
from member_service.http import MemberApp, Identity


class ReaderContextTests(unittest.TestCase):
    def app(self, identity=None, admin=False):
        service=Mock()
        service.me.return_value={'admin':admin}
        service.favorites.return_value=[{'article_id':'synthetic-paper'}]
        service.notes.return_value=[{'id':'synthetic-note','quote':'synthetic quote'}]
        service.get_progress.return_value={'revision':2,'position':{'version':1}}
        auth=Mock(configured=True)
        auth.authenticate.return_value=identity
        auth.preauth_csrf.return_value='synthetic-preauth'
        return MemberApp(service,auth),service,auth

    def request(self,app,query='article=synthetic-paper'):
        output=[]
        env={'REQUEST_METHOD':'GET','PATH_INFO':'/api/member/reader-context','QUERY_STRING':query,'wsgi.input':io.BytesIO()}
        raw=b''.join(app(env,lambda status,headers:output.append((int(status.split()[0]),dict(headers)))))
        return *output[0],json.loads(raw)

    def test_one_live_identity_check_binds_library_and_progress_to_same_account(self):
        app,service,auth=self.app(Identity('synthetic-user','reader@example.invalid','synthetic-csrf',True,True))
        status,headers,body=self.request(app)
        self.assertEqual(200,status)
        auth.authenticate.assert_called_once()
        service.favorites.assert_called_once_with('synthetic-user')
        service.notes.assert_called_once_with('synthetic-user',None)
        service.get_progress.assert_called_once_with('synthetic-user','synthetic-paper')
        self.assertEqual('synthetic-user',body['session']['user']['id'])
        self.assertEqual(30000,body['session']['softTtlMs'])
        self.assertIn('no-store',headers['Cache-Control'])
        service.drafts.assert_not_called()

    def test_guest_context_never_reads_any_private_library(self):
        app,service,auth=self.app()
        status,_,body=self.request(app)
        self.assertEqual(200,status)
        self.assertIsNone(body['session']['user'])
        self.assertEqual([],body['notes'])
        self.assertEqual([],body['favorites'])
        service.me.assert_not_called()
        service.notes.assert_not_called()
        service.favorites.assert_not_called()
        service.get_progress.assert_not_called()
        auth.authenticate.assert_called_once()

    def test_admin_status_remains_server_verified_and_inactive_users_cannot_gain_it(self):
        for attested,expected in ((False,'member'),(True,'admin')):
            app,_,_=self.app(Identity('operator','reader@example.invalid','csrf',False,False,attested),admin=True)
            status,_,body=self.request(app)
            self.assertEqual(200,status)
            self.assertEqual(expected,body['session']['user']['role'])

    def test_bad_article_identifier_cannot_be_used_to_read_progress(self):
        app,service,_=self.app(Identity('user','reader@example.invalid','csrf',True,True))
        status,_,_=self.request(app,'article=../private')
        self.assertEqual(400,status)
        service.get_progress.assert_not_called()
