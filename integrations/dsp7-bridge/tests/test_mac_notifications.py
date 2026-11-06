import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch,Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import mac_notifications as notices

TASK='11111111-1111-4111-8111-111111111111'
RUN='22222222-2222-4222-8222-222222222222'
class NotificationClickTest(unittest.TestCase):
    def setUp(self):
        self.viewer_patch=patch.object(notices,'viewer_ttys',return_value=[]);self.viewer_patch.start();self.addCleanup(self.viewer_patch.stop)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.config=self.root/'config.json'
        self.config.write_text(json.dumps({'database':str(self.root/'bridge.sqlite3'),'paperclip_url':'http://example.test:3100'}))
        self.folder=self.root/'interactive/runs'/RUN;self.folder.mkdir(parents=True)
        self.info={'run_id':RUN,'task_id':TASK,'status':'running'};self.save()
    def save(self):(self.folder/'session.json').write_text(json.dumps(self.info))
    def test_click_focuses_matching_live_terminal_without_starting_run(self):
        with patch.object(notices,'terminal_ttys',return_value=['/dev/ttys001']),patch.object(notices,'focus_terminal',return_value=True) as focus,patch.object(notices.subprocess,'run') as run:
            self.assertEqual(notices.open_target(self.config,TASK,RUN),'terminal');focus.assert_called_once_with('/dev/ttys001');run.assert_not_called()
    def test_stale_foreign_and_missing_windows_open_web_instead(self):
        for state in ['exited','foreign','closed','missing']:
            self.info.update(status='exited' if state=='exited' else 'running',task_id=TASK if state!='foreign' else RUN);self.save()
            with patch.object(notices,'terminal_ttys',return_value=[] if state=='missing' else ['/dev/ttys002']),patch.object(notices,'focus_terminal',return_value=False),patch.object(notices.subprocess,'run') as run:
                self.assertEqual(notices.open_target(self.config,TASK,RUN),'web')
                run.assert_called_once_with(['/usr/bin/open','http://example.test:3100/DSP/issues/'+TASK],check=True,timeout=10)
    def test_ps_matches_exact_attach_arguments_not_prompt(self):
        output=f'ttys001 python /bridge/interactive.py attach {RUN}\nttys002 claude --prompt interactive.py attach {RUN}\nttys003 python /bridge/interactive.py attach {TASK}\n'
        with patch.object(notices.subprocess,'run',return_value=Mock(stdout=output)):
            self.assertEqual(notices.terminal_ttys(RUN),['/dev/ttys001'])
    def test_finished_run_does_not_focus_stale_window(self):
        (self.folder/'summary.json').write_text('{}')
        with patch.object(notices,'terminal_ttys') as ttys,patch.object(notices.subprocess,'run'):
            self.assertEqual(notices.open_target(self.config,TASK,RUN),'web');ttys.assert_not_called()
    def test_no_script_editor_fallback(self):
        with patch.object(notices,'notifier',return_value=None),patch.object(notices.subprocess,'run',return_value=Mock(returncode=0)) as run:
            self.assertEqual(notices.notify('title','body'),'submitted_without_click_action')
            self.assertIn('tell application "System Events"',run.call_args.args[0][2])
    def test_viewer_marker_rejects_reused_pid(self):
        marker=self.root/'viewer.json';marker.write_text(json.dumps({'pid':123,'tty':'/dev/ttys014','started':'original'}))
        self.viewer_patch.stop()
        with patch.object(notices,'viewer_path',return_value=marker),patch.object(notices.subprocess,'check_output',side_effect=['different','ttys014']):
            self.assertEqual(notices.viewer_ttys(RUN),[])
    def test_viewer_marker_locates_seat_accept_terminal(self):
        marker=self.root/'viewer.json';marker.write_text(json.dumps({'pid':123,'tty':'/dev/ttys014','started':'original'}))
        self.viewer_patch.stop()
        with patch.object(notices,'viewer_path',return_value=marker),patch.object(notices.subprocess,'check_output',side_effect=['original','ttys014']):
            self.assertEqual(notices.viewer_ttys(RUN),['/dev/ttys014'])
    def test_shell_quoted_callback_carries_exact_scope(self):
        import shlex
        with patch.object(notices,'notifier',return_value='/tool'),patch.object(notices.subprocess,'run',return_value=Mock(returncode=0)) as run:
            notices.notify('title','body',config=self.root/"a ' file.json",task_id=TASK,run_id=RUN)
            args=run.call_args.args[0];action=shlex.split(args[args.index('-execute')+1])
            self.assertEqual(action[3],str(self.root/"a ' file.json"));self.assertEqual(action[-4:],['--task',TASK,'--run',RUN])
if __name__=='__main__':unittest.main()
