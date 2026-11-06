"""Interrupted outbound upgrades recover without a transport migration ID."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import pilot
import seat_upgrade
import quick_install
import platform_support


class UpgradeRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name).resolve()
        self.runtime=self.home/'.config/paperclip-dsp7-bridge';self.runtime.mkdir(parents=True)
        self.config=self.runtime/'config.json';self.marker=self.runtime/'upgrade-in-progress.json'
        self.root=self.home/'harness';self.root.mkdir()
        self.old,self.new,self.latest=[self.home/n for n in ('old','new','latest')]
        for p in (self.old,self.new,self.latest):
            p.mkdir();(p/'.bundle-sha256').write_text(p.name)
        self.bin=self.home/'appdata/ZhiyanSeat/bin/harness.cmd';self.bin.parent.mkdir(parents=True)
        self.cfg={'agent_id':'seat-one','execution_transport':'outbound','database':str(self.runtime/'bridge.db'),
                  'harness_root':str(self.root),'quick_setup':{'bridge':str(self.old)}}
        self.config.write_text(json.dumps(self.cfg));self.local=self.root/'.harness-local.json'
        self.local.write_text(json.dumps({'paperclipBridgeRoot':str(self.old)}));self.bin.write_text(str(self.old))
        self.backup=self.runtime/'upgrade-backups/original';self.backup.mkdir(parents=True)
        self.paths=[self.config,self.local,self.bin]
        for i,p in enumerate(self.paths):(self.backup/str(i)).write_bytes(p.read_bytes())
        (self.backup/'files.json').write_text(json.dumps({str(p):str(i) for i,p in enumerate(self.paths)}))
        (self.backup/'links.json').write_text('{}')
        (self.backup/'modes.json').write_text(json.dumps({str(p):0o600 for p in self.paths}))
        (self.backup/'scheduled-task.xml').write_text('<task/>')
        self.pending={'oldBridge':str(self.old),'newBridge':str(self.new),'backup':str(self.backup),
                      'migrationId':None,'agentId':'seat-one','noService':False}
        self.write_pending();self.task=self.old;self.fail_install=False;self.fail_stop_new=False
        self.service_calls=[];self.installations=[]

    def write_pending(self):self.marker.write_text(json.dumps(self.pending))

    def service(self,script,bridge,alternative_bridge=None):
        self.service_calls.append(script)
        if self.task and self.task not in (bridge,alternative_bridge):raise RuntimeError('Unknown seat task')
        if self.task and 'Stop-ScheduledTask' in script:
            if self.fail_stop_new and self.task==self.new:raise RuntimeError('cannot stop service')
            self.task=None
        return SimpleNamespace(stdout=('exists' if self.task else ''))

    def run_service(self,args,**kwargs):
        entry=Path(args[1]);self.assertEqual(entry.name,'install_service.py')
        self.installations.append(entry.parent);self.task=entry.parent
        if self.fail_install:raise subprocess.CalledProcessError(1,args)
        return SimpleNamespace(stdout='',returncode=0)

    def cli(self,root,bridge,previous_bridge=None):
        self.assertEqual(root,self.root)
        self.assertIn(self.bin.read_text(),(str(bridge),str(previous_bridge)))
        self.bin.write_text(str(bridge))

    def private_folder(self,path):
        path=Path(path);path.mkdir(parents=True,exist_ok=True);return path

    @contextlib.contextmanager
    def context(self,busy=False):
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(Path,'home',return_value=self.home))
            stack.enter_context(patch.object(platform_support,'private_directory',side_effect=self.private_folder))
            stack.enter_context(patch.dict(os.environ,LOCALAPPDATA=str(self.home/'appdata')))
            stack.enter_context(patch.object(sys,'platform','win32'))
            stack.enter_context(patch.object(pilot,'Bridge',side_effect=lambda c:SimpleNamespace(cfg=pilot.read_json(c),config_path=c)))
            stack.enter_context(patch.object(quick_install,'secure_bundle_directory'))
            idle=stack.enter_context(patch.object(seat_upgrade,'assert_idle',side_effect=RuntimeError('busy') if busy else None))
            migration=stack.enter_context(patch.object(seat_upgrade,'migration_request',side_effect=AssertionError('No transport migration for outbound update')))
            stack.enter_context(patch.object(seat_upgrade,'windows_service',side_effect=self.service))
            stack.enter_context(patch.object(seat_upgrade.subprocess,'run',side_effect=self.run_service))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            yield migration,idle

    def perform(self,target=None):
        seat_upgrade.upgrade(self.config,self.root,self.old,target or self.new,install_cli=self.cli,agent_id='seat-one')

    def test_outbound_update_with_null_migration_id_resumes_same_seat(self):
        with self.context() as (migration,_):self.perform();migration.assert_not_called()
        self.assertFalse(self.marker.exists());self.assertEqual(self.task,self.new)
        cfg=pilot.read_json(self.config)
        self.assertEqual(cfg['agent_id'],'seat-one');self.assertEqual(cfg['quick_setup']['bridge'],str(self.new))
        self.assertEqual(pilot.read_json(self.runtime/'bridge-version.json')['bridge'],str(self.new))

    def test_recovery_accepts_known_new_task_and_launcher(self):
        self.task=self.new;self.bin.write_text(str(self.new))
        self.cfg['quick_setup']['bridge']=str(self.new);self.config.write_text(json.dumps(self.cfg))
        with self.context():self.perform()
        self.assertFalse(self.marker.exists());self.assertEqual(self.task,self.new)

    def test_recovery_completes_original_then_upgrades_to_latest(self):
        with self.context():self.perform(self.latest)
        self.assertEqual(self.installations,[self.new,self.latest]);self.assertEqual(self.task,self.latest)
        self.assertFalse(self.marker.exists())
        self.assertEqual(pilot.read_json(self.config)['quick_setup']['bridge'],str(self.latest))

    def test_recovery_does_not_stop_busy_work(self):
        with self.context(busy=True),self.assertRaisesRegex(RuntimeError,'busy'):self.perform()
        self.assertTrue(self.marker.exists());self.assertEqual(self.service_calls,[])

    def test_recovery_rejects_unknown_service_without_overwriting(self):
        self.task=self.home/'other'
        before=self.config.read_bytes()
        with self.context(),self.assertRaisesRegex(RuntimeError,'Unknown seat task'):self.perform()
        self.assertTrue(self.marker.exists());self.assertEqual(self.config.read_bytes(),before)

    def test_ssh_pending_without_migration_id_is_rejected(self):
        self.cfg['execution_transport']='ssh';self.config.write_text(json.dumps(self.cfg))
        with self.context(),self.assertRaisesRegex(RuntimeError,'缺少迁移编号'):self.perform()
        self.assertTrue(self.marker.exists());self.assertEqual(self.service_calls,[])

    def test_wrong_seat_pending_is_not_recovered(self):
        self.pending['agentId']='another-seat';self.write_pending()
        with self.context(),self.assertRaisesRegex(RuntimeError,'未结束的升级记录'):self.perform()
        self.assertTrue(self.marker.exists());self.assertEqual(self.service_calls,[])

    def test_failed_stop_retains_record_and_next_retry_recovers(self):
        self.fail_install=True;self.fail_stop_new=True
        with self.context(),self.assertRaisesRegex(RuntimeError,'新版接入服务停止失败'):self.perform()
        self.assertTrue(self.marker.exists())
        self.fail_install=False;self.fail_stop_new=False
        with self.context():self.perform()
        self.assertFalse(self.marker.exists());self.assertEqual(self.task,self.new)


if __name__=='__main__':unittest.main()
