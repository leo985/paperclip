import sys,unittest,select
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from windows_terminal import ConPtyMaster
class ConPtyTransport(unittest.TestCase):
    def test_output_is_selectable_and_eof_is_preserved(self):
        child=Mock();child.pty.read.side_effect=['中文\n',EOFError()]
        master=ConPtyMaster(child)
        try:
            self.assertEqual(select.select([master],[],[],2)[0],[master])
            self.assertEqual(master.read(1024),'中文\n'.encode())
            self.assertEqual(select.select([master],[],[],2)[0],[master])
            self.assertEqual(master.read(1024),b'')
            master.write('同意'.encode());child.pty.write.assert_called_once_with('同意')
        finally:master.close()
if __name__=='__main__':unittest.main()
