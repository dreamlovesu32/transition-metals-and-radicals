"""Data-only registration and shared-plan regressions in an isolated fixture tree."""
from __future__ import annotations

import contextlib
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
import article_config as config
import validate_article as cli
from reader_contract import compile_reading_plan


class ArticleInterfaceTests(unittest.TestCase):
    def test_private_catalog_skips_only_unbuilt_states_and_reports_corruption(self):
        with tempfile.TemporaryDirectory() as temporary:
            missing = Path(temporary) / 'not-built.json'
            built = Path(temporary) / 'built.json'
            built.write_text('{}', encoding='utf-8')
            articles = [{'id': 'unbuilt', 'state': {'zh': missing}}, {'id': 'built', 'state': {'zh': built}, 'cover': built}]
            with patch.object(config, 'load_catalog', return_value=articles), patch.object(config, 'catalog_entry', side_effect=lambda a, cover: {'id': a['id']}), patch('media_assets.dimensions', return_value={'width': 1, 'height': 1}):
                self.assertEqual([a['id'] for a in config.public_catalog()], ['built'])
            with patch.object(config, 'load_catalog', return_value=articles), patch.object(config, 'catalog_entry', side_effect=ValueError('corrupt built state')):
                with self.assertRaisesRegex(ValueError, 'corrupt built state'):
                    config.public_catalog()

    def test_shared_contract(self):
        fixture = json.loads((APP / 'tests/fixtures/reading-contract.json').read_text(encoding='utf-8'))
        for case in fixture['cases']:
            with self.subTest(case=case['name']):
                if case.get('error'):
                    with self.assertRaises(ValueError):
                        compile_reading_plan(case['article'], case['blocks'])
                else:
                    self.assertEqual(compile_reading_plan(case['article'], case['blocks']), case['expected'])

    def test_existing_eight_articles(self):
        found = config.discover_articles()
        self.assertTrue({'paper01', 'r20261017-01', 'r20261017-02', 'r20261017-04', 'r20261017-05',
                         'r20261018-01', 'r20261018-02', 'r20261018-03'}.issubset(found))
        for article_id, path in found.items():
            with self.subTest(article=article_id):
                self.assertEqual(cli.validate(path, existing=True), [])

    def test_data_only_registration_and_failures(self):
        code_hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in (APP / 'article_config.py', APP / 'validate_article.py', APP / 'reader_contract.py')}
        with tempfile.TemporaryDirectory(prefix='read-article-fixture-') as temporary:
            workspace = Path(temporary)
            root = workspace / 'workbench'
            (root / 'articles/fixture-new/figures').mkdir(parents=True)
            (root / 'covers').mkdir()
            (workspace / 'original.pdf').write_bytes(b'%PDF-fixture-only')
            (root / 'covers/fixture-new.png').write_bytes(b'fixture-cover')
            (root / 'articles/fixture-new/figures/one.png').write_bytes(b'fixture-image')
            (root / 'articles/fixture-new/content-zh.md').write_text(
                '# Fixture article\n\n## Results\n\nText\n\n![Figure one](figures/one.png)\n', encoding='utf-8')
            template = json.loads((APP / 'templates/article-manifest.example.json').read_text(encoding='utf-8'))
            template.update(id='fixture-new', readingId='R-FIXTURE-01', displayNumber='01',
                            title={'zh': 'Fixture article', 'en': 'Fixture article'},
                            sourcePdf='original.pdf', sourceUrl='https://doi.org/10.1234/fixture',
                            doi='10.1234/fixture', cover='covers/fixture-new.png',
                            figuresDir='articles/fixture-new/figures', figures=[{'file': 'one.png', 'page': 1}],
                            content={'zh': 'articles/fixture-new/content-zh.md', 'en': 'articles/fixture-new/content-en.md'},
                            state={'zh': 'data/fixture-new/state-zh.json', 'en': 'data/fixture-new/state-en.json'})
            manifest = root / 'articles/fixture-new.json'
            def save():
                manifest.write_text(json.dumps(template), encoding='utf-8')
            save()
            with patch.object(config, 'ROOT', root), patch.object(config, 'WORKSPACE', workspace), patch.object(cli, 'ROOT', root):
                self.assertEqual(cli.validate(manifest), [])
                for label in ('表1（上）', '表1（中）', '表1（下）', '图式42', '图2C（局部）'):
                    template['figures'][0]['sourceLabel'] = label
                    save()
                    self.assertEqual(config.load_manifest(manifest)['figures'][0]['sourceLabel'], label)
                template['figures'][0]['sourceLabel'] = '表1（任意文字）'
                save()
                with self.assertRaisesRegex(ValueError, 'source figure label'):
                    config.load_manifest(manifest)
                template['figures'][0].pop('sourceLabel')
                save()
                template.pop('reviewStatus')
                save()
                self.assertEqual(config.load_article('fixture-new')['reviewStatus'], 'pending')
                self.assertIn('fixture-new', config.CATALOG_IDS)
                self.assertEqual(config.load_article('fixture-new')['id'], 'fixture-new')
                first_plan = cli.plan(manifest)
                self.assertEqual(first_plan['scope'], 'local-private')
                created = cli.build(manifest)
                self.assertEqual(len(created['created']), 1)
                state = root / template['state']['zh']
                saved = state.read_bytes()
                self.assertEqual(cli.plan(manifest), first_plan)
                # Existing state stays authoritative even after its authoring source changes.
                (root / template['content']['zh']).write_text('# Stale source', encoding='utf-8')
                self.assertEqual(cli.validate(manifest, existing=True), [])
                self.assertEqual(cli.build(manifest)['created'], [])
                self.assertEqual(state.read_bytes(), saved)
                template['reading']['switches'] = [{'figureId': first_plan['reading']['switches'][0]['figureId'],
                                                   'trigger': 'block', 'anchorId': 'missing'}]
                save()
                self.assertTrue(any('anchorId' in e for e in cli.validate(manifest, existing=True)))
                with self.assertRaisesRegex(ValueError, 'anchorId'):
                    cli.plan(manifest)
                template['reading']['switches'] = []
                save()
                (root / template['cover']).unlink()
                self.assertTrue(any('Cover missing' in e for e in cli.validate(manifest, existing=True)))
                with self.assertRaisesRegex(ValueError, 'Cover missing'):
                    cli.build(manifest)
                (root / template['figuresDir'] / 'one.png').unlink()
                self.assertTrue(any('Figure missing' in e for e in cli.validate(manifest, existing=True)))
                duplicate = dict(template, id='fixture-second', state={'zh': 'data/second/zh.json', 'en': 'data/second/en.json'})
                (root / 'articles/fixture-second.json').write_text(json.dumps(duplicate), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'Duplicate readingId'):
                    config.discover_articles()
                duplicate['id'] = 'fixture-new'
                (root / 'articles/fixture-second.json').write_text(json.dumps(duplicate), encoding='utf-8')
                with self.assertRaises(ValueError):
                    config.discover_articles()
        self.assertEqual(code_hashes, {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                     for p in (APP / 'article_config.py', APP / 'validate_article.py', APP / 'reader_contract.py')})


if __name__ == '__main__':
    unittest.main()
