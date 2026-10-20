import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from member_service import runtime
from member_service.cloud_member_service import CloudMemberService
from member_service.cloudbase_shared_auth import CloudBaseSharedAuth


class RuntimeFactoryTests(unittest.TestCase):
    def test_warm_instance_refreshes_runtime_identity_for_each_operation(self):
        seen = []
        def factory():
            token = os.environ['TENCENTCLOUD_SESSIONTOKEN']
            def execute(payload):
                seen.append(token)
                return {'Columns':['result'],'Rows':['["{}"]']}
            return execute
        with patch.dict(os.environ, {'READ_MEMBER_ENV_ID':'example-env',
                                     'TENCENTCLOUD_SESSIONTOKEN':'first'}, clear=True), \
             patch.object(runtime, '_scf_sdk_caller', side_effect=factory):
            operations = runtime._cloudbase_operations()
            operations.call('member_me', {})
            os.environ['TENCENTCLOUD_SESSIONTOKEN'] = 'rotated'
            operations.call('member_me', {})
        self.assertEqual(seen, ['first', 'rotated'])

    def test_cloudbase_mode_uses_shared_adapters_without_dsn(self):
        operations = object()
        env = {'READ_MEMBER_MODE': 'cloudbase', 'READ_MEMBER_AUTH_ENABLED': '1',
               'READ_MEMBER_AUTH_ORIGIN': 'https://auth.example.org',
               'READ_MEMBER_SESSION_KEY': 'x' * 44,
               'READ_MEMBER_ENV_ID': 'example-env'}
        from cryptography.fernet import Fernet
        env['READ_MEMBER_SESSION_KEY'] = Fernet.generate_key().decode()
        with patch.dict(os.environ, env, clear=True), patch.object(runtime, '_cloudbase_operations', return_value=operations):
            app = runtime.create_app()
        self.assertIsInstance(app.service, CloudMemberService)
        self.assertIsInstance(app.auth, CloudBaseSharedAuth)
        self.assertIs(app.service.operations, operations)
        self.assertIs(app.auth.store, operations)

    def test_direct_and_development_modes_remain_distinct(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.dict(os.environ, {'READ_MEMBER_MODE': 'development',
                                        'READ_MEMBER_SQLITE_PATH': str(Path(temp) / 'db'),
                                        'READ_MEMBER_AUTH_ENABLED': '0'}, clear=True):
                self.assertNotIsInstance(runtime.create_app().service, CloudMemberService)
        with patch.dict(os.environ, {'READ_MEMBER_MODE': 'production',
                                    'READ_MEMBER_AUTH_ENABLED': '0'}, clear=True):
            with self.assertRaises(KeyError):
                runtime.create_app()

    def test_cloudbase_rejects_missing_scf_identity(self):
        with patch.dict(os.environ, {'READ_MEMBER_MODE': 'cloudbase',
                                    'READ_MEMBER_ENV_ID': 'example-env'}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'SCF temporary credentials required'):
                runtime.create_app()


if __name__ == '__main__':
    unittest.main()
