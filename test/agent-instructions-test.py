"""Filesystem integration checks for instruction installation and recovery."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/agent-instructions.py"
SPEC = importlib.util.spec_from_file_location("agent_instructions", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()
        self.target = self.root / "live"
        self.target.mkdir()
        self.old = self.target / "AGENTS.md"
        self.old.write_text("owner rule\n")
        self.old.chmod(0o640)
        self.other = self.target / "keep.md"
        self.other.write_text("unrelated\n")
        self.manifest = self.checkout / "manifest.json"
        self.files = []
        self.add("CODING_STANDARDS.md", "standards\n", None)
        self.add("AGENTS.md", "read standards\n", hashlib.sha256(self.old.read_bytes()).hexdigest())

    def add(self, name, content, expected):
        (self.checkout / name).write_text(content)
        self.files.append({"source": name, "source_sha256": hashlib.sha256(content.encode()).hexdigest(),
                           "target": str(self.target / name), "expected_sha256": expected})
        self.manifest.write_text(json.dumps({"version": 1, "files": self.files}))

    def entries(self):
        return MODULE.load_entries(self.manifest, self.checkout)

    def install(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return MODULE.apply(self.entries(), self.root / "backups")

    def test_apply_and_rollback_preserve_other_files_and_permissions(self):
        backup = self.install()
        self.assertEqual(self.old.read_text(), "read standards\n")
        self.assertEqual(self.old.stat().st_mode & 0o777, 0o640)
        (self.target / "created-later.md").write_text("later\n")
        with contextlib.redirect_stdout(io.StringIO()):
            MODULE.rollback(backup)
        self.assertEqual(self.old.read_text(), "owner rule\n")
        self.assertFalse((self.target / "CODING_STANDARDS.md").exists())
        self.assertEqual(self.other.read_text(), "unrelated\n")
        self.assertTrue((self.target / "created-later.md").exists())

    def test_baseline_drift_stops_before_any_live_write(self):
        self.old.write_text("parallel edit\n")
        with self.assertRaises(MODULE.Conflict):
            self.install()
        self.assertFalse((self.target / "CODING_STANDARDS.md").exists())
        self.assertEqual(self.old.read_text(), "parallel edit\n")

    def test_repeat_install_is_a_noop(self):
        self.install()
        self.assertIsNone(self.install())

    def test_rollback_preserves_later_managed_edits(self):
        backup = self.install()
        self.old.write_text("later owner edit\n")
        with self.assertRaises(MODULE.Conflict):
            MODULE.rollback(backup)
        self.assertEqual(self.old.read_text(), "later owner edit\n")
        self.assertTrue((self.target / "CODING_STANDARDS.md").exists())

    def test_recheck_catches_edit_after_preflight(self):
        original = MODULE.os.replace

        def replace(source, target):
            original(source, target)
            if Path(target) == self.target / "CODING_STANDARDS.md":
                self.old.write_text("concurrent edit\n")

        with patch.object(MODULE.os, "replace", side_effect=replace):
            with self.assertRaises(MODULE.Conflict):
                self.install()
        self.assertEqual(self.old.read_text(), "concurrent edit\n")
        self.assertTrue((self.target / "CODING_STANDARDS.md").exists())
        journals = list((self.root / "backups").glob("*/journal.json"))
        self.assertEqual(len(journals), 1)
        with contextlib.redirect_stdout(io.StringIO()):
            MODULE.rollback(journals[0].parent)
        self.assertEqual(self.old.read_text(), "concurrent edit\n")
        self.assertFalse((self.target / "CODING_STANDARDS.md").exists())

    def test_symlink_target_is_refused(self):
        self.old.unlink()
        self.old.symlink_to(self.other)
        with self.assertRaises(MODULE.Conflict):
            self.install()
        self.assertEqual(self.other.read_text(), "unrelated\n")

    def test_source_cannot_escape_reviewed_checkout(self):
        self.files[0]["source"] = "../outside.md"
        (self.root / "outside.md").write_text("outside\n")
        self.manifest.write_text(json.dumps({"version": 1, "files": self.files}))
        with self.assertRaises(MODULE.Conflict):
            self.entries()

    def test_reviewed_source_modification_is_refused(self):
        (self.checkout / "CODING_STANDARDS.md").write_text("changed after review\n")
        with self.assertRaises(MODULE.Conflict):
            self.entries()

    def test_changed_current_reference_stops_router_activation(self):
        reference = self.target / "CODING_STANDARDS.md"
        reference.write_text("standards\n")
        original = MODULE.save_journal

        def save(backup, journal):
            original(backup, journal)
            reference.write_text("parallel reference edit\n")

        with patch.object(MODULE, "save_journal", side_effect=save):
            with self.assertRaises(MODULE.Conflict):
                self.install()
        self.assertEqual(self.old.read_text(), "owner rule\n")
        self.assertEqual(reference.read_text(), "parallel reference edit\n")

    def test_corrupt_snapshot_blocks_rollback(self):
        backup = self.install()
        (backup / "001.before").write_text("corrupted\n")
        with self.assertRaises(MODULE.Conflict):
            MODULE.rollback(backup)
        self.assertEqual(self.old.read_text(), "read standards\n")

    def test_edit_during_intent_journal_is_preserved(self):
        original = MODULE.save_journal

        def save(backup, journal):
            original(backup, journal)
            if any(item["target"] == str(self.old) and item["applied"]
                   for item in journal["files"]):
                self.old.write_text("edit during journal write\n")

        with patch.object(MODULE, "save_journal", side_effect=save):
            with self.assertRaises(MODULE.Conflict):
                self.install()
        self.assertEqual(self.old.read_text(), "edit during journal write\n")
        self.assertTrue((self.target / "CODING_STANDARDS.md").exists())

    def test_edit_while_staging_restore_is_preserved(self):
        backup = self.install()
        original = MODULE.tempfile.mkstemp

        def temporary(*args, **kwargs):
            result = original(*args, **kwargs)
            if Path(kwargs["dir"]) == self.target:
                self.old.write_text("edit during restore staging\n")
            return result

        with patch.object(MODULE.tempfile, "mkstemp", side_effect=temporary):
            with self.assertRaises(MODULE.Conflict):
                MODULE.rollback(backup)
        self.assertEqual(self.old.read_text(), "edit during restore staging\n")
        self.assertTrue((self.target / "CODING_STANDARDS.md").exists())


if __name__ == "__main__":
    unittest.main()
