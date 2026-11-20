"""Attach cancellation restores the real terminal and does not report a failure."""
import contextlib
import os
from pathlib import Path
import pty
import signal
import socket
import sys
import termios
import threading
import select
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import interactive
from terminal_display import CLEANUP


class TerminalDisconnectTest(unittest.TestCase):
    def exercise(self, failure=None, detach=False):
        master, slave = pty.openpty()
        output = bytearray()
        done = threading.Event()
        def capture():
            while not done.is_set():
                if select.select([master], [], [], .02)[0]:
                    output.extend(os.read(master, 65536))
        reader = threading.Thread(target=capture, daemon=True)
        reader.start()
        before = termios.tcgetattr(slave)
        previous = signal.getsignal(signal.SIGWINCH)
        conn = unittest.mock.Mock()
        conn.recv.return_value = b''
        if failure:
            conn.sendall.side_effect = [None, failure]
        with os.fdopen(os.dup(slave), 'r') as stdin, os.fdopen(os.dup(slave), 'w') as stdout:
            frames = [[stdin] if failure or detach else [conn]]
            def ready(*args):
                # Reports queued by the terminal must never reach the shell.
                os.write(master, b'\x1b[<65;60;36M')
                return frames.pop(0), [], []
            try:
                with patch.object(interactive.sys, 'stdin', stdin), patch.object(interactive.sys, 'stdout', stdout), patch.object(interactive.sys, 'platform', 'linux'), patch.object(interactive.socket, 'socket', return_value=conn), patch.object(interactive, 'socket_path', return_value=Path('/tmp/test-only.sock')), patch.object(interactive.os, 'get_terminal_size', return_value=os.terminal_size((80, 24))), patch.object(interactive, 'select', unittest.mock.Mock(select=ready)), patch.object(interactive, 'os', unittest.mock.Mock(get_terminal_size=lambda: os.terminal_size((80,24)), read=lambda *args: b'\x1d' if detach else b'x')):
                    interactive.attach('test-only')
                self.assertEqual(termios.tcgetattr(slave), before)
                self.assertEqual(signal.getsignal(signal.SIGWINCH), previous)
                self.assertEqual(__import__('select').select([slave], [], [], 0)[0], [])
                __import__('time').sleep(.05)
                done.set();reader.join(timeout=1)
                self.assertIn(CLEANUP, output)
                self.assertIn('终端连接已结束'.encode(), output)
                conn.close.assert_called_once()
            finally:
                done.set();reader.join(timeout=1)
                os.close(master)
                os.close(slave)

    def test_remote_eof_restores_terminal_and_discards_mouse_reports(self):
        self.exercise()

    def test_cancel_racing_input_is_a_clean_disconnect(self):
        for error in (BrokenPipeError(32, 'Broken pipe'), ConnectionResetError(54, 'reset')):
            with self.subTest(error=type(error).__name__):
                self.exercise(error)

    def test_explicit_detach_restores_terminal(self):
        self.exercise(detach=True)

    def test_cleanup_terminates_partial_escape_and_disables_mouse_protocols(self):
        self.assertTrue(CLEANUP.startswith(b'\x18\x1b\\'))
        for mode in (1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016):
            self.assertIn(('\x1b[?%dl' % mode).encode(), CLEANUP)


if __name__ == '__main__':
    unittest.main()
