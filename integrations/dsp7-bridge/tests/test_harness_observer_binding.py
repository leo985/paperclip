import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from harness_observer_binding import from_env,check_renewal,ENV
from pilot import BridgeError

class ObserverTransportTests(unittest.TestCase):
    def test_absent_attachment_preserves_legacy_permits(self):
        self.assertIsNone(from_env({}))
        check_renewal(None,{'protocolVersion':1})

    def test_invalid_transport_cannot_become_optional(self):
        for raw in ('','null','{','x'*16385):
            with self.assertRaises(BridgeError):from_env({ENV:raw})

    def test_added_removed_or_changed_renewal_attachment_refuses(self):
        attachment={'frozen':'digest'}
        check_renewal(attachment,{'harnessObserver':dict(attachment)})
        for expected,permit in [(None,{'harnessObserver':attachment}),(attachment,{}),
                (attachment,{'harnessObserver':{'frozen':'changed'}})]:
            with self.assertRaises(BridgeError):check_renewal(expected,permit)

if __name__=='__main__':unittest.main()
