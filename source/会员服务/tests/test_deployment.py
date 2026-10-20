import base64
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from cryptography.fernet import Fernet
from member_service import SQLiteStore,MemberService,MemberApp
from member_service.cloudbase_auth import CloudBaseAuth
from provision_admin import grant_admin_from_sessions,ProvisionRejected
from build_scf_bundle import build,SOURCES,dependency_files,extract_locked_wheels

class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();store=SQLiteStore(Path(self.temp.name)/'db');store.initialize()
        class Auth(CloudBaseAuth):
            user={'sub':'uid','email':'admin@example.org','email_verified':True,'status':'ACTIVE'}
            def _upstream(self,*args,**kwargs):return self.user
        self.auth=Auth(store,'https://example.invalid',Fernet.generate_key(),'env');self.app=MemberApp(MemberService(store),self.auth)
        self.auth._create({}, {'access_token':'never-output','_uid':'uid','_email':'admin@example.org'})
    def tearDown(self):self.temp.cleanup()
    def admins(self):
        with self.app.service.store.transaction() as tx:return tx.all('SELECT uid FROM admins')
    def test_grant_uses_live_identity_without_cookie_export(self):
        grant_admin_from_sessions(self.app,'admin@example.org');self.assertEqual([{'uid':'uid'}],self.admins())
    def test_wrong_email_unverified_disabled_and_uid_mismatch_fail(self):
        for changes in ({'email':'other@example.org'},{'email_verified':False},{'status':'DISABLED'},{'sub':'different'}):
            self.auth.user={**{'sub':'uid','email':'admin@example.org','email_verified':True,'status':'ACTIVE'},**changes}
            with self.assertRaises(ProvisionRejected):grant_admin_from_sessions(self.app,'admin@example.org')
            self.assertEqual([],self.admins())
        with self.assertRaises(ProvisionRejected):grant_admin_from_sessions(self.app,'unknown@example.org')

class BundleTests(unittest.TestCase):
    def test_wheel_hash_and_path_guard(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);wheels=root/'wheels';wheels.mkdir()
            wheel=wheels/'fake-1-py3-none-any.whl'
            with zipfile.ZipFile(wheel,'w') as archive:archive.writestr('../escape.txt','bad')
            lock=root/'lock.json';lock.write_text(json.dumps({wheel.name:hashlib.sha256(wheel.read_bytes()).hexdigest()}))
            with self.assertRaises(ValueError):extract_locked_wheels(wheels,root/'deps',lock)
            self.assertFalse((root/'escape.txt').exists())
            wheel.write_bytes(b'changed')
            with self.assertRaises(ValueError):extract_locked_wheels(wheels,root/'deps',lock)
    def test_source_archive_is_exact_allowlist_and_declares_missing_dependencies(self):
        with tempfile.TemporaryDirectory() as temp:
            output=Path(temp)/'bundle.zip';manifest=build(output)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(set(SOURCES)|{'BUILD-MANIFEST.json'},set(archive.namelist()))
                self.assertTrue(json.loads(archive.read('BUILD-MANIFEST.json'))['source_only'])
                for name in archive.namelist():self.assertFalse(any(x in name for x in ('.private','runtime/','tests/','.env','.pdf')))
            with self.assertRaises(ValueError):build(output)
    def test_windows_dependencies_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);metadata=root/'cryptography.dist-info';metadata.mkdir()
            (metadata/'METADATA').write_text('Name: cryptography\n')
            (metadata/'WHEEL').write_text('Tag: cp310-cp310-win_amd64\n')
            with self.assertRaises(ValueError):dependency_files(root)
    def test_wrong_linux_python_abi_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);metadata=root/'cryptography.dist-info';metadata.mkdir()
            (metadata/'METADATA').write_text('Name: cryptography\n')
            (metadata/'WHEEL').write_text('Tag: cp311-cp311-manylinux_2_28_x86_64\n')
            with self.assertRaises(ValueError):dependency_files(root)

    def fake_dependencies(self,root):
        for name in ('cryptography','psycopg','psycopg-binary'):
            meta=root/(name+'.dist-info');meta.mkdir()
            (meta/'METADATA').write_text('Name: '+name+'\n')
            (meta/'WHEEL').write_text('Tag: py3-none-any\n')
    def test_abi3_from_newer_interpreter_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);metadata=root/'cryptography.dist-info';metadata.mkdir()
            (metadata/'METADATA').write_text('Name: cryptography\n')
            (metadata/'WHEEL').write_text('Tag: cp311-abi3-manylinux_2_28_x86_64\n')
            with self.assertRaises(ValueError):dependency_files(root)
    def test_secret_file_in_dependencies_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);self.fake_dependencies(root);(root/'.env').write_text('FAKE_SECRET=notreal')
            with self.assertRaises(ValueError):dependency_files(root)
    def test_dependency_cannot_replace_allowlisted_handler(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);deps=root/'deps';deps.mkdir();self.fake_dependencies(deps)
            (deps/'scf_handler.py').write_text('# fake replacement')
            with self.assertRaises(ValueError):build(root/'output.zip',deps)
            self.assertFalse((root/'output.zip').exists())

if __name__=='__main__':unittest.main()
