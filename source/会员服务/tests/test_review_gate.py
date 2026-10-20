import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import verify_review as gate

HASH = 'a' * 64
OTHER = 'b' * 64


def review(rid='review-1', decision='approved', value=HASH, at='2026-10-18T08:00:00+00:00'):
    return {'id': rid, 'uid': 'verified-admin', 'draft_id': 'paper', 'version_hash': value, 'decision': decision, 'created_at': at}


class ReviewGateTests(unittest.TestCase):
    def reject(self, reason, local=HASH, online=HASH, rows=None):
        with self.assertRaises(gate.GateRejected) as error:
            gate.validate_review('paper', local, online, [review()] if rows is None else rows)
        self.assertEqual(reason, str(error.exception))

    def test_matching_approval_records_identity_and_exact_bundle(self):
        result = gate.validate_review('paper', HASH, HASH, [review()])
        self.assertTrue(result['approved'])
        self.assertEqual('verified-admin', result['reviewer_uid'])
        self.assertEqual('review-1', result['review_id'])
        self.assertEqual(HASH, result['review_version_sha256'])

    def test_newer_request_changes_overrides_old_approval(self):
        self.reject('latest_review_requests_changes', rows=[review(), review('review-2', 'changes_requested', at='2026-10-18T09:00:00Z')])

    def test_latest_other_version_never_searches_for_older_matching_approval(self):
        self.reject('latest_approval_is_for_another_version', rows=[review(), review('review-2', value=OTHER, at='2026-10-18T09:00:00Z')])

    def test_online_content_change_invalidates_previous_local_approval(self):
        self.reject('online_draft_differs_from_current_local_content', online=OTHER)

    def test_local_content_or_image_change_invalidates_approval(self):
        self.reject('online_draft_differs_from_current_local_content', local=OTHER)

    def test_no_review_is_rejected(self):
        self.reject('no_review', rows=[])

    def test_equivalent_timezone_times_with_conflicting_outcomes_are_ambiguous(self):
        self.reject('ambiguous_latest_review_time', rows=[review(), review('review-2', 'changes_requested', at='2026-10-18T16:00:00+08:00')])

    def test_same_timestamp_same_outcome_uses_deterministic_id(self):
        result = gate.validate_review('paper', HASH, HASH, [review('a'), review('z')])
        self.assertEqual('z', result['review_id'])

    def test_unknown_time_or_article_identity_rejected(self):
        self.reject('invalid_review_time', rows=[review(at='2026-10-18T08:00:00')])
        self.reject('review_article_mismatch', rows=[{**review(), 'draft_id': 'other'}])

    def test_sql_adapter_only_reads_trusted_schema_and_uses_parameters(self):
        calls = []
        class Cursor:
            def fetchone(self): return {'id': 'paper', 'version_hash': HASH}
            def fetchmany(self, count):
                self_count = count
                assert self_count == 10001
                return [review()]
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def execute(self, query, params=()):
                calls.append((query, params))
                return Cursor()
        result = gate.fetch_database_snapshot('private-test-dsn', ['paper'], connector=lambda _: Connection())
        self.assertEqual('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', calls[0][0])
        self.assertTrue(all(query.startswith('SELECT ') for query, _ in calls[1:]))
        self.assertTrue(all(params == ('paper',) for _, params in calls[1:]))
        self.assertEqual(HASH, result['paper']['version_hash'])

    @patch("verify_review.load_private_env", lambda: None)
    def test_no_dsn_fails_before_any_database_or_local_read(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(gate, 'fetch_database_snapshot') as sql, patch.object(gate, 'local_bundle') as local, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(2, gate.main(['--article', 'paper', '--report', 'unused.json']))
            sql.assert_not_called()
            local.assert_not_called()

    @patch("verify_review.load_private_env", lambda: None)
    def test_cli_report_does_not_mutate_status_or_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'evidence.json'
            with patch.dict(os.environ, {'READ_MEMBER_DATABASE_DSN': 'private-test-dsn'}), patch.object(gate, 'local_bundle', return_value={'bundle_hash': HASH, 'revision': 3}), patch.object(gate, 'fetch_database_snapshot', return_value={'paper': {'version_hash': HASH, 'reviews': [review()]}}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, gate.main(['--article', 'paper', '--report', str(output)]))
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertTrue(report['all_approved'])
            self.assertEqual('review-1', report['checks'][0]['review_id'])
            self.assertIn('Does not authorize', report['scope'])
            self.assertNotIn('private-test-dsn', output.read_text(encoding='utf-8'))

    @patch("verify_review.load_private_env", lambda: None)
    def test_local_change_during_check_refuses_report(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'evidence.json'
            with patch.dict(os.environ, {'READ_MEMBER_DATABASE_DSN': 'private-test-dsn'}), patch.object(gate, 'local_bundle', side_effect=[{'bundle_hash': HASH, 'revision': 3}, {'bundle_hash': OTHER, 'revision': 4}]), patch.object(gate, 'fetch_database_snapshot', return_value={'paper': {'version_hash': HASH, 'reviews': [review()]}}), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(2, gate.main(['--article', 'paper', '--report', str(output)]))
            self.assertFalse(output.exists())


if __name__ == '__main__': unittest.main()
