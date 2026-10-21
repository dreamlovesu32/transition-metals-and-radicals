"""Private preview discovery: built states remain accountable, unfinished inputs wait."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('review_preview', Path(__file__).with_name('构建审稿预览.py'))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class PreviewDiscoveryTests(unittest.TestCase):
    def test_unbuilt_manifest_does_not_block_another_completed_article(self):
        with tempfile.TemporaryDirectory() as temporary:
            built = Path(temporary)/'built.json'
            built.write_text('{"blocks": []}', encoding='utf-8')
            rows = [{'id':'built','state':{'zh':built}}, {'id':'awaiting-build','state':{'zh':Path(temporary)/'missing.json'}}]
            with patch.object(preview,'load_catalog',return_value=rows), patch.object(preview,'CATALOG_IDS',['built','awaiting-build']):
                self.assertEqual(preview.preview_articles(), [rows[0]])

    def test_existing_corrupt_state_is_retained_for_explicit_json_diagnostic(self):
        with tempfile.TemporaryDirectory() as temporary:
            corrupt = Path(temporary)/'corrupt.json'
            corrupt.write_text('{bad json', encoding='utf-8')
            rows = [{'id':'corrupt','state':{'zh':corrupt}}]
            with patch.object(preview,'load_catalog',return_value=rows), patch.object(preview,'CATALOG_IDS',['corrupt']):
                self.assertEqual(preview.preview_articles(), rows)
                with self.assertRaises(json.JSONDecodeError):
                    json.loads(preview.preview_articles()[0]['state']['zh'].read_text(encoding='utf-8'))

    def test_catalog_mismatch_still_fails(self):
        with patch.object(preview,'load_catalog',return_value=[]), patch.object(preview,'CATALOG_IDS',['registered']):
            with self.assertRaisesRegex(RuntimeError,'Unexpected review catalog'):
                preview.preview_articles()


if __name__ == '__main__':
    unittest.main()
