import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import device_upgrade as device
import seat_profiles

class DeviceUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name);self.bridge=self.home/'bridge';self.bridge.mkdir();(self.bridge/'.bundle-sha256').write_text('a'*64)
        self.first=self.home/'first.json';self.second=self.home/'second.json';self.other=self.home/'other.json'
        for file,agent,server in [(self.first,'seat1','http://same'),(self.second,'seat2','http://same'),(self.other,'seat3','http://other')]:file.write_text(json.dumps({'agent_id':agent,'paperclip_url':server,'company_id':agent}))
        p=patch.object(seat_profiles,'configurations',return_value=[self.first,self.second,self.other]);p.start();self.addCleanup(p.stop)
        p=patch.object(Path,'home',return_value=self.home);p.start();self.addCleanup(p.stop)
    def test_same_server_only_keeps_independent_identities(self):
        self.assertEqual([cfg['agent_id'] for _,cfg in device.targets('http://same/')],['seat1','seat2'])
    def test_preflight_all_before_any_upgrade(self):
        calls=[]
        with patch.object(device,'worker',side_effect=lambda config,bridge,action,no_service:calls.append((config,action))):device.upgrade_all('http://same',self.bridge)
        self.assertEqual(calls,[(self.first,'preflight'),(self.second,'preflight'),(self.first,'upgrade'),(self.second,'upgrade')])
        state=json.loads((self.home/'.local/share/paperclip/device-upgrade.json').read_text());self.assertEqual(state['status'],'installed');self.assertEqual(state['remaining'],[])
    def test_busy_preflight_does_not_upgrade_any_seat(self):
        import subprocess
        def call(config,bridge,action,no_service):
            if config==self.second:raise subprocess.CalledProcessError(2,['preflight'])
        with patch.object(device,'worker',side_effect=call) as worker:
            with self.assertRaises(subprocess.CalledProcessError):device.upgrade_all('http://same',self.bridge)
        self.assertTrue(all(c.args[2]=='preflight' for c in worker.call_args_list))
    def test_partial_failure_records_remaining_and_stops(self):
        import subprocess
        def call(config,bridge,action,no_service):
            if action=='upgrade' and config==self.second:raise subprocess.CalledProcessError(2,['upgrade'])
        with patch.object(device,'worker',side_effect=call):
            with self.assertRaisesRegex(RuntimeError,'剩余 1'):device.upgrade_all('http://same',self.bridge)
        state=json.loads((self.home/'.local/share/paperclip/device-upgrade.json').read_text());self.assertEqual(state['status'],'incomplete');self.assertEqual(state['completed'],['seat1']);self.assertEqual(state['remaining'],['seat2'])
    def test_remote_old_and_new_requests_never_expand_scope(self):
        with patch.dict(os.environ,{},clear=True):self.assertFalse(device.seat_scoped_environment())
        for key,value in [('PAPERCLIP_UPGRADE_SCOPE','seat'),('PAPERCLIP_UPGRADE_TARGET_SHA256','a'*64),('PAPERCLIP_AUTO_UPGRADE_SHA256','b'*64)]:
            with patch.dict(os.environ,{key:value},clear=True):self.assertTrue(device.seat_scoped_environment())
    def test_worker_uses_fresh_process_and_explicit_config(self):
        with patch.object(device.subprocess,'run') as run:device.worker(self.second,self.bridge,'upgrade')
        self.assertEqual(run.call_args.kwargs['env']['DSP7_BRIDGE_CONFIG'],str(self.second));self.assertIn(str(self.second),run.call_args.args[0]);self.assertTrue(run.call_args.kwargs['check'])

    def test_short_heartbeat_lock_is_waited_out(self):
        import seat_upgrade
        with patch('platform_support.fcntl.flock', side_effect=[BlockingIOError(), None]) as flock, patch.object(seat_upgrade.time, 'sleep') as sleep:
            seat_upgrade.acquire_upgrade_lock(object())
        self.assertEqual(flock.call_count, 2); sleep.assert_called_once_with(.2)

    def test_lock_timeout_never_bypasses_protection(self):
        import seat_upgrade
        with patch('platform_support.fcntl.flock', side_effect=BlockingIOError()), patch.object(seat_upgrade.time, 'monotonic', side_effect=[0,21]), patch.object(seat_upgrade.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, '操作锁超时'):seat_upgrade.acquire_upgrade_lock(object())
        sleep.assert_not_called()
