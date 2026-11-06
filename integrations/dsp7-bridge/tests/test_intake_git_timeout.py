import sys,unittest,subprocess
from pathlib import Path
from unittest.mock import patch,Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import jira_intake
import interactive
class GitSafety(unittest.TestCase):
 def test_timeout_terminates_tree_without_communicate(self):
  child=Mock();child.wait.side_effect=subprocess.TimeoutExpired('git',90)
  with patch('jira_intake.subprocess.Popen',return_value=child) as spawn,patch('platform_support.terminate_tree') as terminate:
   with self.assertRaisesRegex(ValueError,'Git 操作超时'):jira_intake.git(Path('/tmp'),'status')
   terminate.assert_called_once_with(child);child.communicate.assert_not_called()
   self.assertEqual(spawn.call_args.kwargs['env']['GIT_TERMINAL_PROMPT'],'0')
   self.assertNotEqual(spawn.call_args.kwargs['stdout'],subprocess.PIPE)
 def test_success_reads_output_file(self):
  def launch(*args,**kw):
   kw['stdout'].write(b'branch\n');return Mock(returncode=0)
  with patch('jira_intake.subprocess.Popen',side_effect=launch):self.assertEqual(jira_intake.git('/tmp','status'),'branch')
class SnapshotSafety(unittest.TestCase):
 def test_observation_timeout_stays_unknown_and_never_blocks_on_pipes(self):
  child=Mock();child.wait.side_effect=subprocess.TimeoutExpired('git',3)
  with patch('interactive.subprocess.Popen',return_value=child),patch('interactive.terminate_tree') as stop:
   value=interactive.git_snapshot(Path('/tmp'))
   self.assertEqual(value['observation_status'],'partial')
   self.assertIsNone(value['dirty']);self.assertIsNone(value['tracked_diff_sha256']);self.assertIsNone(value['knowledge_markdown_sha256'])
   self.assertEqual(stop.call_count,4);child.communicate.assert_not_called()
if __name__=='__main__':unittest.main()
