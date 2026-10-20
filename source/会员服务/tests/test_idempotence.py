import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from member_service import MemberService,SQLiteStore,ServiceError

class NoteIdempotenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.store=SQLiteStore(Path(self.temp.name)/'test.db');self.store.initialize();self.service=MemberService(self.store)
        with self.store.transaction() as tx:tx.execute('INSERT INTO articles VALUES (?,?,?)',('paper','a'*64,1))
        self.data={'client_id':'stable-client-id','article_id':'paper','version_hash':'a'*64,'anchor':'p1','quote':'quote','text':''}
    def tearDown(self):self.temp.cleanup()
    def test_retry_and_restart_return_same_note(self):
        first=self.service.add_note('alice',self.data)
        second=MemberService(SQLiteStore(self.store.path)).add_note('alice',self.data)
        self.assertEqual(first,second);self.assertEqual(1,len(self.service.notes('alice',None)));self.assertEqual('stable-client-id',self.service.notes('alice',None)[0]['client_id'])
    def test_client_id_does_not_select_owner(self):
        first=self.service.add_note('alice',{**self.data,'uid':'bob'})
        second=self.service.add_note('bob',self.data)
        self.assertNotEqual(first['id'],second['id']);self.assertEqual(1,len(self.service.notes('alice',None)));self.assertEqual(1,len(self.service.notes('bob',None)))
    def test_changed_payload_with_same_id_rejected(self):
        self.service.add_note('alice',self.data)
        with self.assertRaises(ServiceError) as error:self.service.add_note('alice',{**self.data,'text':'changed'})
        self.assertEqual('idempotency_conflict',error.exception.code);self.assertEqual(1,len(self.service.notes('alice',None)))
    def test_concurrent_retries_insert_once(self):
        with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(lambda _:self.service.add_note('alice',self.data),range(8)))
        self.assertEqual(1,len({n['id'] for n in results}));self.assertEqual(1,len(self.service.notes('alice',None)))
    def test_deleted_note_not_resurrected_by_delayed_retry(self):
        first=self.service.add_note('alice',self.data);self.service.delete_note('alice',first['id'])
        with self.assertRaises(ServiceError) as error:self.service.add_note('alice',self.data)
        self.assertEqual('note_deleted',error.exception.code);self.assertEqual([],self.service.notes('alice',None))
if __name__=='__main__':unittest.main()
