"""Synthetic tests of source publication boundaries; never call Git or a cloud API."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("source_sync", Path(__file__).with_name("同步网站源码.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SourcePublicationTests(unittest.TestCase):
    def test_exact_allowlist_excludes_private_content_and_operational_bindings(self):
        paths = sync.allowlist()
        self.assertEqual(len(paths), len(set(paths)))
        forbidden = {".private", "runtime", "data", "articles", "figures", "covers", "build", "__pycache__"}
        for name in paths:
            with self.subTest(name=name):
                self.assertFalse(set(Path(name).parts) & forbidden)
                self.assertNotIn("local_demo", name)
                self.assertNotIn("grant_admin_shared", name)
                self.assertNotIn("fixture", name)

    def test_source_audit_rejects_secret_material_and_nonfictional_addresses(self):
        values = ["AKID" + "a" * 20, "-----BEGIN " + "PRIVATE KEY-----", "person" + "@" + "mail.invalid"]
        for value in values:
            with self.assertRaises(ValueError):
                sync.audit("synthetic.py", value.encode())
        sync.audit("synthetic.py", b"user@example.org reader@example.invalid")

    def test_plan_is_read_only_and_apply_copies_verified_allowlist_with_external_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            (repo / ".git").mkdir(parents=True)
            (root / "synthetic.py").write_text("print('synthetic')", encoding="utf-8")
            with patch.object(sync, "ROOT", root), patch.object(sync, "REPOSITORY", repo), patch.object(sync, "allowlist", return_value=["synthetic.py"]):
                planned = sync.synchronize()
                self.assertEqual(planned["mode"], "audit-only")
                self.assertFalse((repo / "source").exists())
                applied = sync.synchronize(True)
                self.assertTrue(applied["verified"])
                self.assertEqual((repo / "source/.gitattributes").read_bytes(), b"* -text\n")
                attribute = next(item for item in applied["manifest"]["files"] if item["path"] == ".gitattributes")
                self.assertEqual(attribute["sha256"], sync.hashlib.sha256(b"* -text\n").hexdigest())
                self.assertEqual((repo / "source/synthetic.py").read_bytes(), (root / "synthetic.py").read_bytes())
                self.assertEqual(sync.synchronize()["changed"], [])
                (root / "synthetic.py").write_text("print('changed')", encoding="utf-8")
                sync.synchronize(True)
                backups = list((root / "记录备份").rglob("synthetic.py"))
                self.assertEqual(len(backups), 1)
                self.assertEqual(backups[0].read_text(), "print('synthetic')")
                self.assertFalse(list(repo.glob("**/记录备份")))

    def test_existing_unlisted_file_is_preserved_and_blocks_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            (repo / ".git").mkdir(parents=True)
            (repo / "source").mkdir()
            unexpected = repo / "source/unlisted.txt"
            unexpected.write_text("untouched")
            (root / "synthetic.py").write_text("synthetic")
            with patch.object(sync, "ROOT", root), patch.object(sync, "REPOSITORY", repo), patch.object(sync, "allowlist", return_value=["synthetic.py"]):
                with self.assertRaises(ValueError):
                    sync.synchronize(True)
            self.assertEqual(unexpected.read_text(), "untouched")
            self.assertFalse((repo / "source/synthetic.py").exists())

    def test_path_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):
                sync.confined(Path(temp), "../escape.py")


if __name__ == "__main__":
    unittest.main()
