#!/usr/bin/env python3
"""Run a declared Harness phase gate set and emit verifiable domain events.

Contracts live in the versioned Harness repository; a model-provided phase label
or arbitrary successful shell command cannot substitute for the declared gates.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from managed_sessions import dump,now

def main():
    from pilot import Bridge,BridgeError
    p=argparse.ArgumentParser();p.add_argument('--contract',type=Path,required=True);p.add_argument('--phase',required=True);p.add_argument('--reopen',action='store_true')
    args=p.parse_args();b=Bridge(agent=True);pilot,task=b.current_pilot();b.require_lease(pilot)
    root=b.root.resolve();contract=args.contract.resolve()
    if not contract.is_relative_to(root) or contract.is_symlink() or not contract.is_file():raise BridgeError('门禁契约必须来自 Harness 仓库')
    relative=str(contract.relative_to(root))
    tracked=subprocess.run(['git','-C',str(root),'ls-files','--error-unmatch','--',relative],capture_output=True,timeout=20)
    if tracked.returncode:raise BridgeError('门禁契约必须受 Git 管理')
    head=subprocess.run(['git','-C',str(root),'show','HEAD:'+relative],capture_output=True,timeout=20)
    if head.returncode or head.stdout!=contract.read_bytes():raise BridgeError('门禁契约有未提交修改，请先评审并提交版本')
    data=json.loads(contract.read_text());phase=data.get('phases',{}).get(args.phase)
    if data.get('version')!=1 or not isinstance(phase,dict) or not phase.get('checks'):raise BridgeError('未定义完整阶段门禁，不推断阶段完成')
    state=Path(pilot['details']['state_path']).resolve();directory=state.parent;events=directory/'platform-events.jsonl'
    version=hashlib.sha256(contract.read_bytes()).hexdigest();gate_evidence=[]
    def emit(status,evidence):
        value={'type':'phase','runId':b.env['PAPERCLIP_RUN_ID'],'phase':args.phase,'status':status,'gateVersion':version,'flowVersion':data.get('flowVersion',version),'evidence':evidence,'at':now()}
        fd=os.open(events,os.O_CREAT|os.O_APPEND|os.O_WRONLY,0o600)
        try:os.write(fd,(dump(value)+'\n').encode())
        finally:os.close(fd)
    emit('reopened' if args.reopen else 'started',[])
    for check in phase['checks']:
        script=(root/check['script']).resolve()
        if not script.is_relative_to(root/'harness'/'scripts') or script.suffix!='.py' or not script.is_file():raise BridgeError('门禁脚本必须在 Harness scripts 内')
        script_head=subprocess.run(['git','-C',str(root),'show','HEAD:'+str(script.relative_to(root))],capture_output=True,timeout=20)
        if script_head.returncode or script_head.stdout!=script.read_bytes():raise BridgeError('门禁脚本未提交或与已提交版本不一致')
        argv=[str(v).replace('{ticket_dir}',str(directory)).replace('{state}',str(state)).replace('{phase}',args.phase) for v in check.get('args',[])]
        # No shell evaluation and no command supplied by conversation content.
        try:
            outcome=subprocess.run([sys.executable,str(script),*argv],cwd=root,env=dict(os.environ),timeout=max(1,min(3600,int(check.get('timeout',300)))))
            exit_code=outcome.returncode
        except subprocess.TimeoutExpired:exit_code=124
        item={'script':str(script.relative_to(root)),'scriptSha256':hashlib.sha256(script.read_bytes()).hexdigest(),'exitCode':exit_code}
        gate_evidence.append(item)
        if exit_code:emit('failed',gate_evidence);return exit_code
    emit('passed',gate_evidence)
    print('阶段门禁通过：'+args.phase+'；完整门禁集版本 '+version)
    return 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as exc:print('阶段门禁未完成：'+str(exc),file=sys.stderr);sys.exit(2)
