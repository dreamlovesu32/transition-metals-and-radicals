import unittest

from member_service.cloud_member_service import CloudMemberService
from member_service.service import ServiceError


class FakeOperations:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def call(self, operation, payload):
        self.calls.append((operation, payload))
        return self.result


class CloudMemberServiceTest(unittest.TestCase):
    def test_list_unwrap_and_identity(self):
        ops = FakeOperations({'items': [{'article_id': 'a', 'created_at': 'now'}]})
        service = CloudMemberService(ops)
        self.assertEqual(service.favorites('trusted-uid'), ops.result['items'])
        self.assertEqual(ops.calls, [('favorites_list', {'uid': 'trusted-uid'})])

    def test_note_hash_matches_existing_service(self):
        ops = FakeOperations({'id': 'saved'})
        service = CloudMemberService(ops)
        data = {'article_id': 'A', 'version_hash': 'a' * 64,
                'anchor': 'p1', 'quote': 'quoted', 'text': 'comment',
                'client_id': 'client-1'}
        self.assertEqual(service.add_note('u', data), {'id': 'saved'})
        operation, payload = ops.calls[0]
        self.assertEqual(operation, 'note_add')
        self.assertEqual(payload['request_hash'],
                         '55da662770f8d7d4cdc69fb8bf1704255ee06c484cb3c1adb88ee5fd47048c6d')

    def test_database_error_becomes_http_error(self):
        service = CloudMemberService(FakeOperations({'error': 'progress_conflict'}))
        with self.assertRaises(ServiceError) as caught:
            service.put_progress('u', 'a', {'version_hash': 'a' * 64,
                                            'revision': 0, 'position': {}})
        self.assertEqual((caught.exception.status, caught.exception.code),
                         (409, 'progress_conflict'))

    def test_invalid_input_never_calls_database(self):
        ops = FakeOperations({})
        service = CloudMemberService(ops)
        with self.assertRaises(ServiceError):
            service.feedback('u', 'draft', {'version_hash': 'a' * 64,
                                           'target': {'type': 'unknown'},
                                           'comment': 'x'})
        self.assertEqual(ops.calls, [])


if __name__ == '__main__':
    unittest.main()
