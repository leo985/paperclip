"""One OS account must never reuse another organization's seat identity."""
import json
import os
import plistlib
import runpy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import seat_profiles as profiles
import quick_install

class ProfilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.home=Path(self.tmp.name).resolve()
        self.hp=patch.object(Path,'home',return_value=self.home);self.hp.start();self.addCleanup(self.hp.stop)
        self.env=patch.dict(os.environ);self.env.start();self.addCleanup(self.env.stop)
        os.environ.pop('DSP7_BRIDGE_CONFIG',None)
        self.a='11111111-1111-4111-8111-111111111111';self.b='22222222-2222-4222-8222-222222222222'
    def write(self,path,company,agent,name):
        path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps({'company_id':company,'agent_id':agent,'company_name':name,'paperclip_url':'http://test'}))
    def test_second_organization_gets_separate_config_and_service(self):
        first=profiles.default_config();self.write(first,self.a,'seat-a','DSP7')
        original=first.read_bytes();second=profiles.select_config('http://test',self.b)
        self.assertNotEqual(first,second);self.write(second,self.b,'seat-b','基础平台')
        default_label=profiles.service_label();profiles.activate(second)
        self.assertNotEqual(default_label,profiles.service_label());self.assertEqual(first.read_bytes(),original)
        self.assertEqual(profiles.select_config('http://test',self.a),first)
        self.assertEqual(profiles.select_config('http://test',self.b),second)
    def test_explicit_other_company_is_rejected_without_writing(self):
        path=profiles.default_config();self.write(path,self.a,'seat-a','DSP7');before=path.read_bytes()
        with self.assertRaisesRegex(RuntimeError,'其他组织'):profiles.select_config('http://test',self.b,path)
        self.assertEqual(path.read_bytes(),before)
    def test_server_is_part_of_identity(self):
        self.assertNotEqual(profiles.organization_config('http://one',self.b),profiles.organization_config('http://two',self.b))
        with self.assertRaises(ValueError):profiles.organization_config('http://test','../other')
    def test_command_routes_to_named_company_and_browser_seat(self):
        self.write(profiles.default_config(),self.a,'seat-a','DSP7')
        second=profiles.organization_config('http://test',self.b);self.write(second,self.b,'seat-b','基础平台')
        self.assertEqual(profiles.route_cli(['--company','基础平台','doctor']),['doctor']);self.assertEqual(profiles.config_path(),second)
        self.assertEqual(profiles.route_cli(['capability','register','--seat-id','seat-a']),['capability','register','--seat-id','seat-a'])
        self.assertEqual(profiles.config_path(),profiles.default_config())
        with self.assertRaisesRegex(RuntimeError,'唯一'):profiles.route_cli(['--company','missing','online'])
    def test_profile_launcher_does_not_replace_default(self):
        first=profiles.default_config();self.write(first,self.a,'seat-a','DSP7')
        second=profiles.organization_config('http://test',self.b);self.write(second,self.b,'seat-b','基础平台');profiles.activate(second)
        binroot=self.home/'.local/bin';binroot.mkdir(parents=True);default=binroot/'harness';default.write_text('preserve existing default')
        with patch.object(sys,'platform','linux'):quick_install.install_cli(self.home,self.home/'bridge')
        self.assertEqual(default.read_text(),'preserve existing default')
        script=(binroot/profiles.cli_name()).read_text();self.assertIn('env DSP7_BRIDGE_CONFIG=',script);self.assertIn(str(second),script)
    def test_named_login_service_preserves_default_and_passes_config(self):
        first=profiles.default_config();self.write(first,self.a,'seat-a','DSP7')
        second=profiles.organization_config('http://test',self.b);self.write(second,self.b,'seat-b','基础平台');profiles.activate(second)
        directory=self.home/'Library/LaunchAgents';directory.mkdir(parents=True)
        default=directory/'com.leo.paperclip-dsp7-bridge.plist';default.write_bytes(b'original service')
        runner=Mock(return_value=Mock(returncode=1))
        with patch('subprocess.run',runner),patch.object(os,'getuid',return_value=1000,create=True):
            runpy.run_path(str(Path(quick_install.__file__).parent/'install_launchagent.py'))
        self.assertEqual(default.read_bytes(),b'original service')
        value=plistlib.loads((directory/(profiles.service_label()+'.plist')).read_bytes())
        self.assertEqual(value['EnvironmentVariables']['DSP7_BRIDGE_CONFIG'],str(second))
        self.assertEqual(value['StandardOutPath'],str(second.parent/'watch.log'))
        self.assertTrue(all('com.leo.paperclip-dsp7-bridge' not in str(call.args[0]) or profiles.service_label() in str(call.args[0]) for call in runner.call_args_list))
    def test_upgrade_targets_selected_service_only(self):
        import seat_upgrade
        second=profiles.organization_config('http://test',self.b);profiles.activate(second)
        with patch.object(sys,'platform','darwin'):
            self.assertEqual(seat_upgrade.service_file().name,profiles.service_label()+'.plist')
        with patch.object(sys,'platform','linux'):
            self.assertEqual(seat_upgrade.service_file().name,'paperclip-dsp7-bridge'+profiles.service_suffix()+'.service')

    def test_windows_profile_launcher_preserves_default_and_binds_config(self):
        second=profiles.organization_config('http://test',self.b);profiles.activate(second)
        os.environ['LOCALAPPDATA']=str(self.home/'AppData')
        binroot=self.home/'AppData/ZhiyanSeat/bin';binroot.mkdir(parents=True)
        default=binroot/'harness.cmd';default.write_bytes(b'original Windows command')
        with patch.object(sys,'platform','win32'),patch('platform_support.powershell'):
            quick_install.install_cli(self.home,self.home/'bridge')
        launcher=binroot/(profiles.cli_name()+'.cmd')
        self.assertEqual(default.read_bytes(),b'original Windows command')
        self.assertIn('set "DSP7_BRIDGE_CONFIG='+str(second)+'"',launcher.read_text())
        self.assertIn(str(self.home/'bridge/harness_entry.py'),launcher.read_text())

    def test_windows_task_names_and_arguments_isolate_profile(self):
        import install_service
        root=self.home/'bridge';root.mkdir();(root/'pythonw.exe').touch()
        default_args=profiles.windows_watch_arguments(root)
        calls=[]
        def execute(script,**kwargs):
            calls.append((script,kwargs['env']))
            return Mock(stdout=json.dumps(dict(exists=False,matches=False,enabled=False,running=False)))
        second=profiles.organization_config('http://test',self.b);profiles.activate(second)
        install_service.install_windows_service(root,root/'python.exe',execute)
        for script,env in calls:
            self.assertEqual(env['PAPERCLIP_TASK_SUFFIX'],profiles.service_suffix())
            self.assertIn('$user+$env:PAPERCLIP_TASK_SUFFIX',script)
            self.assertEqual(env['PAPERCLIP_WATCH_ARGUMENTS'],default_args+' --config "'+str(second)+'"')
        profiles.activate(profiles.default_config())
        self.assertEqual(profiles.service_suffix(),'')
        self.assertEqual(profiles.windows_watch_arguments(root),default_args)

    def test_windows_upgrade_looks_up_only_selected_task_and_config(self):
        import seat_upgrade
        second=profiles.organization_config('http://test',self.b);profiles.activate(second)
        with patch('platform_support.powershell') as run:
            seat_upgrade.windows_service('Write-Output exists',self.home/'old',self.home/'new')
        script=run.call_args.args[0];env=run.call_args.kwargs['env']
        self.assertIn('+$env:PAPERCLIP_TASK_SUFFIX',script)
        self.assertEqual(env['PAPERCLIP_TASK_SUFFIX'],profiles.service_suffix())
        self.assertIn('--config "'+str(second)+'"',env['PAPERCLIP_OLD_ARGUMENTS'])
        self.assertIn(str(self.home/'new/watch_windows.py'),env['PAPERCLIP_ALT_ARGUMENTS'])

    def test_profile_bridge_receipt_takes_priority_over_shared_harness_default(self):
        root=self.home/'harness';root.mkdir()
        (root/'.harness-local.json').write_text(json.dumps({'paperclipBridgeRoot':str(self.home/'default-bridge')}))
        bridge=self.home/'profile-bridge';bridge.mkdir()
        for name in ('pilot.py','seats.py'):(bridge/name).touch()
        self.assertEqual(quick_install.existing_bridge(root,{'quick_setup':{'bridge':str(bridge)}}),bridge)

if __name__=='__main__':unittest.main()
