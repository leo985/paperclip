"""Visible terminal handoff keeps the originating seat in multi-seat installs."""
from pathlib import Path
import shlex
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import seat_control


class TerminalSeatConfigTest(unittest.TestCase):
    def setUp(self):
        self.config = Path("/tmp/seat owner's config/config.json").resolve()
        self.bridge = SimpleNamespace(config_path=self.config)
        self.command = {'commandId': '7e27d37a-740c-58c4-bf29-34807df866da'}

    def test_mac_fresh_shell_receives_explicit_seat_config(self):
        with patch.object(seat_control.sys, 'platform', 'darwin'), patch.object(seat_control.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            seat_control.open_terminal(self.bridge, self.command, automatic=True)
        command = shlex.split(run.call_args.args[0][-1])
        self.assertEqual(command[:2], ['env', 'DSP7_BRIDGE_CONFIG='+str(self.config)])
        self.assertEqual(command[-4:], ['seat', 'accept', self.command['commandId'], '--automatic'])

    def test_linux_terminal_server_receives_config_in_command(self):
        with patch.object(seat_control.sys, 'platform', 'linux'), patch.object(seat_control.shutil, 'which', return_value='/usr/bin/gnome-terminal'), patch.object(seat_control.subprocess, 'Popen') as popen:
            seat_control.open_terminal(self.bridge, self.command)
        command = popen.call_args.args[0]
        self.assertEqual(command[2:4], ['env', 'DSP7_BRIDGE_CONFIG='+str(self.config)])
        self.assertEqual(popen.call_args.kwargs['env']['DSP7_BRIDGE_CONFIG'], str(self.config))

    def test_windows_console_receives_originating_config(self):
        with patch.object(seat_control.sys, 'platform', 'win32'), patch.object(seat_control.subprocess, 'CREATE_NEW_CONSOLE', 16, create=True), patch.object(seat_control.subprocess, 'Popen') as popen:
            seat_control.open_terminal(self.bridge, self.command)
        self.assertEqual(popen.call_args.kwargs['env']['DSP7_BRIDGE_CONFIG'], str(self.config))


if __name__ == '__main__':
    unittest.main()
