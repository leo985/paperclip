#!/usr/bin/env python3
"""Local interactive terminal broker for an authentic Paperclip Claude run."""
from __future__ import annotations
import argparse
import base64
import contextlib
from platform_support import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import shlex
import signal
import socket
import struct
import subprocess
import sys
import time
import uuid

from pilot import Bridge, BridgeError, DEFAULT_CONFIG, ACTIVE, atomic_json, now, read_json
from platform_support import WINDOWS, private_directory, claude_argv, terminate_tree
if not WINDOWS:
    import pty
    import termios
    import tty

REAL_CLAUDE='/usr/local/bin/claude'


def private_dir(path):
    if WINDOWS:return private_directory(path)
    path=Path(path)
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    st=path.lstat()
    if path.is_symlink() or not path.is_dir() or st.st_uid!=os.getuid():
        raise BridgeError('终端目录归属异常')
    os.chmod(path,0o700)
    return path


def socket_path(run_id):
    if WINDOWS:
        from windows_terminal import endpoint_path
        return endpoint_path(run_id)
    if str(uuid.UUID(run_id))!=run_id:raise BridgeError('非法运行 ID')
    return private_dir(Path('/tmp')/('dsp7-ui-'+str(os.getuid())))/(run_id+'.sock')


def root_for(b):return private_dir(Path(b.cfg['database']).parent/'interactive')


def git_snapshot(path):
    path=Path(path).resolve()
    def git(*args):
        p=subprocess.run(['git','-C',str(path),*args],capture_output=True,timeout=20)
        return p.stdout if p.returncode==0 else b''
    knowledge=hashlib.sha256()
    for relative in sorted(set(git('ls-files','--cached','--others','--exclude-standard').decode().splitlines())):
        file=path/relative
        if file.suffix!='.md' or 'tickets' in file.relative_to(path).parts or file.is_symlink() or not file.is_file():continue
        knowledge.update(relative.encode());knowledge.update(b'\0');knowledge.update(hashlib.sha256(file.read_bytes()).digest())
    return {'knowledge_markdown_sha256':knowledge.hexdigest(),'path':str(path),'head':git('rev-parse','HEAD').decode().strip(),
            'dirty':bool(git('status','--porcelain')),
            'tracked_diff_sha256':hashlib.sha256(git('diff','HEAD','--')).hexdigest()}


def interactive_args(args,run_id):
    # The native adapter provides print-mode arguments. Preserve permissions and
    # MCP/instruction paths, but switch to a real TTY and a new, explicit session.
    remove={'--output-format','--input-format','--max-turns','--resume','--session-id','--max-budget-usd'}
    flags={'--print','-p','--verbose','--include-partial-messages','--no-session-persistence'}
    out=[];i=0
    while i<len(args):
        a=args[i];name=a.split('=',1)[0]
        if name in remove:i+=1 if '=' in a else 2;continue
        if name in flags:i+=1;continue
        if name in ('--dangerously-skip-permissions','--allow-dangerously-skip-permissions'):
            raise BridgeError('交互入口禁止绕过权限')
        out.append(a);i+=1
    return out+['--session-id',run_id,'--name','Paperclip '+run_id[:8]]


def with_wait_hook(args,folder,timeout):
    # Merge explicit session settings, then append a scoped Stop hook. Global
    # settings and native permission policy remain under Claude's own loading.
    settings={};out=[];i=0
    while i<len(args):
        if args[i]=='--settings' or args[i].startswith('--settings='):
            inline=args[i].startswith('--settings=')
            if not inline and i+1>=len(args):raise BridgeError('--settings 缺少参数')
            value=args[i].split('=',1)[1] if inline else args[i+1]
            old=json.loads(value) if value.lstrip().startswith('{') else read_json(value)
            settings.update(old);i+=1 if inline else 2
        else:out.append(args[i]);i+=1
    hooks=dict(settings.get('hooks') or {})
    entries=list(hooks.get('Stop') or [])
    hook=[sys.executable,str(Path(__file__).resolve().parent/'interactive_wait.py')]
    command=subprocess.list2cmdline([x.replace('\\','/') for x in hook]) if WINDOWS else shlex.join(hook)
    entries.append({'hooks':[{'type':'command','command':command,'timeout':timeout+60}]})
    hooks['Stop']=entries;settings['hooks']=hooks
    path=folder/'session-settings.json';atomic_json(path,settings)
    return out+['--settings',str(path)]


