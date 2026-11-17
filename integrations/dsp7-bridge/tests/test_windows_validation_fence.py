"""Actual Windows process/Job tests; no model, platform, or business files."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from platform_support import process_alive

@unittest.skipUnless(os.name=='nt','Windows Job Object required')
class WindowsValidationFenceTests(unittest.TestCase):
    def test_parent_death_kills_helper_model_and_model_descendant(self):
        helper=Path(__file__).resolve().parents[1]/'harness_validation_process.py'
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)/str(uuid.uuid4());folder.mkdir()
            pidfile=folder/'model.json';helperpid=folder/'helper.pid'
            model=folder/'model.py'
            model.write_text('import os,json,subprocess,sys,time\nfrom pathlib import Path\nchild=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"],close_fds=True)\nPath('+repr(str(pidfile))+').write_text(json.dumps([os.getpid(),child.pid]))\ntime.sleep(30)\n',encoding='utf8')
            supervisor=folder/'supervisor.py'
            command=[str(helper),None,folder.name,str(folder/'process-tree-anchor.json'),sys.executable,str(model)]
            supervisor.write_text('import os,subprocess,sys,time\nfrom pathlib import Path\nargs='+repr(command)+'\nargs[1]=str(os.getpid())\np=subprocess.Popen([sys.executable,*args],close_fds=True)\nPath('+repr(str(helperpid))+').write_text(str(p.pid))\ntime.sleep(30)\n',encoding='utf8')
            parent=subprocess.Popen([sys.executable,str(supervisor)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)
            pids=[]
            try:
                deadline=time.monotonic()+8
                while not pidfile.exists() and time.monotonic()<deadline:time.sleep(.05)
                self.assertTrue(pidfile.exists(),'Child never started under native Job')
                pids=[int(helperpid.read_text()),*json.loads(pidfile.read_text())]
                self.assertTrue(all(process_alive(p) for p in pids))
                parent.kill();parent.wait(timeout=3)
                deadline=time.monotonic()+5
                while any(process_alive(p) for p in pids) and time.monotonic()<deadline:time.sleep(.05)
                self.assertFalse(any(process_alive(p) for p in pids),'Native parent handle/Job failed to fence descendants')
                self.assertFalse((folder/'process-tree-anchor.json').exists(),'Windows must not fabricate a POSIX session anchor')
            finally:
                if parent.poll() is None:parent.kill();parent.wait()
                for pid in pids:
                    if process_alive(pid):subprocess.run(['taskkill','/PID',str(pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    def test_wrong_parent_refuses_before_model_spawn(self):
        helper=Path(__file__).resolve().parents[1]/'harness_validation_process.py'
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)/str(uuid.uuid4());folder.mkdir();marker=folder/'must-not-exist'
            result=subprocess.run([sys.executable,str(helper),str(os.getpid()+100000),folder.name,str(folder/'anchor.json'),sys.executable,'-c','from pathlib import Path;Path('+repr(str(marker))+').touch()'],capture_output=True,timeout=8)
            self.assertNotEqual(result.returncode,0);self.assertFalse(marker.exists())

if __name__=='__main__':unittest.main()
