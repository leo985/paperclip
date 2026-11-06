"""Platform dispatch chooses the executor independently of Jira assignees."""
import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pilot import Bridge, BridgeError, jira_fingerprint
from jira_intake import manual_rule
from jira_dispatch import authorized


class JiraAssigneePolicyTest(unittest.TestCase):
    def setUp(self):
        self.rule = {'enabled': True, 'jiraPatConfigured': True, 'jiraAssignee': 'zhangzl', 'jiraProjectKey': 'ATSES', 'projectId': 'project', 'workspaceId': 'workspace', 'readyStatuses': ['修复中'], 'issueTypes': ['线上问题']}
        self.issue = {'fields': {'summary': 'fixture', 'description': 'requirement', 'attachment': [], 'issuetype': {'name': '线上问题'}, 'status': {'name': '修复中', 'statusCategory': {'key': 'indeterminate'}}, 'assignee': {'name': 'chenjj1708'}}}
        self.request = {'jira_key': 'ATSES-513404', 'project_id': 'project', 'workspace_id': 'workspace'}

    def test_local_intake_accepts_other_assignees_but_keeps_scope_and_status_gates(self):
        b = Mock()
        with patch('jira_dispatch.rule_for', return_value=self.rule):
            self.assertEqual(manual_rule(b, self.request, self.issue), self.rule)
            for field, value in [('project_id', 'other'), ('jira_key', 'OTHER-1')]:
                with self.subTest(field=field), self.assertRaises(BridgeError):
                    manual_rule(b, {**self.request, field: value}, self.issue)
            bad = copy.deepcopy(self.issue); bad['fields']['status']['name'] = '未允许状态'
            with self.assertRaises(BridgeError):manual_rule(b, self.request, bad)

    def test_registered_pilot_continues_after_reassignment_and_clears_only_obsolete_error(self):
        b = Mock(); b.jira_issue.return_value = self.issue
        details = {'assignee': 'zhangzl', 'source_assignee': 'zhangzl', 'workflow': 'bugfix', 'jira_fingerprint': jira_fingerprint(self.issue), 'ready_statuses': ['修复中']}
        pilot = {'jira_key': 'ATSES-513404', 'details': details, 'last_error': 'Jira 经办人变化，需人工重新登记'}
        # Use the workflow mapping rather than coupling this test to a label.
        from pilot import TYPE_WORKFLOW
        details['workflow'] = TYPE_WORKFLOW['线上问题']
        with patch('seats.check'):
            self.assertEqual(Bridge.validate_jira(b, pilot), self.issue)
            b.update.assert_called_once_with('ATSES-513404', last_error=None)
            b.update.reset_mock()
            changed = copy.deepcopy(self.issue); changed['fields']['description'] = 'changed requirement'
            b.jira_issue.return_value = changed
            with self.assertRaisesRegex(BridgeError, '需求或附件变化'):
                Bridge.validate_jira(b, pilot)
            b.update.assert_not_called()

    def test_platform_queue_authority_does_not_depend_on_assignee(self):
        b = Mock(); b.cfg = {'_platform_dispatches': {'task': 'grant'}}
        p = {'task_id': 'task', 'details': {'platform_dispatch': True, 'assignee': 'chenjj1708', 'project_id': 'project', 'source_workspace_id': 'workspace'}}
        self.assertTrue(authorized(b, p, self.rule))
        self.assertFalse(authorized(b, p, {**self.rule, 'enabled': False}))
        self.assertTrue(authorized(b, p, {**self.rule, 'workspaceId': 'other'}))
        self.assertFalse(authorized(b, p, {**self.rule, 'projectId': 'other'}))
        b.cfg['_platform_dispatches'] = {}
        self.assertFalse(authorized(b, p, self.rule))


if __name__ == '__main__':unittest.main()
