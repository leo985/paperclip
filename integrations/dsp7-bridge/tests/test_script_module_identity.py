"""The installed script and imported helpers must share exception identities."""
import pathlib
import subprocess
import sys
import unittest


class ScriptModuleIdentityTests(unittest.TestCase):
    def test_direct_entrypoint_shares_bridge_error_with_seat_control(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        code = '''
import runpy, sys
sys.path.insert(0, sys.argv[1])
script = sys.argv[1] + '/pilot.py'
sys.argv = [script, '--help']
try:
    runpy.run_path(script, run_name='__main__')
except SystemExit as error:
    assert error.code == 0
import pilot, seat_control
assert pilot.__name__ == '__main__', 'entrypoint loaded twice'
assert seat_control.BridgeError is pilot.BridgeError
try:
    raise pilot.BridgeError('API GET /issues/old-task HTTP 403')
except seat_control.BridgeError:
    pass
'''
        result = subprocess.run([sys.executable, '-c', code, str(root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
