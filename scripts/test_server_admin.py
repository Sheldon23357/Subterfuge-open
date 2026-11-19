import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("server_admin", Path(__file__).with_name("server-admin.py"))
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "rooms"
        self.root.mkdir()

    def room(self, code):
        path = self.root / code
        path.mkdir()
        (path / "room.json").write_text(json.dumps({"code": code}))
        (path / "lifecycle.sqlite").write_bytes(b"database")
        (path / "lifecycle.sqlite-wal").write_bytes(b"pending-wal")
        return path

    def test_only_target_room_moves_and_complete_data_is_preserved(self):
        target = self.room("ABC123")
        sibling = self.room("DEF456")
        archive = admin.archive_room(self.root, Path(self.temp.name) / "backups", "ABC123")
        self.assertFalse(target.exists())
        self.assertTrue(sibling.exists())
        self.assertEqual((archive / "lifecycle.sqlite-wal").read_bytes(), b"pending-wal")

    def test_rejects_path_traversal_and_mismatched_metadata(self):
        self.room("ABC123")
        for code in ("../ABC123", "abc123", "ABC123/", ""):
            with self.assertRaises(ValueError):
                admin.checked_room(self.root, code)
        (self.root / "ABC123" / "room.json").write_text('{"code":"DEF456"}')
        with self.assertRaises(ValueError):
            admin.checked_room(self.root, "ABC123")


if __name__ == "__main__":
    unittest.main()