def usage_ledger(cwd,run_id):
    # Claude project path escaping follows its persisted projects layout. Locate
    # only the exact new session UUID; never read other interactive conversations.
    projects=Path(os.environ.get('CLAUDE_CONFIG_DIR',str(Path.home()/'.claude')))/'projects'
    candidates=list(projects.glob('*/'+run_id+'.jsonl'))
    if len(candidates)!=1:return {},'unknown'
    main=candidates[0]
    files=[main]+list((main.parent/run_id/'subagents').glob('*.jsonl'))
    messages={};last_text=''
    for path in files:
        with path.open(encoding='utf-8') as f:
            for line in f:
                try:d=json.loads(line)
                except ValueError:continue
                if d.get('type')!='assistant' or d.get('isSidechain') and path==main:continue
                m=d.get('message') or {};mid=m.get('id');u=m.get('usage');model=m.get('model')
                if not mid or not model or not isinstance(u,dict):continue
                if not all(isinstance(u.get(k),int) and u[k]>=0 for k in ('input_tokens','output_tokens')):continue
                # Multiple thinking/text/tool blocks carry the same message usage.
                key=(str(path),mid)
                previous=messages.get(key)
                if previous:
                    u={k:max(u.get(k,0),previous[1].get(k,0)) for k in ('input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens')}
                messages[key]=(model,u)
                if path==main:
                    texts=[x.get('text','') for x in m.get('content',[]) if x.get('type')=='text']
                    if texts:last_text='\n'.join(texts)[-8000:]
    totals={}
    for model,u in messages.values():
        t=totals.setdefault(model,{'inputTokens':0,'outputTokens':0,'cacheReadInputTokens':0,'cacheCreationInputTokens':0})
        for dest,src in [('inputTokens','input_tokens'),('outputTokens','output_tokens'),('cacheReadInputTokens','cache_read_input_tokens'),('cacheCreationInputTokens','cache_creation_input_tokens')]:t[dest]+=u.get(src,0)
    return {'modelUsage':totals,'message_count':len(messages),'summary':last_text,'source':'session JSONL; message-ID deduplication; not CLI billing ledger'},'observed' if messages else 'unknown'


def terminate(child):
    if WINDOWS:return terminate_tree(child)
    if child is None:return
    try:os.killpg(child.pid,signal.SIGTERM)
    except ProcessLookupError:return
    try:child.wait(timeout=8)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):os.killpg(child.pid,signal.SIGKILL)
        child.wait(timeout=5)


def resize(master,rows,cols):
    if not 1<=rows<=1000 or not 1<=cols<=1000:return
    if WINDOWS:return master.resize(rows,cols)
    fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))

def terminal_write(master,data):
    return master.write(data) if WINDOWS else os.write(master,data)

def exec_claude(executable,args):
    cli=claude_argv(executable,args)
    if WINDOWS:raise SystemExit(subprocess.call(cli))
    os.execv(executable,cli)


