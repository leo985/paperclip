"""Retry authorization reaches the existing visible-terminal execution path."""
import contextlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import uuid
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import seat_control
import jira_dispatch

class RetryStartupTest(unittest.TestCase):
    def test_new_authorization_clears_old_error_and_accept_invokes_real_start(self):
        with tempfile.TemporaryDirectory() as temp,contextlib.ExitStack() as stack:
            b=Mock();b.cfg={'database':str(Path(temp)/'bridge.sqlite3'),'agent_id':str(uuid.uuid4()),'seat_runtime':{'revision':1}}
            b.db=sqlite3.connect(b.cfg['database']);b.db.row_factory=sqlite3.Row;stack.callback(b.db.close)
            b.db.execute('CREATE TABLE pilots(jira_key TEXT,task_id TEXT,config TEXT,last_error TEXT)')
            task=str(uuid.uuid4());command={'commandId':str(uuid.uuid4()),'taskId':task,'kind':'start','revision':1}
            details={'platform_dispatch':True,'jira_dispatch':True,'platform_authorization_id':'original'}
            b.db.execute('INSERT INTO pilots VALUES(?,?,?,?)',('TEST-1',task,json.dumps(details),'执行中断'))
            api=Mock();api.request.return_value={'tasks':[{'taskId':task,'authorizationId':'one-retry'}]}
            stack.enter_context(patch('jira_dispatch.identity',return_value={}));stack.enter_context(patch('jira_dispatch.rule_for',return_value={'enabled':True}));stack.enter_context(patch('jira_dispatch.seat_api',return_value=api))
            jira_dispatch.tick(b)
            row=b.db.execute('SELECT * FROM pilots').fetchone();self.assertIsNone(row['last_error'])
            updated=json.loads(row['config']);self.assertEqual(updated['platform_authorization_id'],'one-retry')
            p={'task_id':task,'jira_key':'TEST-1','details':updated};b.pilot.return_value=p
            seat_control.setup(b)
            b.db.execute('INSERT INTO seat_commands(command_id,payload,status,updated_at) VALUES(?,?,?,?)',(command['commandId'],json.dumps(command),'awaiting_local','now'));b.db.commit()
            api.request.return_value={'adapterConfig':{'dsp7JiraDispatch':{'enabled':True}}}
            stack.enter_context(patch('seat_control.seat_api',return_value=api));stack.enter_context(patch('seat_control.sys.stdin.isatty',return_value=True));stack.enter_context(patch('seat_control.sys.stdout.isatty',return_value=True))
            verify=stack.enter_context(patch('jira_dispatch.verify'));receipt=stack.enter_context(patch('seat_control.receipt'));stack.enter_context(patch('seat_control.verify_runtime'))
            start=stack.enter_context(patch('interactive.start'))
            seat_control.accept(b,command['commandId'],automatic=True)
            verify.assert_called_once_with(b,task,start=True)
            self.assertEqual(receipt.call_args.args[2],'accepted')
            start.assert_called_once_with(b,'TEST-1',True,seat_command=command)

if __name__=='__main__':unittest.main()
