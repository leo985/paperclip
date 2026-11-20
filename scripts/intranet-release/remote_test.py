import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import remote as deployment


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        home = Path(directory.name)
        self.stage = home / "private" / "test-001"
        self.stage.mkdir(parents=True)
        self.root = home / "runtime" / "node_modules"
        self.ui = self.root / deployment.UI
        assets = self.ui / "assets"
        assets.mkdir(parents=True)
        (home / "server.env").write_text("test")
        for name in deployment.PROTECTED:
            (self.ui / name).write_text("preserved")
        (self.ui / "index.html").write_text('<script type="module" src="/assets/main.js"></script>')
        (self.ui / "sw.js").write_text('const BUILD_ID = "before";')
        (assets / "main.js").write_text('import "./component.js";')
        (assets / "component.js").write_text('export const marker = "before";')
        for name, value in {"STAGE": self.stage, "HOME": home, "ROOT": self.root}.items():
            mock = patch.object(deployment, name, value)
            mock.start()
            self.addCleanup(mock.stop)

    def prepare(self):
        deployment.write("request.json", {"backend": [], "ui": [["export const marker"]]})
        deployment.scan()
        inputs = self.stage / "inputs"
        inputs.mkdir()
        (inputs / "ui-0.js").write_text('export const marker = "after";')
        deployment.prepare()
        return deployment.read("manifest.json")

    def test_rewrites_transitive_imports_and_preserves_previous_files(self):
        manifest = self.prepare()
        self.assertEqual(len(manifest["hashes"]), 4)
        index = (self.stage / "payload" / deployment.UI / "index.html").read_text()
        root_import = deployment.REFERENCE.findall(index)[0]
        main = (self.stage / "payload" / deployment.UI / "assets" / root_import).read_text()
        child_import = deployment.REFERENCE.findall(main)[0]
        child = (self.stage / "payload" / deployment.UI / "assets" / child_import).read_text()
        self.assertIn('"after"', child)
        self.assertEqual((self.ui / "assets/component.js").read_text(), 'export const marker = "before";')

    def test_rejects_changed_online_baseline(self):
        manifest = self.prepare()
        (self.ui / "index.html").write_text("newer version")
        with self.assertRaisesRegex(ValueError, "Online baseline changed"):
            deployment.deploy_locked(manifest["hashes"], manifest["installed"])
        self.assertFalse((self.stage / "backup").exists())

    def test_failed_verification_restores_entry_and_removes_new_assets(self):
        manifest = self.prepare()
        index = self.ui / "index.html"
        old_index = index.read_bytes()
        old_worker = (self.ui / "sw.js").read_bytes()

        def verify(item):
            name, expected = item
            if expected == manifest["hashes"].get(name):
                raise RuntimeError("Injected HTTP mismatch")
            self.assertEqual(hashlib.sha256((self.root / name).read_bytes()).hexdigest(), expected)

        with patch.object(deployment, "healthy", return_value=True), patch.object(deployment, "main_pid", return_value=123), patch.object(deployment, "verify_http", side_effect=verify):
            with self.assertRaisesRegex(RuntimeError, "original version restored"):
                deployment.deploy_locked(manifest["hashes"], manifest["installed"])
        self.assertEqual(index.read_bytes(), old_index)
        self.assertEqual((self.ui / "sw.js").read_bytes(), old_worker)
        self.assertTrue(deployment.read("rollback.json")["restored"])
        self.assertEqual(len(list((self.ui / "assets").iterdir())), 2)


    def test_no_changes_records_receipt_without_touching_service(self):
        deployment.write("manifest.json", {"hashes": {}, "installed": {}})
        with patch.object(deployment, "restart") as restart:
            deployment.worker()
        restart.assert_not_called()
        self.assertEqual(deployment.read("job.json")["receipt"]["status"], "unchanged")


if __name__ == "__main__":
    unittest.main()
