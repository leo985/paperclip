import sys
import subprocess
import time
from pathlib import Path
import unittest
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_permit import ExecutionPermit
from pilot import BridgeError


def permit(ttl=60000):
    return {'protocolVersion':1, 'permitId':'fixture-permit', 'validForMs':ttl, 'mode':'observed_cost'}

class ExecutionPermitTest(unittest.TestCase):
    def test_network_time_is_subtracted_and_wall_clock_is_not_used(self):
        clock=Mock(return_value=110.0); guard=ExecutionPermit(terminate=Mock(),clock=clock)
        guard.renew(permit(),100.0)
        self.assertEqual(guard.deadline,160.0)
        clock.return_value=161.0
        with self.assertRaises(BridgeError):guard.check()
        with self.assertRaises(BridgeError):guard.renew(permit(),161.0)

    def test_expired_response_cannot_allow_spawn(self):
        guard=ExecutionPermit(terminate=Mock(),clock=lambda:200.0)
        with self.assertRaises(BridgeError):guard.renew(permit(),100.0)

    def test_permit_identity_and_contract_must_remain_valid(self):
        guard=ExecutionPermit(terminate=Mock(),clock=lambda:100.0)
        guard.renew(permit(),100.0)
        with self.assertRaises(BridgeError):guard.renew({**permit(),'permitId':'changed'},100.0)
        for invalid in [None, {}, permit(0), permit(60001), permit(True)]:
            with self.assertRaises(BridgeError):guard.renew(invalid,100.0)

    def test_watchdog_terminates_real_process_while_caller_is_blocked(self):
        child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],start_new_session=True)
        guard=ExecutionPermit()
        try:
            guard.renew(permit(400),time.monotonic());guard.attach(child);guard.start()
            # wait() simulates a blocking transport call; watchdog is independent.
            child.wait(timeout=4)
            self.assertIsNotNone(child.returncode);self.assertTrue(guard.expired)
        finally:
            guard.close()
            if child.poll() is None:child.kill();child.wait()

    def test_watchdog_retries_transient_stop_failure(self):
        stopped = __import__('threading').Event()
        def terminate(child):
            if not stopped.is_set():
                stopped.set()
                raise OSError('transient stop failure')
        kill = Mock(side_effect=terminate)
        guard=ExecutionPermit(terminate=kill)
        try:
            guard.renew(permit(50),time.monotonic());guard.attach(object());guard.start()
            self.assertTrue(stopped.wait(2))
            deadline=time.monotonic()+2
            while kill.call_count < 2 and time.monotonic() < deadline:time.sleep(.05)
            self.assertGreaterEqual(kill.call_count,2)
            self.assertTrue(guard.expired)
        finally:guard.close()

    def test_expiry_during_spawn_is_detected_at_attach(self):
        clock=Mock(return_value=100.0);terminate=Mock();guard=ExecutionPermit(terminate=terminate,clock=clock)
        guard.renew(permit(),100.0);clock.return_value=161.0
        child=object()
        with self.assertRaises(BridgeError):guard.attach(child)
        terminate.assert_called_with(child)

if __name__=='__main__':unittest.main()
