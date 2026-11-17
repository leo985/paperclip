import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import interactive
from pilot import BridgeError


class CompositionShortcutTests(unittest.TestCase):
    def test_formal_route_cannot_reach_any_legacy_exec(self):
        for route in ('{"protocolVersion":2}', 'invalid-route'):
            with self.subTest(route=route), patch.dict(os.environ, {'DSP7_HARNESS_EXECUTION_ROUTE': route}), \
                    patch('interactive.os.execv') as execute, patch('interactive.subprocess.call') as call:
                with self.assertRaises(BridgeError):
                    interactive.exec_claude('claude', ['--print', 'test'])
                execute.assert_not_called()
                call.assert_not_called()

    def test_unselected_legacy_exec_is_preserved(self):
        with patch.dict(os.environ, {}, clear=True), patch('interactive.WINDOWS', False), \
                patch('interactive.claude_argv', return_value=['claude', '--version']), \
                patch('interactive.os.execv') as execute:
            interactive.exec_claude('claude', ['--version'])
            execute.assert_called_once_with('claude', ['claude', '--version'])


if __name__ == '__main__':
    unittest.main()
