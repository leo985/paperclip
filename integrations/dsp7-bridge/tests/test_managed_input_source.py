"""Provenance must survive collection without treating CLI argv prompts as humans."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from managed_sessions import Collector, register_local, sha

class InputSourceTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        root = Path(tmp.name); cfg = {'database': str(root/'bridge.sqlite3')}
        self.run = '00000000-0000-4000-8000-000000000001'
        register_local(cfg,self.run,'task',root,root/'state.json',root,root/'config.json')
        self.collector = Collector(cfg,self.run); self.addCleanup(self.collector.db.close)
        self.offset = 0

    def parse(self, record):
        self.offset += 1
        record.setdefault('uuid', str(self.offset))
        self.collector.parse_record(record,'main','test',self.offset)
        rows = self.collector.db.execute("SELECT event FROM outbox WHERE run_id=? ORDER BY sequence",(self.run,)).fetchall()
        return [json.loads(r['event'])['payload'] for r in rows]

    def test_harness_skill_and_launch_prompt_override_native_human_marker(self):
        self.collector.setmeta('injected_prompt_sha256',sha('generated prompt'))
        for text, meta in [('generated prompt', {}),('skill text', {'isMeta':True})]:
            events = self.parse(dict(type='user',message={'content':text},origin={'kind':'human'},promptSource='typed',**meta))
            self.assertEqual(events[-1]['inputSource'],'harness')
        events = self.parse({'type':'user','origin':{'kind':'human'},'promptSource':'typed','message':{'content':'actual human'}})
        self.assertEqual(events[-1]['inputSource'],'manual')
        events = self.parse({'type':'user','message':{'content':'old unknown'}})
        self.assertEqual(events[-1]['inputSource'],'unknown')

    def test_missing_launch_evidence_does_not_mislabel_generated_cli_prompt(self):
        events = self.parse({'type':'user','origin':{'kind':'human'},'promptSource':'typed','message':{'content':'generated prompt'}})
        self.assertEqual(events[-1]['inputSource'],'unknown')

    def test_question_options_and_selected_answer_are_preserved_and_redacted(self):
        events = self.parse({'type':'assistant','message':{'content':[{'type':'tool_use','id':'q1','name':'AskUserQuestion','input':{'questions':[{'question':'如何继续？','options':[{'label':'继续'},{'label':'暂停'}]}]}}]}})
        self.assertEqual(events[-1]['name'],'AskUserQuestion')
        events = self.parse({'type':'user','toolUseResult':{'answers':{'如何继续？':'继续','password':'private-value'}},'message':{'content':[{'type':'tool_result','tool_use_id':'q1','content':'User has answered your questions'}]}})
        self.assertEqual(events[-1]['name'],'AskUserQuestion')
        self.assertEqual(events[-1]['inputSource'],'manual')
        self.assertEqual(events[-1]['toolCallId'],'q1')
        parts = [e['data'] for e in events if 'data' in e]
        self.assertIn('继续',''.join(parts)); self.assertNotIn('private-value',''.join(parts))

    def test_nonquestion_results_and_compaction_do_not_become_manual(self):
        events = self.parse({'type':'user','isCompactSummary':True,'message':{'content':'summary'}})
        self.assertEqual(events[-1]['kind'],'compaction'); self.assertNotIn('inputSource',events[-1])
        events = self.parse({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'unknown','content':'result'}]}})
        self.assertNotIn('inputSource',events[-1])

if __name__ == '__main__': unittest.main()
