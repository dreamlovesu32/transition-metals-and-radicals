import json
import unittest
from member_service.cloudbase_pg import (
    operation_sql, decode_result, CloudPGOperations, CloudPGError,
    CloudPGOutcomeUnknown,
)


def response(value):
    return {'Columns': ['result'], 'Rows': [json.dumps([json.dumps(value)])]}


class CloudPGTests(unittest.TestCase):
    def test_json_is_encoded_not_interpolated(self):
        value = {'quote': "'); DROP TABLE admins; --\\\n中文", 'uid': 'u'}
        sql = operation_sql('note_add', value)
        self.assertNotIn('DROP TABLE', sql)
        hex_data = sql.split("decode('", 1)[1].split("'", 1)[0]
        self.assertEqual(json.loads(bytes.fromhex(hex_data)), value)

    def test_no_arbitrary_sql_or_identifier(self):
        for op in ('SELECT 1', 'note_add;DROP', 'initialize', 'grant_admin'):
            with self.assertRaises(ValueError): operation_sql(op, {})

    def test_invalid_payloads(self):
        for payload in ([], {'x': float('nan')}, {'x': '\x00'}, {'x': 'a'*262145}):
            with self.assertRaises(ValueError): operation_sql('note_add', payload)

    def test_result(self):
        value = {'ok': True, 'revision': 2, 'notes': []}
        self.assertEqual(decode_result(response(value)), value)

    def test_reject_unexpected_results(self):
        for data in ({}, {'Columns':['other'],'Rows':[]},
                     {'Columns':['result'],'Rows':[]},
                     {'Columns':['result'],'Rows':['[null]']},
                     {'Columns':['result'],'Rows':['not-json']}, response([])):
            with self.assertRaises(CloudPGError): decode_result(data)

    def test_do_not_leak_upstream_error(self):
        with self.assertRaises(CloudPGError) as got:
            decode_result({'Error': {'Message': 'secret password'}})
        self.assertNotIn('secret', str(got.exception))

    def test_one_call_explicit_role(self):
        calls = []
        def api(req):
            calls.append(req)
            return response({'ok': True})
        client = CloudPGOperations(api, 'test-env')
        self.assertEqual(client.call('member_me', {'uid':'u'}), {'ok':True})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['Role'], 'service_role')

    def test_uncertain_write_never_retried(self):
        calls = []
        def api(req):
            calls.append(req)
            raise TimeoutError('secret payload')
        client = CloudPGOperations(api, 'test-env')
        with self.assertRaises(CloudPGOutcomeUnknown) as got:
            client.call('note_add', {'client_id':'stable-id'})
        self.assertEqual(len(calls), 1)
        self.assertNotIn('secret', str(got.exception))

    def test_invalid_env_or_role(self):
        with self.assertRaises(ValueError): CloudPGOperations(None, "bad'env")
        with self.assertRaises(ValueError): CloudPGOperations(None, 'env', '')


if __name__ == '__main__': unittest.main()
