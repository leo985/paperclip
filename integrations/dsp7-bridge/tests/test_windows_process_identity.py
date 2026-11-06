import sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import platform_support as ps
class WindowsProcessIdentity(unittest.TestCase):
    def test_conpty_requires_actual_executable_image(self):
        with patch.object(ps,'WINDOWS',True),patch.object(ps,'windows_argv',return_value=['','--session-id','test']),patch.object(ps,'claude_argv',return_value=['/native/claude.exe']):
            self.assertTrue(ps.matches_claude('command','registered','/native/claude.exe'))
            self.assertFalse(ps.matches_claude('command','registered','/other/claude.exe'))
            self.assertFalse(ps.matches_claude('command','registered'))
    def test_script_entry_must_still_match(self):
        with patch.object(ps,'WINDOWS',True),patch.object(ps,'windows_argv',return_value=['','/wrong/cli.js','--session-id','test']),patch.object(ps,'claude_argv',return_value=['/node.exe','/official/cli.js']):
            self.assertFalse(ps.matches_claude('command','registered','/node.exe'))
if __name__=='__main__':unittest.main()
