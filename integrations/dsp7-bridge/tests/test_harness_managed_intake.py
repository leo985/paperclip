"""Platform intake must not resolve repositories or mutate business Git trees."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pilot import Bridge, TYPE_WORKFLOW
import jira_intake


class HarnessManagedIntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE pilots (jira_key TEXT, task_id TEXT, config TEXT, enabled INTEGER DEFAULT 0, updated_at TEXT)')
        self.project = '11111111-1111-4111-8111-111111111111'
        self.issue = {'fields': {'summary': 'multi-repo fixture', 'description': 'requirement', 'attachment': [],
                                'issuetype': {'name': '编码'}, 'status': {'name': '编码中'}, 'assignee': {'name': 'dev'}}}
        self.rule = {'projectId': self.project, 'jiraProjectKey': 'TEST', 'readyStatuses': ['编码中'],
                     'issueTypes': ['编码'], 'jiraPatConfigured': True}

    def test_intake_without_platform_repositories_never_runs_git_or_resolves_paths(self):
        request = {'version': 4, 'status_source': 'seat_rule', 'seat_id': 'seat',
                   'jira_key': 'TEST-1', 'project_id': self.project}
        task = {'id': 'task', 'status': 'backlog', 'projectId': self.project,
                'description': '<!-- DSP7-JIRA-INTAKE ' + json.dumps(request) + ' -->'}
        def api(method, path, body=None):
            if path.startswith('/companies/company/issues?'): return [task]
            if path == '/projects/' + self.project:
                return {'id': self.project, 'companyId': 'company', 'workspaces': []}
            if path == '/issues/task': return task
            if path.endswith('/dsp7-jira-intake/authorize'): return {'authorized': True}
            raise AssertionError((method, path))
        b = SimpleNamespace(cfg={'database': str(self.root / 'bridge.sqlite3'), 'web_jira_intake_enabled': True,
                                 'company_id': 'company', 'agent_id': 'seat'},
                            db=self.db, root=self.root, pc=SimpleNamespace(request=api),
                            jira_issue=Mock(return_value=self.issue), register=Mock(),
                            pilot=Mock(return_value={'details': {}}))
        with patch('seats.identity', return_value={'seat_id': 'seat', 'machine_id': 'machine'}), \
             patch('seats.verify_runtime'), patch('seats.reserve') as reserve, \
             patch('seats.seat_api', return_value=b.pc), patch('seats.source_repo') as resolve, \
             patch.object(jira_intake, 'manual_rule', return_value=self.rule), \
             patch.object(jira_intake, 'git') as git, patch.object(jira_intake, 'finish') as finish:
            jira_intake.process_requests(b)
        reserve.assert_called_once_with(b, 'task')
        resolve.assert_not_called()
        git.assert_not_called()
        self.assertIsNone(b.register.call_args.args[2])
        self.assertEqual(b.register.call_args.kwargs['intake']['repository_management'], 'harness')
        self.assertNotIn('workspace_id', b.register.call_args.kwargs['intake'])
        finish.assert_called_once()

    def test_registered_details_delegate_worktrees_without_a_source_directory(self):
        b = Bridge.__new__(Bridge)
        b.root = self.root
        b.db = self.db
        b.jira_issue = Mock(return_value=self.issue)
        b.event = Mock()
        with patch('pilot.subprocess.run') as run:
            b.register('TEST-1', TYPE_WORKFLOW['编码'], None, ['编码中'], intake={
                'task_id': 'task', 'project_id': self.project, 'seat_id': 'seat',
                'machine_id': 'machine', 'repository_management': 'harness', 'seat_rule_intake': True})
        run.assert_not_called()
        details = json.loads(self.db.execute('SELECT config FROM pilots').fetchone()[0])
        self.assertEqual(details['repository_management'], 'harness')
        self.assertIsNone(details['worktree'])
        self.assertNotIn('source_repo', details)
        self.assertNotIn('source_workspace_id', details)

    def test_completion_requires_domain_evidence_without_imposing_one_source_tree(self):
        folder = self.root / 'tickets/feature-TEST-1'
        folder.mkdir(parents=True)
        (folder / 'proof.md').write_text('Harness delivery evidence for multiple repositories')
        (folder / 'tracker-degradation.md').write_text('Approved Harness tracker degradation record')
        b = Bridge.__new__(Bridge)
        b.root = self.root
        b.cfg = {'agent_id': 'seat'}
        b.env = {'PAPERCLIP_RUN_ID': 'run'}
        b.current_pilot = Mock(return_value=({'jira_key': 'TEST-1', 'details': {
            'workflow': 'feature', 'repository_management': 'harness', 'worktree': None,
            'state_path': str(folder / 'state.json')}}, {'id': 'task', 'checkoutRunId': 'run'}))
        b.require_lease = Mock()
        b.state = Mock(return_value={'状态': 'completed'})
        b.jc = SimpleNamespace(current_confirmation=lambda state: None, comment_text=lambda body: body)
        b.event = Mock()
        b.pc = Mock()
        b.jira_config = Mock(return_value=('http://jira.test', 'local-secret'))
        b.jira = Mock(return_value=SimpleNamespace(request=lambda *args: {'id': 'comment', 'body': 'delivery proof'}))
        data = {'summary': 'completed by Harness', 'evidence': ['proof.md'],
                'tracker': {'status': 'allowed_degradation', 'reason': 'approved', 'record_file': 'tracker-degradation.md'},
                'jira_evidence_comment_id': 'comment'}
        with patch('pilot.subprocess.run') as run:
            self.assertEqual(b.agent('complete', data)['status'], 'done')
        run.assert_not_called()
        b.state.return_value = {'状态': 'in_progress'}
        from pilot import BridgeError
        with self.assertRaisesRegex(BridgeError, '尚未 completed'):
            b.agent('complete', data)


if __name__ == '__main__':
    unittest.main()