def wrapper(args):
    # All invocations through this enrolled executor use its registered local
    # configuration, including native adapter probes. No secrets leave this PC.
    executable=REAL_CLAUDE
    config=read_json(DEFAULT_CONFIG)
    if config.get('seat_runtime'):
        from seats import verify_runtime
        profile=verify_runtime(Bridge())
        executable=profile['claudeCommand']
        settings=profile.get('claudeSettingsFile')
        if settings:
            provided=[args[i+1] for i,a in enumerate(args[:-1]) if a=='--settings']+[a.split('=',1)[1] for a in args if a.startswith('--settings=')]
            if provided and any(value!=settings for value in provided):raise BridgeError('启动配置与已登记席位不一致')
            if not provided:args=[*args,'--settings',settings]
    if '--print' not in args and '-p' not in args:
        exec_claude(executable,args)
    if not os.environ.get('PAPERCLIP_RUN_ID'):
        exec_claude(executable,args)
    if not all(os.environ.get(k) for k in ('PAPERCLIP_TASK_ID','PAPERCLIP_AGENT_ID','PAPERCLIP_API_URL','PAPERCLIP_API_KEY')):
        exec_claude(executable,args)
    b=Bridge(agent=True)
    if WINDOWS:
        from platform_support import own_process_job
        own_process_job()
    row=b.db.execute('SELECT config FROM pilots WHERE task_id=?',(b.env['PAPERCLIP_TASK_ID'],)).fetchone()
    if not row:
        raise BridgeError('本机 Harness 执行者不执行未登记的网页任务')
    registered=json.loads(row['config'])
    reason=os.environ.get('PAPERCLIP_WAKE_REASON','')
    if registered.get('execution_mode')=='interactive' and not reason.startswith('本地研发人员主动启动交互会话；'):
        print(json.dumps({'type':'result','subtype':'success','is_error':False,'result':'自动唤醒已跳过；交互执行需要本机启动意图，页面决策由接入桥续传。','usage':{'input_tokens':0,'output_tokens':0},'total_cost_usd':0,'dsp7_no_model_invocation':True},ensure_ascii=False),flush=True)
        return
    pilot,task=b.current_pilot()
    if pilot['details'].get('execution_mode')!='interactive':
        exec_claude(executable,args)
    run_id=b.env['PAPERCLIP_RUN_ID'];root=root_for(b)
    if not reason.startswith('本地研发人员主动启动交互会话；'):
        value={'run_id':run_id,'task_id':task['id'],'jira_key':pilot['jira_key'],'status':'no_model_invocation',
               'reason':reason,'usage_status':'not_applicable','finished_at':now(),'cost_status':'not_applicable'}
        folder=private_dir(root/'runs'/run_id);atomic_json(folder/'summary.json',value)
        b.event(pilot['jira_key'],'interactive_automatic_wake_ignored',value,run_id)
        print(json.dumps({'type':'result','subtype':'success','is_error':False,
              'result':'页面消息由接入桥核验并交给已连接的同一会话；无连接时保存决策。本次未启动第二个 Claude，未调用模型。',
              'usage':{'input_tokens':0,'output_tokens':0,'cache_read_input_tokens':0},'total_cost_usd':0,
              'dsp7_no_model_invocation':True},ensure_ascii=False),flush=True)
        return

    intent_path=root/'intents'/(task['id']+'.json')
    with (root/'intent.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        intent=read_json(intent_path)
        if intent.get('task_id')!=task['id'] or intent.get('consumed_run_id') or time.time()-intent['created_epoch']>180:
            raise BridgeError('没有有效的本地主动启动请求')
        if not os.environ.get('PAPERCLIP_WAKE_REASON','').endswith('启动编号 '+intent['nonce']):
            raise BridgeError('运行与本地启动请求不匹配')
        intent['consumed_run_id']=run_id;atomic_json(intent_path,intent)
    prompt=sys.stdin.read(2*1024*1024+1)
    if len(prompt)>131072:raise BridgeError('启动上下文过大')
    d=pilot['details'];cwd=os.getcwd() if d.get('mode')=='replay' else str(Path(d['worktree'] or b.root).resolve())
    b.validate_jira(pilot);b.worktree_check(d)
    folder=private_dir(root/'runs'/run_id);sockpath=socket_path(run_id)
    info={'run_id':run_id,'task_id':task['id'],'jira_key':pilot['jira_key'],'started_at':now(),'cwd':cwd,
          'harness_before':git_snapshot(b.root),'source_before':git_snapshot(cwd),'status':'waiting_for_terminal'}
    atomic_json(folder/'session.json',info)
    terminal_token=None
    if WINDOWS:
        from windows_terminal import listen
        server,terminal_token=listen(sockpath)
    else:
        server=socket.socket(socket.AF_UNIX);server.bind(str(sockpath));os.chmod(sockpath,0o600);server.listen(1)
    def accept_client():
        if WINDOWS:
            from windows_terminal import accept
            return accept(server,terminal_token)
        connected,_=server.accept();connected.settimeout(10);return connected
    child=None;master=None;client=None;buffer=b'';backlog=b'';disconnected=None
    def stop(*_):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    # If the outbound supervisor is killed, stop its wrapper and Claude too.
    supervisor=os.environ.get('DSP7_OUTBOUND_WORKER_PID')
    watchdog_done=None
    if supervisor:
        import threading
        if int(supervisor)!=os.getppid():raise BridgeError('本机执行监督器身份已变化')
        watchdog_done=threading.Event()
        def watch_supervisor():
            while not watchdog_done.wait(1):
                if os.getppid()!=int(supervisor) or (WINDOWS and not __import__('platform_support').process_alive(int(supervisor))):
                    os.kill(os.getpid(),signal.SIGTERM)
                    return
        threading.Thread(target=watch_supervisor,daemon=True).start()
    try:
        print('[DSP7] 真实运行已建立，等待本地终端连接。',file=sys.stderr,flush=True)
        server.settimeout(1)
        deadline=time.monotonic()+120
        while client is None and time.monotonic()<deadline:
            try:client=accept_client()
            except socket.timeout:pass
        if client is None:raise TimeoutError('Terminal attach timeout')
        server.settimeout(None)
        if not WINDOWS:master,slave=pty.openpty();resize(master,32,120)
        # The child opens the PTY as its controlling terminal. Its credentials
        # stay in memory; neither session metadata nor socket protocol contains them.
        def setup_tty():
            os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
        cli_args=interactive_args(args,run_id)
        same_session=bool(b.cfg.get('same_session_resume',False))
        if same_session:cli_args=with_wait_hook(cli_args,folder,max(30,min(3600,int(b.cfg.get('confirmation_wait_seconds',3600)))))
        instruction=('遇到阻塞只结束本轮输出，保持会话；Stop hook 等待有效决策后自动续传，不要要求 /exit 或新 start。完成后可 /exit。' if same_session else '交付或阻塞后提醒研发人员使用 /exit 结束本次运行。')
        command=claude_argv(executable,[*cli_args,prompt+'\n\n本次为研发人员可见的交互会话。先 inspect、claim；正式需求确认仍在 Jira。'+instruction+' 不要绕过领域门禁。'])
        env=dict(os.environ);env['TERM']='xterm-256color';env['DSP7_INTERACTIVE']='1';env['DSP7_SAME_SESSION_RESUME']='1' if same_session else '0'
        if WINDOWS:
            from windows_terminal import ConPtyChild,ConPtyMaster
            child=ConPtyChild(command,cwd,env);master=ConPtyMaster(child)
        else:
            child=subprocess.Popen(command,cwd=cwd,env=env,stdin=slave,stdout=slave,stderr=slave,preexec_fn=setup_tty,close_fds=True)
            os.close(slave)
        info.update(status='running',pid=child.pid,terminal_connected=True,same_session_resume=same_session);atomic_json(folder/'session.json',info)
        # CLI initialization can briefly precede the final executable identity.
        from pilot import processes_for_run
        ready_deadline=time.time()+5
        while processes_for_run(run_id)!=[child.pid] and child.poll() is None and time.time()<ready_deadline:time.sleep(.1)
        b.agent('claim',{})
        b.event(pilot['jira_key'],'interactive_started',info,run_id)
        transcript=folder/'terminal.log'
        with transcript.open('wb') as log:
            os.chmod(transcript,0o600)
            wait_status=None;automatic_exit_sent=False
            while child.poll() is None:
                sources=[master,server]+([client] if client else [])
                ready,_,_=select.select(sources,[],[],.5)
                if server in ready:
                    newcomer=accept_client()
                    if newcomer is None:continue
                    if client:newcomer.close()
                    else:
                        client=newcomer;disconnected=None;buffer=b''
                        info['terminal_connected']=True;atomic_json(folder/'session.json',info)
                        if backlog:client.sendall(backlog)
                if master in ready:
                    try:data=master.read(65536) if WINDOWS else os.read(master,65536)
                    except OSError:break
                    if data==b'':break
                    if data is not None:
                        log.write(data);log.flush();backlog=(backlog+data)[-131072:]
                    if client and data:
                        try:client.sendall(data)
                        except OSError:
                            client.close();client=None;disconnected=time.time()
                            info['terminal_connected']=False;atomic_json(folder/'session.json',info)
                if client and client in ready:
                    data=client.recv(65536)
                    if not data:
                        client.close();client=None;disconnected=time.time();buffer=b''
                        info['terminal_connected']=False;atomic_json(folder/'session.json',info)
                    else:
                        buffer+=data
                        if len(buffer)>200000:raise BridgeError('终端输入帧过大')
                        while b'\n' in buffer:
                            line,buffer=buffer.split(b'\n',1);frame=json.loads(line)
                            if frame['op']=='input':
                                payload=base64.b64decode(frame['data'],validate=True)
                                if len(payload)>65536:raise BridgeError('终端输入过大')
                                view=memoryview(payload)
                                while view:view=view[terminal_write(master,view):]
                            elif frame['op']=='resize':resize(master,int(frame['rows']),int(frame['cols']))
                if d.get('jira_dispatch') and not automatic_exit_sent:
                    completion=Path(d['state_path']).parent/'paperclip-completion.json'
                    if completion.is_file() and read_json(completion).get('run_id')==run_id and b.state(pilot,required=False).get('状态')=='completed':
                        task_now=b.pc.request('GET','/issues/'+task['id'])
                        if task_now.get('status')=='done':
                            terminal_write(master,b'/exit\r');automatic_exit_sent=True
                wait_path=folder/'wait.json'
                waiting=read_json(wait_path) if wait_path.is_file() else {}
                if waiting.get('status') and waiting.get('status')!=wait_status:
                    wait_status=waiting['status']
                    labels={'waiting_confirmation':'等待页面／Jira 审批，终端保持连接；同意后自动继续。',
                            'waiting_terminal':'审批已收到，等待终端重连。','resuming':'有效审批已收到，同一 Claude 会话继续执行。',
                            'rejected':'审批已拒绝，保持阻塞。','wait_timeout':'审批等待超时，决策和工单状态保留。','interrupted':'审批等待被人工中断。'}
                    message=labels.get(wait_status,'审批等待状态：'+wait_status)
                    print(json.dumps({'type':'assistant','session_id':run_id,'message':{'role':'assistant','content':[{'type':'text','text':message}]}},ensure_ascii=False),flush=True)
                keep_waiting=waiting.get('status') in ('waiting_confirmation','waiting_terminal') and time.time()<waiting.get('deadline_epoch',0)
                if disconnected and time.time()-disconnected>60 and not keep_waiting:
                    info['stop_reason']='terminal_disconnected';terminate(child);break
        if child.poll() is None:child.wait(timeout=5)
    except (KeyboardInterrupt,TimeoutError,socket.timeout):
        info['stop_reason']='interrupted_or_attach_timeout'
    finally:
        if watchdog_done:watchdog_done.set()
        terminate(child)
        if client:client.close()
        server.close()
        if master is not None:
            if WINDOWS:master.close()
            else:os.close(master)
        with contextlib.suppress(FileNotFoundError):sockpath.unlink()
        info.update(status='exited',finished_at=now(),exit_code=child.returncode if child else None,
                    harness_after=git_snapshot(b.root),source_after=git_snapshot(cwd))
        usage,status=usage_ledger(cwd,run_id)
        info.update(usage_status=status,usage=usage,cost_status='unknown')
        atomic_json(folder/'summary.json',info);b.event(pilot['jira_key'],'interactive_exited',info,run_id)
    if child is None or info.get('stop_reason') or child.returncode!=0:
        raise BridgeError('交互会话中断；保留领域状态，不自动重试')
    if status=='unknown':
        # Native claude_local interprets absent usage as zero. Fail the adapter
        # run instead, retaining an explicit unknown record; never invent usage.
        raise BridgeError('交互会话已退出，但无法采集用量；请核对本地 summary，禁止把未知记为零')
    print(json.dumps({'type':'system','subtype':'init','session_id':run_id,'model':next(iter(usage['modelUsage']))}),flush=True)
    print(json.dumps({'type':'result','subtype':'success','is_error':False,'session_id':run_id,
                      'result':usage.get('summary') or '交互会话已退出；领域完成以工单证据为准。',
                      'modelUsage':usage['modelUsage'],'dsp7_usage_source':usage['source'],'dsp7_cost_status':'unknown'},ensure_ascii=False),flush=True)


def record_wrapper_failure(error):
    run_id=os.environ.get('PAPERCLIP_RUN_ID')
    if not run_id:return
    try:
        uuid.UUID(run_id)
        cfg=read_json(DEFAULT_CONFIG)
        folder=private_dir(Path(cfg['database']).parent/'interactive'/'runs'/run_id)
        if not (folder/'summary.json').exists():
            atomic_json(folder/'summary.json',{'run_id':run_id,'status':'bootstrap_failed',
                'error':str(error)[:2000],'finished_at':now(),'usage_status':'unknown'})
    except Exception:pass


def attach(run_id):
    if not sys.stdin.isatty() or not sys.stdout.isatty():raise BridgeError('请在本地交互终端执行')
    if WINDOWS:
        from windows_terminal import attach as windows_attach
        return windows_attach(run_id)
    s=socket.socket(socket.AF_UNIX);s.connect(str(socket_path(run_id)))
    old=termios.tcgetattr(sys.stdin.fileno())
    def send(value):s.sendall(json.dumps(value).encode()+b'\n')
    def size(*_):
        z=os.get_terminal_size();send({'op':'resize','rows':z.lines,'cols':z.columns})
    print('已连接 Paperclip 运行 '+run_id+'。审批等待期间保持窗口，同意后自动继续；/exit 主动结束；Ctrl+] 暂离后可 harness attach 重连。',flush=True)
    prev=signal.signal(signal.SIGWINCH,size)
    try:
        size();tty.setraw(sys.stdin.fileno())
        while True:
            ready,_,_=select.select([s,sys.stdin],[],[])
            if s in ready:
                data=s.recv(65536)
                if not data:break
                sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
            if sys.stdin in ready:
                data=os.read(sys.stdin.fileno(),65536)
                if not data or b'\x1d' in data:break
                send({'op':'input','data':base64.b64encode(data).decode()})
    finally:
        termios.tcsetattr(sys.stdin.fileno(),termios.TCSADRAIN,old);signal.signal(signal.SIGWINCH,prev);s.close()
        print('\n终端连接已结束。查看 harness status 或运行报告确认结果。')


def start(b,key,confirm,seat_command=None):
    if not sys.stdin.isatty() or not sys.stdout.isatty():raise BridgeError('请在本机交互终端执行 harness start')
    if not confirm:raise BridgeError('首次启动需 --confirm-no-other-executor，确认没有旧人工会话执行该工单')
    root=root_for(b)
    with (root/'operator.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise BridgeError('已有本地启动／终端连接，请先结束或使用 attach')
        from seats import verify_runtime
        verify_runtime(b)
        pilot=b.pilot(key);b.validate_jira(pilot);b.worktree_check(pilot['details'])
        if pilot['details'].get('jira_dispatch'):
            from jira_dispatch import verify,check_other_executor
            verify(b,pilot['task_id'],start=True);check_other_executor(b,key)
        if b.db.execute('SELECT COUNT(*) FROM pilots WHERE enabled=1 AND jira_key<>?',(key,)).fetchone()[0]:raise BridgeError('第一期仅允许一张启用工单')
        runs=b.runs_for(pilot) if pilot['task_id'] else []
        if any(r['status'] in ACTIVE for r in runs):raise BridgeError('已有活动运行；请使用 harness attach，不重复启动')
        b.lease_clear(pilot,runs)
        if pilot['enabled'] and pilot['details'].get('execution_mode')!='interactive':
            raise BridgeError('请先 pilot.py disable 工单，再切换为交互模式')
        # Keep disabled until the task, confirmation and intent are prepared.
        # The mode is persistent; the supervisor never wakes an interactive ticket.
        b.update(key,enabled=0)
        details=dict(pilot['details']);details['execution_mode']='interactive'
        with b.db:b.db.execute('UPDATE pilots SET config=? WHERE jira_key=?',(json.dumps(details,ensure_ascii=False),key))
        pilot=b.pilot(key);task=b.ensure_task(pilot);pilot=b.pilot(key)
        if task['status'] in ('done','cancelled'):raise BridgeError('已结束工单不能重新启动')
        if task.get('assigneeAgentId') not in (None,b.cfg['agent_id']):raise BridgeError('工单分派给了其他 Agent')
        if task.get('assigneeAgentId') is None:b.pc.request('PATCH','/issues/'+task['id'],{'assigneeAgentId':b.cfg['agent_id']})
        # Pending confirmations are verified on a copy. The Agent still performs
        # the authoritative resolve under its own real run lease.
        state=b.state(pilot,required=False)
        b.sync_page_confirmation(pilot,state,task,active=False)
        cur=b.jc.current_confirmation(state)
        if cur and cur.get('状态')=='pending':
            import copy,tempfile
            comments=read_json(details['comments_path'])['comments'] if details.get('mode')=='replay' else b.jc.fetch_comments(key,*b.jira_config())
            with tempfile.TemporaryDirectory() as folder:
                verdict,_=b.jc.resolve_confirmation(Path(folder)/'state.json',copy.deepcopy(state),comments)
            if verdict=='rejected':raise BridgeError('确认已拒绝，必须修订方案并创建新确认编号')
            if verdict!='approved' and not b.cfg.get('same_session_resume',False):raise BridgeError('Jira 尚无有效确认，不能续传')
        nonce=uuid.uuid4().hex;private_dir(root/'intents')
        intent={'task_id':task['id'],'jira_key':key,'nonce':nonce,'created_epoch':time.time(),'created_at':now()}
        intent_path=root/'intents'/(task['id']+'.json');atomic_json(intent_path,intent)
        b.update(key,enabled=1,last_error=None)
        b.wake(pilot,'本地研发人员主动启动交互会话；按登记 workflow 和领域状态继续。启动编号 '+nonce,interactive_nonce=nonce)
        print('已请求 Paperclip 创建真实运行，等待本地连接…',flush=True)
        deadline=time.time()+150;next_progress=0
        next_outbound=0
        while time.time()<deadline:
            if b.cfg.get('execution_transport')=='outbound' and time.time()>=next_outbound:
                from outbound import poll
                poll(b);next_outbound=time.time()+2
            intent=read_json(intent_path);run_id=intent.get('consumed_run_id')
            if run_id:
                summary=root/'runs'/run_id/'summary.json'
                if summary.is_file():
                    failure=read_json(summary)
                    raise BridgeError('本地运行启动失败：'+str(failure.get('error') or failure.get('stop_reason') or failure.get('status')))
                if socket_path(run_id).exists():
                    if seat_command:
                        from seat_control import receipt
                        receipt(b,seat_command,'running','真实运行已建立，已连接本机可见终端',run_id)
                    attach(run_id)
                    if seat_command:receipt(b,seat_command,'succeeded','终端连接结束；任务结果以领域验收为准',run_id)
                    return
            if time.time()>=next_progress:
                recent=b.runs_for(b.pilot(key))
                matching=[r for r in recent if str((r.get('contextSnapshot') or {}).get('wakeReason','')).endswith('启动编号 '+nonce)]
                if matching:
                    current=matching[0]
                    print('Paperclip 运行 '+current['id'][:8]+'：'+current['status'],flush=True)
                    if current['status'] in ('failed','cancelled','timed_out','succeeded'):
                        raise BridgeError('运行已结束但终端未连接：'+str(current.get('error') or current['status']))
                else:print('等待 Paperclip 调度／本机主动领取…' if b.cfg.get('execution_transport')=='outbound' else '等待 Paperclip 调度／SSH 启动…',flush=True)
                next_progress=time.time()+5
            time.sleep(.5)
        raise BridgeError('连接超时。请求可能已接收，请先查看 status；不要盲目重发')


def main():
    if sys.argv[1:3]==['repo','connect']:
        from quick_install import bind_projects,scan
        b=Bridge();bind_projects(b,scan([Path.cwd(),Path.home()/'work',Path.home()/'projects']));return
    if len(sys.argv)>2 and sys.argv[1]=='seat' and sys.argv[2]=='enroll':
        from onboard import main as enroll
        enroll(sys.argv[3:]);return
    if len(sys.argv)>2 and sys.argv[1]=='seat' and sys.argv[2] in ('accept','pending','allow-auto-start','revoke-auto-start'):
        from seat_control import cli
        cli(Bridge(),sys.argv[2:]);return
    if len(sys.argv)>1 and sys.argv[1] in ('seat','repo'):
        from seats import command
        command(Bridge(),sys.argv[1:]);return
    p=argparse.ArgumentParser(description='可见 Claude 终端与 Paperclip 的接入入口')
    p.add_argument('--config',type=Path,default=DEFAULT_CONFIG)
    sub=p.add_subparsers(dest='action',required=True)
    a=sub.add_parser('start');a.add_argument('jira_key');a.add_argument('--confirm-no-other-executor',action='store_true')
    a=sub.add_parser('attach');a.add_argument('jira_key')
    sub.add_parser('status')
    a=sub.add_parser('knowledge');a.add_argument('jira_key');a.add_argument('--summary',required=True)
    args=p.parse_args()
    if args.action=='start':
        if Path(args.config).resolve()!=DEFAULT_CONFIG.resolve() and read_json(args.config).get('execution_transport')!='outbound':raise BridgeError('SSH 适配器只支持默认本机配置')
        if not (Path(args.config).parent/'interactive-enabled.json').is_file():raise BridgeError('服务器适配器尚未接入交互包装器')
    b=Bridge(args.config)
    if args.action=='start':start(b,args.jira_key,args.confirm_no_other_executor)
    elif args.action=='attach':
        pilot=b.pilot(args.jira_key);runs=[r for r in b.runs_for(pilot) if r['status'] in ACTIVE]
        if len(runs)!=1:raise BridgeError('未找到唯一活动运行')
        attach(runs[0]['id'])
    elif args.action=='knowledge':
        b.pilot(args.jira_key)
        if not args.summary.strip() or len(args.summary)>10000:raise BridgeError('需要 1–10000 字摘要')
        value={'summary':args.summary,'harness':git_snapshot(b.root),'recorded_at':now()}
        b.event(args.jira_key,'harness_knowledge_change',value)
        pilot=b.pilot(args.jira_key)
        if pilot['task_id']:b.pc.request('POST','/issues/'+pilot['task_id']+'/comments',{'body':'Harness 知识改进：'+args.summary+'\n版本：'+value['harness']['head']+'；dirty='+str(value['harness']['dirty'])})
        print(json.dumps(value,ensure_ascii=False,indent=2))
    else:
        items=[]
        for row in b.db.execute('SELECT jira_key FROM pilots').fetchall():
            pilot=b.pilot(row['jira_key'])
            runs=b.runs_for(pilot) if pilot['task_id'] else []
            items.append({'jira_key':pilot['jira_key'],'execution_mode':pilot['details'].get('execution_mode','background'),
                          'enabled':bool(pilot['enabled']),'task_id':pilot['task_id'],'status':pilot['status'],
                          'active_run_ids':[r['id'] for r in runs if r['status'] in ACTIVE],'last_error':pilot['last_error']})
        print(json.dumps(items,ensure_ascii=False,indent=2))

if __name__=='__main__':
    try:main()
    except (BridgeError,OSError,ValueError) as e:
        print('交互接入失败：'+str(e),file=sys.stderr);sys.exit(2)
