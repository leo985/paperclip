import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import analysis_qingzhou as q
from pilot import BridgeError


class ClientCollectionTest(unittest.TestCase):
    def test_native_client_logs_in_and_archives_bound_task_without_secret_output(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);scripts=root/'harness/scripts';scripts.mkdir(parents=True)
            (scripts/'analysis.py').write_text('')
            (scripts/'qingzhou_sources.py').write_text('''
class Client:
    def __init__(self,**kw):self.token='';self.seen=None
    def login(self,c):
        assert c=={'username':'user','password':'sensitive'}
        self.token='private-token'
def collect(folder,demand,client):
    assert demand=='TWGF-00919'
    assert client.token=='private-token'
    return {'status':'complete','files':[{}],'errors':[]}
''')
            rt=SimpleNamespace(root=root,folder=root/'task',_assert_binding=Mock())
            response={'demandNo':'TWGF-00919','seatAccountRevision':3,'credentials':{'username':'user','password':'sensitive'}}
            context={'execution':{'demandNo':'TWGF-00919'}}
            with patch.object(q,'runtime_for',return_value=rt),patch.object(q,'api_call',return_value=response) as api:
                result=q.collect(Mock(),context)
            self.assertEqual(result['files'],1);self.assertEqual(result['status'],'complete')
            self.assertNotIn('credentials',response);self.assertNotIn('sensitive',json.dumps(result));self.assertNotIn('private-token',json.dumps(result))
            self.assertEqual(api.call_args.args[2],'qingzhou-credentials');self.assertEqual(api.call_args.kwargs,{'demandNo':'TWGF-00919'})

    def test_missing_demand_and_foreign_response_never_collect(self):
        with patch.object(q,'api_call') as api,self.assertRaises(BridgeError):q.collect(Mock(),{'execution':{}})
        api.assert_not_called()
        rt=SimpleNamespace(_assert_binding=Mock())
        with patch.object(q,'runtime_for',return_value=rt),patch.object(q,'api_call',return_value={'demandNo':'OTHER-1'}),self.assertRaises(BridgeError):
            q.collect(Mock(),{'execution':{'demandNo':'TWGF-00919'}})

    def test_root_verification_failure_precedes_credentials(self):
        with patch.object(q,'runtime_for',side_effect=BridgeError('changed')),patch.object(q,'api_call') as api,self.assertRaises(BridgeError):
            q.collect(Mock(),{'execution':{'demandNo':'TWGF-00919'}})
        api.assert_not_called()

    def test_cli_does_not_print_vault_or_upstream_errors(self):
        with patch.object(sys,'argv',['collector','--context','/context']),patch.object(q,'read_json',return_value={'configPath':'/cfg'}),patch.object(q,'Bridge'),patch.object(q,'collect',side_effect=ValueError('private-password-token')):
            out=io.StringIO();err=io.StringIO()
            with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):self.assertEqual(q.main(),1)
            self.assertEqual(out.getvalue(),'');self.assertNotIn('private-password-token',err.getvalue())


if __name__=='__main__':unittest.main()
