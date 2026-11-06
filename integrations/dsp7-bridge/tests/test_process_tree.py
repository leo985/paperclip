import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from process_tree import ProcessTree
from platform_support import WINDOWS
from pilot import BridgeError

@unittest.skipIf(WINDOWS,'POSIX session subprocess integration; Windows job tested on Windows')
class ProcessTreeTest(unittest.TestCase):
    def test_kills_child_after_launcher_has_already_exited_and_preserves_unrelated_process(self):
        unrelated=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
        with tempfile.TemporaryDirectory() as tmp:
            marker=Path(tmp)/'ready'
            code="import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);open(sys.argv[1],'w').write(str(p.pid))"
            launcher=subprocess.Popen([sys.executable,'-c',code,str(marker)],start_new_session=True)
            tree=ProcessTree('fixture');tree.attach(launcher)
            try:
                launcher.wait(timeout=5)
                self.assertTrue(tree.members(),'descendant remains after launcher exits')
                tree.stop();proof=tree.proof()
                self.assertEqual(proof['remaining'],0);self.assertEqual(proof['observations'],2)
                self.assertIsNone(unrelated.poll())
            finally:
                tree.stop();unrelated.kill();unrelated.wait()

    def test_explicit_pty_session_anchor_is_also_stopped(self):
        with tempfile.TemporaryDirectory() as tmp:
            anchor=Path(tmp)/'anchor.json'
            child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
            tree=ProcessTree('run',anchor);tree.attach(None)
            anchor.write_text(json.dumps({'runId':'run','supervisorPid':os.getpid(),'sessionId':child.pid}))
            try:
                self.assertIn(child.pid,tree.members());tree.stop();child.wait(timeout=3);self.assertEqual(tree.proof()['remaining'],0)
            finally:
                if child.poll() is None:child.kill();child.wait()

    def test_inspection_failure_or_invalid_anchor_never_proves_stop(self):
        tree=ProcessTree('run');tree.attach(None)
        with patch('process_tree.posix_members',side_effect=OSError('unknown')):
            with self.assertRaises(OSError):tree.proof()
        with tempfile.TemporaryDirectory() as tmp:
            anchor=Path(tmp)/'anchor.json';anchor.write_text(json.dumps({'runId':'other','supervisorPid':os.getpid(),'sessionId':99}))
            tree=ProcessTree('run',anchor);tree.attach(None)
            with self.assertRaises(BridgeError):tree.proof()
