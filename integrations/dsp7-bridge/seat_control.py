"""Outbound seat presence, durable commands, visible terminal handoff and policy."""
from __future__ import annotations
import argparse
import hashlib
import shutil
import contextlib
import datetime as dt
from platform_support import fcntl
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid
from pilot import Bridge, BridgeError, atomic_json, now, read_json, ACTIVE, processes_for_run
from seats import identity, runtime_profile, seat_api, verify_runtime
from seat_lifecycle import offline_requested

DEFAULT_POLICY={'mode':'manual','jiraKeys':[],'reminderMinutes':10,'escalationMinutes':30}
TERMINAL={'succeeded','failed','denied','cancelled','expired'}

def setup(b):
    b.db.executescript('''CREATE TABLE IF NOT EXISTS seat_commands(command_id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,opened INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS seat_control_notices(notice_key TEXT PRIMARY KEY,created_at TEXT NOT NULL);''')
    from platform_support import private_directory
    folder=private_directory(Path(b.cfg['database']).parent/'seat-control')
    return folder

def notify(title,message,*,config=None,task_id=None,run_id=None):
    if sys.platform=='win32':
        from platform_support import powershell
        try:
            powershell("""$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms;
$n=[System.Windows.Forms.NotifyIcon]::new();
try{$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;
$n.ShowBalloonTip(5000,$env:PAPERCLIP_NOTICE_TITLE,$env:PAPERCLIP_NOTICE_MESSAGE,[System.Windows.Forms.ToolTipIcon]::Info);
Start-Sleep -Seconds 6}finally{$n.Dispose()}""",env=dict(os.environ,PAPERCLIP_NOTICE_TITLE=title,PAPERCLIP_NOTICE_MESSAGE=message),timeout=15)
            return 'submitted'
        except subprocess.SubprocessError:return 'failed'
    if sys.platform!='darwin':return 'unsupported'
    from mac_notifications import notify as mac_notify
    return mac_notify(title,message,config=config,task_id=task_id,run_id=run_id)

def once_notice(b,key,title,message,*,task_id=None,run_id=None):
    if b.db.execute('SELECT 1 FROM seat_control_notices WHERE notice_key=?',(key,)).fetchone():return
    # Record before delivery: unknown outcomes must not cause a notification storm.
    with b.db:b.db.execute('INSERT INTO seat_control_notices VALUES(?,?)',(key,now()))
    result=notify(title,message,config=b.config_path,task_id=task_id,run_id=run_id)
    b.event('_seat','seat_notification',{'notice_key':key,'delivery':result})

def dingtalk_notice(b,policy,jira_key,key,message,task_id,dispatch_authorized=False):
    target=policy.get('dingtalk')
    if not target or target.get('botId'):return
    from jira_dispatch import authorized
    dispatch=(b.cfg.get('_dispatch_rule') or {})
    if not dispatch_authorized and jira_key not in policy.get('jiraKeys',[]) and not authorized(b,b.pilot(jira_key),dispatch):return
    notice='dingtalk:'+hashlib.sha256((target['profile']+':'+target['userId']+':'+key).encode()).hexdigest()
    with b.db:
        if not b.db.execute('INSERT OR IGNORE INTO seat_control_notices VALUES(?,?)',(notice,now())).rowcount:return
    executable=shutil.which('dws') or str(Path.home()/'.local/bin/dws')
    delivery={'status':'unknown','notice_key':notice,'jira_key':jira_key,'recipient':target['userId'],'profile':target['profile']}
    try:
        url=b.cfg['paperclip_url'].rstrip('/')+'/DSP/issues/'+task_id
        result=subprocess.run([executable,'chat','+messages-send','--as','user','--user',target['userId'],'--profile',target['profile'],'--text',message+'\n'+url,'--idempotency-key',notice,'--format','json','--yes'],capture_output=True,text=True,timeout=45)
        payload=json.loads(result.stdout)
        # Keep only delivery evidence; never persist CLI stderr or credentials.
        envelope=payload.get('result') or payload
        data=envelope.get('result') or envelope
        delivery.update({k:data[k] for k in ('openTaskId','messageId','openMessageId','conversationId') if k in data})
        if result.returncode==0 and (payload.get('success') is True or (payload.get('ok') is True and envelope.get('success') is True)) and not payload.get('partial') and not payload.get('failedCount'):
            delivery['status']='submitted' # Platform acceptance is not a read receipt.
        elif result.returncode!=0 or payload.get('success') is False or payload.get('ok') is False or envelope.get('success') is False or payload.get('failedCount'):
            delivery['status']='failed'
    except (OSError,ValueError,subprocess.SubprocessError):pass
    b.event('_seat','dingtalk_notification',delivery)

def inspect_configuration(b):
    stored=b.cfg.get('seat_runtime') or {};checks=[]
    def add(key,label,status,message):checks.append({'id':key,'label':label,'status':status,'message':message})
    try:
        profile=runtime_profile(b,stored.get('claudeCommand') or 'claude',stored.get('claudeSettingsFile'),stored.get('environmentId'))
        add('claude','Claude 可执行文件','pass',profile['claudeVersion'])
        add('settings','本机 Claude 配置','pass','JSON 可读，内容不上传' if profile['claudeSettingsFile'] else '沿用本机默认配置，未验证模型认证')
        add('harness','Harness 根目录','pass','Harness CLI 存在')
        if not stored or any(stored.get(k)!=v for k,v in profile.items()):
            add('registration','登记一致性','fail','版本、路径或设置已变化，请刷新登记')
        else:
            verify_runtime(b);add('registration','登记一致性','pass','本机、服务端版本和执行环境一致')
        add('transport','接入桥到服务器','pass','本席位凭证与服务器通信正常；SSH 以实际启动为准')
        from jira_dispatch import rule_for
        dispatch=rule_for(b)
        if dispatch and dispatch.get('jiraPatConfigured'):
            b.jira().request('GET','/rest/api/2/myself')
            add('jira','Jira 配置','pass','网页 PAT 可用；配置内容不回显')
        elif dispatch and dispatch.get('enabled'):
            add('jira','Jira 配置','fail','自动执行规则缺少 Jira PAT')
    except (BridgeError,OSError,ValueError,subprocess.SubprocessError):
        # Never forward exception text containing config values, HTTP responses or keys.
        add('configuration','本机配置检查','fail','可执行文件、配置或服务端登记校验失败，请在本机运行 harness seat check 查看原因')
    from harness_launch import ROOT_MODE, launch_mode, inspect_harness
    try:
        mode=launch_mode(b.cfg)
        if mode==ROOT_MODE:
            inspect_harness(b.root)
            add('harness_launch','正式任务启动方式','pass','从登记的 Harness 根目录启动；沿用本机工程规则、技能和 MCP，执行仓库和工作树由 Harness 管理。MCP 连接与模型认证未在此检查。')
        else:
            add('harness_launch','正式任务启动方式','warn','本机显式启用旧源码目录兼容模式，未使用 Harness 根目录启动；新模式需在空闲时由负责人切换。')
    except BridgeError as error:
        add('harness_launch','正式任务启动方式','fail',str(error))
    except (OSError,ValueError):
        add('harness_launch','正式任务启动方式','fail','Harness 引导、技能目录或 JSON 配置未通过检查；请在本机执行 harness doctor，不会自动改用源码目录。')
    from service_status import check as autostart_check
    checks.append(autostart_check())
    return checks

def receipt(b,command,status,message,run_id=None,stage=None,elapsed_ms=None):
    result=seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-seat-command-result',{**identity(b),'commandId':command['commandId'],'status':status,'message':message,'runId':run_id,**({'stage':stage,'elapsedMs':elapsed_ms} if stage else {})})
    with b.db:b.db.execute('UPDATE seat_commands SET status=?,updated_at=? WHERE command_id=?',(result['status'],now(),command['commandId']))
    return result

def open_terminal(b,command,automatic=False):
    entry=Path(__file__).resolve().parent/'interactive.py'
    config=str(Path(b.config_path).resolve())
    env=dict(os.environ,DSP7_BRIDGE_CONFIG=config)
    cli=[sys.executable,str(entry),'seat','accept',command['commandId']]
    if automatic:cli.append('--automatic')
    if sys.platform=='darwin':
        # Terminal.app starts a fresh shell and does not inherit the watcher's
        # environment. Bind the command to the originating seat explicitly.
        shell=' '.join(shlex.quote(x) for x in ['env','DSP7_BRIDGE_CONFIG='+config,*cli])
        script='on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run'
        result=subprocess.run(['/usr/bin/osascript','-e',script,shell],capture_output=True,timeout=20)
        if result.returncode:raise BridgeError('无法打开 Terminal，请核对本机终端权限')
    elif sys.platform=='linux':
        for name,separator in [('gnome-terminal','--'),('konsole','-e'),('x-terminal-emulator','-e'),('xterm','-e')]:
            terminal=shutil.which(name)
            if terminal:
                subprocess.Popen([terminal,separator,'env','DSP7_BRIDGE_CONFIG='+config,*cli],env=env,start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                return
        raise BridgeError('Linux 自动执行需要桌面终端程序；请安装终端并保持图形登录')
    elif sys.platform=='win32':
        subprocess.Popen(cli,env=env,creationflags=subprocess.CREATE_NEW_CONSOLE)
    else:raise BridgeError('自动打开可见终端仅支持 macOS 和 Linux 桌面')

def permit(b,key):
    value=b.cfg.get('seat_auto_permit') or {}
    try:return value if dt.datetime.fromisoformat(value['until']).timestamp()>time.time() and key in value.get('jiraKeys',[]) else None
    except (KeyError,TypeError,ValueError):return None


def verify_stopped_execution(b,pilot,run,folder,info,summary,active):
    """Confirm process absence independently of the best-effort usage summary.

    A missing summary requires two observations at least 15 seconds apart.
    This records observed exit evidence, never a fabricated result or usage.
    """
    from platform_support import process_alive
    path=folder/'stop-verification.json'
    previous=read_json(path) if path.is_file() else {}
    stamp=time.time()
    scope={'run_id':run['id'],'task_id':pilot['task_id'],'agent_id':b.cfg['agent_id']}
    if any(previous.get(k)!=v for k,v in scope.items()):previous={}
    pids=set()
    for key in ('pid','wrapper_pid','supervisor_pid'):
        value=info.get(key)
        if type(value) is int and value>0:pids.add(value)
    # Clients predating wrapper/supervisor metadata still have worker receipts.
    row=b.db.execute("SELECT data FROM events WHERE kind='outbound_worker_started' AND data LIKE ? ORDER BY id DESC LIMIT 1",('%'+run['id']+'%',)).fetchone()
    if row:
        worker=json.loads(row['data'])
        if worker.get('run_id')==run['id'] and type(worker.get('pid')) is int and worker['pid']>0:pids.add(worker['pid'])
    try:
        owned=processes_for_run(run['id'])
        live=[pid for pid in sorted(pids) if process_alive(pid)]
    except (OSError,ValueError,subprocess.SubprocessError):
        atomic_json(path,{**scope,'state':'unknown','checked_at':now(),'reason':'process_inspection_failed'})
        return False
    # Unknown local launch identity is not proof of a stopped execution.
    absent=not active and not owned and not live and bool(pids or summary)
    if not absent:
        atomic_json(path,{**scope,'state':'checking','checked_at':now(),'reason':'active_or_unverified_process'})
        return False
    first=previous.get('first_absent_epoch')
    if not isinstance(first,(int,float)) or not 0<=stamp-first<=86400:first=stamp
    count=int(previous.get('observations',0))+1 if first!=stamp else 1
    confirmed=bool(summary) or (count>=2 and stamp-first>=15)
    evidence={**scope,'state':'stopped' if confirmed else 'checking','checked_at':now(),
              'first_absent_epoch':first,'observations':count,'checked_pids':sorted(pids),
              'server_status':run['status'],'summary_present':bool(summary),
              'source':'server_terminal_state_and_local_process_absence'}
    atomic_json(path,evidence)
    if confirmed and previous.get('state')!='stopped':
        if info and info.get('status') not in ('exited','bootstrap_failed'):
            info.update(status='exited',terminal_connected=False,terminal_disconnected_at=None,
                        exit_observed_at=now(),stop_reason=info.get('stop_reason') or 'process_exit_reconciled')
            atomic_json(folder/'session.json',info)
        b.event(pilot['jira_key'],'execution_stop_verified',evidence,run['id'])
    return confirmed


def collect(b,checks,folder):
    saved=read_json(folder/'state.json') if (folder/'state.json').is_file() else {}
    policy=saved.get('policy') or DEFAULT_POLICY
    b.cfg['_dispatch_rule']=saved.get('dispatch')
    tasks=[];alerts=[];active=None;run_id=None;state='idle';registered={};active_runs=[]
    # Recompute failures so repaired registrations clear on the next heartbeat.
    checks[:]=[c for c in checks if not c['id'].startswith('task_state:')]
    for row in b.db.execute('SELECT jira_key FROM pilots ORDER BY rowid ASC LIMIT 50').fetchall():
        try:p=b.pilot(row['jira_key'])
        except (BridgeError,ValueError,KeyError,TypeError,OSError):
            # Report malformed registrations without suppressing presence.
            # Execution remains fail-closed; never expose raw exception text.
            checks.append({'id':'task_state:'+row['jira_key'],'label':'工单状态解析','status':'fail',
                           'message':row['jira_key']+' 的本机工作流或状态登记无法解析；请核对领域布局与历史登记。席位心跳继续上报，暂停新任务启动。'})
            continue
        if not p['task_id']:continue
        try:task=b.pc.request('GET','/issues/'+p['task_id'])
        except BridgeError:continue
        if task['status'] in ('done','cancelled'):continue
        registered[p['task_id']]=p
        runs=b.runs_for(p);running=[r for r in runs if r['status'] in ACTIVE]
        domain=b.state(p,required=False);cur=b.jc.current_confirmation(domain)
        stopped_run=None;native=None;stop_requested=None
        execution_runs=[r for r in runs if (Path(b.cfg['database']).parent/'interactive/runs'/r['id']/'session.json').is_file() or str((r.get('contextSnapshot') or {}).get('wakeReason') or '').startswith('本地研发人员主动启动交互会话；')]
        latest=max(execution_runs,key=lambda r:r.get('createdAt') or r.get('startedAt') or '') if execution_runs else None
        if latest:
            session_folder=Path(b.cfg['database']).parent/'interactive/runs'/latest['id']
            info=read_json(session_folder/'session.json') if (session_folder/'session.json').is_file() else {}
            stop_intent=read_json(session_folder/'stop-intent.json') if (session_folder/'stop-intent.json').is_file() else {}
            if stop_intent.get('run_id')==latest['id'] and stop_intent.get('task_id')==p['task_id']:stop_requested=latest['id']
            summary=read_json(session_folder/'summary.json') if (session_folder/'summary.json').is_file() else {}
            if any(r['id']==latest['id'] and r['status']=='running' for r in running):
                from session_hook import native_wait
                native=native_wait(session_folder,latest,p['task_id'])
            if latest['status'] in ('failed','cancelled','timed_out'):
                stopped=verify_stopped_execution(b,p,latest,session_folder,info,summary,running)
                stopped_run=latest['id'] if stopped else None
                action=str((task.get('unblockDescriptor') or {}).get('action') or '')
                owned_interruption=task['status']=='blocked' and action.startswith('执行已中断') and ('运行编号：'+latest['id']) in action
                if owned_interruption or (p['enabled'] and (task['status']=='in_progress' or (task['status']=='blocked' and not task.get('unblockDescriptor') and not cur))):
                    message=(('执行已中断：已记录用户停止指令，不自动重试；可在网页明确恢复执行。' if stop_requested or (latest.get('resultJson') or {}).get('dsp7StopIntent') or (latest.get('resultJson') or {}).get('cancelledByActorType')=='user' else ('执行已中断：本机旧进程已停止；平台将核验一次自动重试条件，不满足或已用尽时需明确恢复。' if latest['status']!='cancelled' and (latest.get('contextSnapshot') or {}).get('dsp7SeatAutoRetryV1') is True else '执行已中断：本机会话已结束，需在网页明确恢复执行。')) if stopped else '执行已中断：正在核验本机旧进程是否停止，确认前不能恢复执行。')
                    target=message+' 运行编号：'+latest['id']
                    reported=task['status']=='blocked' and action==target
                    if not reported:
                        # A terminal run cannot use the active checkout write
                        # route. Report its exact interruption through the scoped
                        # machine endpoint; checkout release remains server-gated.
                        try:
                            seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-jira-intake/execution-interrupted',{**identity(b),'taskId':p['task_id'],'runId':latest['id'],'stopped':stopped,'action':target})
                            reported=True
                        except (BridgeError,ValueError,OSError):
                            # Keep this receipt eligible for retry without letting
                            # one failed task suppress the entire seat heartbeat.
                            alerts.append({'id':p['jira_key']+':interruption_receipt','taskId':p['task_id'],'jiraKey':p['jira_key'],'level':'warning','message':p['jira_key']+' 的中断回执尚未同步，后台将重试；请查看任务与本机日志。','elapsedMinutes':0})
                    if reported:
                        if p['enabled'] or p['status']!='interrupted' or p.get('last_error')!=message:
                            b.update(p['jira_key'],enabled=0,status='interrupted',last_error=message)
                        task['status']='blocked';p=b.pilot(p['jira_key'])
            if running and info.get('terminal_connected') is False:
                alerts.append({'id':p['jira_key']+':terminal_disconnected','taskId':p['task_id'],'jiraKey':p['jira_key'],'level':'warning','message':'本机终端已断开；60 秒内可重连，等待审批时保留会话。','elapsedMinutes':0})
        ready=not running and not p['enabled'] and task['status'] in ('backlog','todo') and not p.get('last_error')
        tasks.append({'taskId':p['task_id'],'jiraKey':p['jira_key'],'status':task['status'],'mode':'replay' if p['details'].get('mode')=='replay' else 'formal','ready':ready,'automatic':bool(p['details'].get('platform_dispatch')),**({'stoppedRunId':stopped_run} if stopped_run else {}),**({'stopRequestedRunId':stop_requested} if stop_requested else {})})
        live_runs=[r for r in running if r['status']=='running']
        if live_runs:
            state='busy';active=p['task_id'];run_id=live_runs[0]['id']
            active_runs.extend({'taskId':p['task_id'],'runId':r['id'],'state':'busy'} for r in live_runs)
        if cur and cur.get('状态')=='pending':
            state='waiting_decision';active=p['task_id']
            requested=b.jc.parse_time(cur.get('请求时间'))
            elapsed=max(0,(dt.datetime.now(dt.timezone.utc)-requested).total_seconds()/60) if requested else 0
            level='urgent' if elapsed>=policy['escalationMinutes'] else 'warning'
            aid=p['jira_key']+':'+str(cur.get('确认编号'))
            message=p['jira_key']+' 等待人工决策 #'+str(cur.get('确认编号'))+'；请打开任务处理'
            alerts.append({'id':aid,'taskId':p['task_id'],'jiraKey':p['jira_key'],'level':level,'message':message,'elapsedMinutes':round(elapsed,1)})
            bucket=int(elapsed/max(1,policy['reminderMinutes']))
            if bucket>0 or not p['enabled'] or b.cfg.get('notifications')!='local':
                once_notice(b,aid+':'+level+':'+str(bucket),'Paperclip：待决策'+('（超时升级）' if level=='urgent' else ''),message,task_id=p['task_id'],run_id=latest['id'] if latest else None)
            dingtalk_notice(b,policy,p['jira_key'],aid+':'+level+':'+str(bucket),('【超时升级】' if level=='urgent' else '【待决策】')+message,p['task_id'])
            if b.cfg.get('notifications')=='dingtalk' and p['details'].get('notifications_authorized'):
                # Reuse existing Harness delivery authorization/dedup, no new receiver.
                b.notify_block(p,domain)
        if native:
            state='waiting_decision';active=p['task_id'];run_id=latest['id']
            elapsed=native['elapsedMinutes'];level='urgent' if elapsed>=policy['escalationMinutes'] else 'warning'
            message=p['jira_key']+('：Claude 正在等待回答问题' if native['kind']=='question' else '：Claude 正在等待人工处理（回答问题或确认权限）')+'；请到席位电脑的 Claude 终端处理，网页不能代答。'
            alert={'id':native['id'],'taskId':p['task_id'],'jiraKey':p['jira_key'],'level':level,'message':message,'elapsedMinutes':elapsed}
            alerts.append(alert)
            bucket=int(elapsed/max(1,policy['reminderMinutes']))
            notice=native['id']+':'+level+':'+str(bucket)
            once_notice(b,notice,'Paperclip：Claude 等待处理',message,task_id=p['task_id'],run_id=latest['id'])
            dingtalk_notice(b,policy,p['jira_key'],notice,message,p['task_id'],dispatch_authorized=bool(p['details'].get('platform_dispatch')))
        elif not (cur and cur.get('状态')=='pending') and (p.get('last_error') or task['status']=='blocked'):
            alerts.append({'id':p['jira_key']+':blocked','taskId':p['task_id'],'jiraKey':p['jira_key'],'level':'warning','message':p['jira_key']+' 执行已阻塞，请查看任务与本机日志','elapsedMinutes':0})
            once_notice(b,p['jira_key']+':blocked:'+p['updated_at'],'Paperclip：执行阻塞',alerts[-1]['message'],task_id=p['task_id'],run_id=latest['id'] if latest else None)
            dingtalk_notice(b,policy,p['jira_key'],p['jira_key']+':blocked:'+p['updated_at'],alerts[-1]['message'],p['task_id'])
    # Independent analysis has no Jira pilot. Use its owned live runtime metadata.
    from platform_support import process_alive
    for file in sorted((Path(b.cfg['database']).parent/'interactive/runs').glob('*/session.json'),key=lambda p:p.stat().st_mtime,reverse=True)[:50]:
        info=read_json(file)
        if info.get('execution_kind') not in ('analysis','delivery') or info.get('status') not in ('running','waiting_for_terminal') or not process_alive(info.get('wrapper_pid',0)):continue
        active=info['task_id'];run_id=info['run_id'];state='busy'
        wait=file.parent/'wait.json'
        wait_state=read_json(wait) if wait.is_file() else {}
        if wait_state.get('status') in ('waiting_confirmation','waiting_terminal'):
            state='waiting_decision'
            elapsed=max(0,(time.time()-wait_state.get('waitingSince',time.time()))/60)
            level='urgent' if elapsed>=policy['escalationMinutes'] else 'warning'
            alert_id=('delivery:'+active if info.get('execution_kind')=='delivery' else 'analysis:'+run_id)+':'+str(wait_state.get('decisionDigest','unknown'))
            message='条目交付正在等待人工决定，请在条目自动交付流程答复当前问题。' if info.get('execution_kind')=='delivery' else '需求分析正在等待人工决定，请在独立需求分析页面查看当前版本问题与评审。'
            alerts.append({'id':alert_id,'taskId':active,'jiraKey':'','level':level,'message':message,'elapsedMinutes':min(elapsed,525600)})
            once_notice(b,alert_id+':'+str(int(elapsed/max(1,policy['reminderMinutes']))),'智研：分析待决定',message,task_id=active,run_id=run_id)
        active_runs.append({'taskId':active,'runId':run_id,'state':state})
    if b.db.execute("SELECT 1 FROM seat_commands WHERE status='awaiting_local'").fetchone() and state=='idle':state='awaiting_local'
    if any(c['status']=='fail' for c in checks):state='config_error'
    auto=b.cfg.get('seat_auto_permit') or {}
    try:auto=auto if dt.datetime.fromisoformat(auto['until']).timestamp()>time.time() else None
    except (KeyError,TypeError,ValueError):auto=None
    active_runs=list({item['runId']:item for item in active_runs}.values())
    for item in active_runs:
        if any(a['taskId']==item['taskId'] and (':native:' in a['id'] or ':blocked' not in a['id']) for a in alerts):item['state']='waiting_decision'
    if active_runs:
        representative=next((run for run in active_runs if run['state']=='waiting_decision'),active_runs[0])
        active=representative['taskId'];run_id=representative['runId']
        if state not in ('config_error','error'):state=representative['state']
    return {'activeRuns':active_runs,'acceptingWork':not offline_requested(b),'bridgeVersion':bridge_version(),'capabilities':['seat-concurrency-v1','seat-admin-upgrade-v1','seat-launch-options-v1','managed-session-v1','harness-repository-management-v1','full-visible-text','phase-gate-v1','jira-workload-v1','seat-rule-intake-v1','platform-dispatch-v1','execution-recovery-v1','native-wait-v1','seat-auto-retry-v1','command-longpoll-v1','analysis-execution-v1','delivery-flow-v1','delivery-work-review-v1','delivery-executor-v1','delivery-rework-v1']+(['harness-root-launch-v1'] if b.cfg.get('claude_launch_mode','harness-root-v1')=='harness-root-v1' else ['harness-source-launch-compat-v1']),'checkedAt':now(),'revision':(b.cfg.get('seat_runtime') or {}).get('revision'),'state':state,'activeTaskId':active,'runId':run_id,'checks':checks,'alerts':alerts[:20],'tasks':tasks,'autoPermit':auto},registered

def refresh_registration(b,checks,state,stamp=None):
    """Recover runtime drift, with bounded retries and a fresh post-save check."""
    stamp=time.time() if stamp is None else stamp
    failures=[c for c in checks if c['status']=='fail' and c['id']!='registration_refresh']
    drift=bool(failures) and all(c['id']=='registration' for c in failures)
    renewal=bool(checks) and not failures and stamp-state.get('refreshedEpoch',0)>=3600
    if not drift and not renewal:return checks
    retry=state.get('registrationRefresh') or {}
    if stamp<retry.get('retryAfterEpoch',0):return checks
    try:
        if drift:
            from seats import auto_refresh_runtime
            auto_refresh_runtime(b)
        else:
            from seats import command as seat_command
            seat_command(b,['seat','check'])
        # Registration alone is not proof of readiness (files can change again).
        checks=inspect_configuration(b)
        if any(c['status']=='fail' for c in checks):
            raise BridgeError('刷新后的复检未通过')
        state.update(refreshedEpoch=stamp,checkedEpoch=stamp,registrationRefresh={'status':'succeeded','at':now()})
    except (RuntimeError,OSError,ValueError,subprocess.SubprocessError) as error:
        attempts=min(int(retry.get('attempts',0))+1,5)
        state['registrationRefresh']={'status':'deferred','at':now(),'attempts':attempts,'retryAfterEpoch':stamp+min(900,60*2**(attempts-1))}
        # Do not expose arbitrary exceptions, credentials or settings contents.
        checks=[c for c in checks if c['id']!='registration_refresh']
        reason=getattr(error,'reason',None)
        message={'busy':'席位仍有运行、启动请求或本机进程，空闲后自动重试，不会终止当前任务。',
                 'identity':'本机与服务端身份或登记版本不一致，需要人工核对；不会自动覆盖。',
                 'path':'运行路径或环境已变化，需要人工更新登记；不会自动改绑。'}.get(reason,'网络、登记请求或刷新后复检未通过，将自动重试。可在本机执行 harness seat check 定位。')
        checks.append({'id':'registration_refresh','label':'自动刷新登记','status':'fail','message':message})
    return checks


def tick(b):
    folder=setup(b);path=folder/'state.json';old=read_json(path) if path.is_file() else {}
    if time.time()-old.get('checkedEpoch',0)>=60:
        checks=inspect_configuration(b);old.update(checks=checks,checkedEpoch=time.time())
        atomic_json(path,old)
    checks=[c for c in (old.get('checks') or []) if c['id'] not in ('dingtalk','dingtalk_current')]
    checks=refresh_registration(b,checks,old)
    old['checks']=checks;atomic_json(path,old)
    presence,registered=collect(b,checks,folder)
    if presence['state']=='config_error':once_notice(b,'configuration:'+str((b.cfg.get('seat_runtime') or {}).get('revision'))+':'+str(int(time.time()/600)),'Paperclip：配置已变化','本机检查未通过，请打开席位管理页查看并刷新登记')
    presence['checkedAt']=dt.datetime.fromtimestamp(old.get('checkedEpoch',time.time()),dt.timezone.utc).isoformat()
    from harness_repositories import public_inventory
    if time.time()-old.get('repositoriesEpoch',0)>=60:
        old.update(repositories=public_inventory(b),repositoriesEpoch=time.time())
        atomic_json(path,old)
    presence['repositories']=old.get('repositories',[])
    heartbeat_started=now()
    api=seat_api(b);response=api.request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-seat-heartbeat',{**identity(b),**presence})
    b.cfg['_dispatch_rule']=response.get('dispatch')
    old.update(policy=response['policy'],dispatch=response.get('dispatch'),lastHeartbeat=now());atomic_json(path,old)
    process_commands(b,response,reconcile_before=heartbeat_started)
    if checks!=presence['checks']:
        presence['checks']=checks;presence['checkedAt']=now()
        if all(c['status']!='fail' for c in checks) and presence['state']=='config_error':presence['state']='idle'
        api.request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-seat-heartbeat',{**identity(b),**presence})
    # Native authorized jobs (including analysis without a Jira pilot) are
    # received by the regular watcher. The server grants each exact run lease.
    if not offline_requested(b) and all(c['status']!='fail' for c in checks):
        from outbound import poll
        poll(b)
    # Proactive scheduling only for registered, ready, explicitly allowlisted jobs.
    policy=response['policy']
    from jira_dispatch import authorized
    if not offline_requested(b) and (policy['mode']!='manual' or (response.get('dispatch') or {}).get('enabled')) and not (response.get('dispatch') or {}).get('intakePaused') and presence['state'] in ('idle','busy','waiting_decision','awaiting_local') and len(presence.get('activeRuns',[]))<response.get('maxConcurrentRuns',1):
        for task in presence['tasks']:
            p=registered.get(task['taskId'])
            if not task['ready'] or not p or (not authorized(b,p,response.get('dispatch')) and (policy['mode']=='manual' or task['jiraKey'] not in policy['jiraKeys'])):continue
            key='auto:'+task['taskId']+':'+str(presence['revision'])+':'+str(p['details'].get('platform_authorization_id','legacy'))+(':'+str((response.get('dispatch') or {}).get('revision')) if task.get('automatic') else '')
            if b.db.execute('SELECT 1 FROM seat_control_notices WHERE notice_key=?',(key,)).fetchone():continue
            request_id=str(uuid.uuid5(uuid.NAMESPACE_URL,b.cfg['agent_id']+key))
            try:
                created=api.request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-seat-auto-request',{**identity(b),'command':{'requestId':request_id,'kind':'start','taskId':task['taskId'],'revision':presence['revision'],'confirmNoOtherExecutor':True}})
                with b.db:b.db.execute('INSERT OR IGNORE INTO seat_control_notices VALUES(?,?)',(key,now()))
                process_commands(b,{**response,'commands':[created]})
            except BridgeError:pass
            break
    return presence

def process_commands(b,response,reconcile_before=None):
    folder=setup(b)
    with (folder/'delivery.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        _process_commands(b,response,folder,reconcile_before)


def _process_commands(b,response,folder,reconcile_before):
    path=folder/'state.json';old=read_json(path) if path.is_file() else {}
    checks=old.get('checks') or [];api=seat_api(b)
    registered={p['task_id']:p for row in b.db.execute('SELECT jira_key FROM pilots').fetchall() if (p:=b.pilot(row['jira_key']))['task_id']}
    # Reconcile website cancellation/expiry so stale local prompts cannot launch.
    remote={c['commandId']:c for c in response['commands']}
    for row in b.db.execute("SELECT command_id FROM seat_commands WHERE status='awaiting_local' AND updated_at<?",(reconcile_before or '',)).fetchall():
        if row['command_id'] not in remote:
            with b.db:b.db.execute("UPDATE seat_commands SET status='cancelled',updated_at=? WHERE command_id=?",(now(),row['command_id']))
    for command in response['commands']:
        previous=b.db.execute('SELECT * FROM seat_commands WHERE command_id=?',(command['commandId'],)).fetchone()
        if previous and previous['status'] in TERMINAL:continue
        if command['revision']!=(b.cfg.get('seat_runtime') or {}).get('revision'):
            if not previous:
                with b.db:b.db.execute('INSERT INTO seat_commands(command_id,payload,status,updated_at) VALUES(?,?,?,?)',(command['commandId'],json.dumps(command),'queued',now()))
            receipt(b,command,'failed','本机登记版本已变化，请重新选择席位');continue
        if not previous:
            with b.db:b.db.execute('INSERT INTO seat_commands(command_id,payload,status,updated_at) VALUES(?,?,?,?)',(command['commandId'],json.dumps(command),'queued',now()))
        if command['kind'] in ('check','refresh'):
            if previous:continue # Unknown receipt outcome is reconciled, never reexecute blindly.
            receipt(b,command,'accepted','本机已接收配置检查')
            try:
                if command['kind']=='refresh':
                    from seats import command as seat_command
                    seat_command(b,['seat','register'])
                checks=inspect_configuration(b);old.update(checks=checks,checkedEpoch=time.time());atomic_json(path,old)
                receipt(b,command,'succeeded' if all(c['status']!='fail' for c in checks) else 'failed','本机检查完成；检查结果见席位管理页')
            except (BridgeError,OSError,ValueError):receipt(b,command,'failed','刷新未完成，请在本机查看登记和活动运行')
        elif command['kind']=='start':
            if offline_requested(b):receipt(b,command,'denied','本机已暂停接单，请先执行 harness online');continue
            p=registered.get(command['taskId'])
            if not p:receipt(b,command,'failed','本机未登记该任务，不能执行');continue
            if previous and previous['opened']:continue
            if (response.get('dispatch') or {}).get('intakePaused'):continue
            policy=response['policy']
            from jira_dispatch import authorized
            automatic=authorized(b,p,response.get('dispatch')) or (policy['mode']=='auto' and p['jira_key'] in policy['jiraKeys'] and bool(permit(b,p['jira_key'])))
            try:receipt(b,command,'awaiting_local','已到达本机，等待终端确认' if not automatic else '网页调度或本机限时授权有效，准备自动打开可见终端')
            except BridgeError:continue
            # Persist handoff before external UI action. No double terminal after crash.
            with b.db:b.db.execute('UPDATE seat_commands SET opened=1 WHERE command_id=?',(command['commandId'],))
            try:
                open_terminal(b,command,automatic)
                # Visible terminal is the delivery acknowledgement; slow OS notifications
                # must not delay another command or its receipt.
            except BridgeError:
                receipt(b,command,'failed','本机终端自动打开失败，请检查桌面登录、终端权限和本机日志')
                if p['details'].get('platform_dispatch'):
                    b.update(p['jira_key'],last_error='本机终端自动打开失败，请检查桌面登录和终端权限')
                    api.request('PATCH','/issues/'+p['task_id'],{'status':'blocked','unblockDescriptor':{'owner':'board','action':'请在席位电脑检查桌面登录、终端权限和日志；修复后重试接入并重新派单'}})


def accept(b,command_id,automatic=False,deny=False):
    folder=setup(b);uuid.UUID(command_id)
    if not sys.stdin.isatty() or not sys.stdout.isatty():raise BridgeError('请在本机可见终端确认启动')
    with (folder/('accept-'+command_id+'.lock')).open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise BridgeError('另一启动请求正在连接，请先处理该终端')
        row=b.db.execute('SELECT * FROM seat_commands WHERE command_id=?',(command_id,)).fetchone()
        if not row or row['status']!='awaiting_local':raise BridgeError('请求不存在、已领取或取消')
        command=json.loads(row['payload'])
        mapped=b.db.execute('SELECT jira_key FROM pilots WHERE task_id=?',(command['taskId'],)).fetchone()
        if not mapped:raise BridgeError('本机任务登记已变化')
        p=b.pilot(mapped['jira_key'])
        if deny:receipt(b,command,'denied','研发人员已在本机拒绝启动');return
        from jira_dispatch import rule_for
        if (rule_for(b) or {}).get('intakePaused'):
            receipt(b,command,'denied','席位已暂停接单，恢复后重新请求；当前运行继续');return
        if automatic:
            agent=seat_api(b).request('GET','/agents/'+b.cfg['agent_id']);policy=(agent.get('adapterConfig') or {}).get('dsp7SeatPolicy') or DEFAULT_POLICY
            from jira_dispatch import authorized,verify
            rule=(agent.get('adapterConfig') or {}).get('dsp7JiraDispatch')
            if p['details'].get('platform_dispatch'):verify(b,p['task_id'],start=True)
            elif authorized(b,p,rule):verify(b,p['task_id'],start=True)
            elif policy['mode']!='auto' or p['jira_key'] not in policy['jiraKeys'] or not permit(b,p['jira_key']):raise BridgeError('本机自动授权失效，请手动核对请求')
        else:
            print('网页请求执行 '+p['jira_key']+'。请确认没有其他 Claude／人员正在执行此工单。',flush=True)
            if input('输入 yes 启动；其他输入拒绝：').strip().lower()!='yes':receipt(b,command,'denied','研发人员已在本机拒绝启动');return
        # Recheck receipt on server immediately before wake. Website cancellation
        # wins while awaiting_local; accepted is an atomic, irreversible claim.
        receipt(b,command,'accepted','研发人员已确认，开始核验与连接')
        from interactive import start
        try:
            start(b,p['jira_key'],True,seat_command=command)
        except BaseException:
            if p['details'].get('jira_dispatch'):
                b.update(p['jira_key'],last_error='自动启动或连接失败，请核对任务、运行和本机日志')
                with contextlib.suppress(Exception):b.pc.request('PATCH','/issues/'+p['task_id'],{'status':'blocked','unblockDescriptor':{'owner':'board','action':'请检查平台派单授权、本机终端和执行日志后重试启动'}})
            with contextlib.suppress(Exception):receipt(b,command,'failed','本机启动或连接失败，请核对任务、运行和本机日志')
            raise

def cli(b,argv):
    parser=argparse.ArgumentParser(prog='harness seat');sub=parser.add_subparsers(dest='action',required=True)
    p=sub.add_parser('accept');p.add_argument('command_id');p.add_argument('--automatic',action='store_true');p.add_argument('--deny',action='store_true')
    p=sub.add_parser('allow-auto-start');p.add_argument('--jira',action='append',required=True);p.add_argument('--minutes',type=int,default=60);p.add_argument('--confirm-no-other-executor',action='store_true')
    sub.add_parser('revoke-auto-start');sub.add_parser('pending')
    args=parser.parse_args(argv)
    if args.action=='accept':accept(b,args.command_id,args.automatic,args.deny)
    elif args.action=='pending':
        setup(b);print(json.dumps([{'command_id':r['command_id'],'status':r['status']} for r in b.db.execute("SELECT * FROM seat_commands WHERE status NOT IN ('succeeded','failed','denied','cancelled','expired')")],ensure_ascii=False,indent=2))
    else:
        with (Path(b.cfg['database']).parent/'config.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX);cfg=read_json(b.config_path)
            if args.action=='allow-auto-start':
                if not sys.stdin.isatty() or not args.confirm_no_other_executor or not 1<=args.minutes<=480:raise BridgeError('限时自动授权需在本机终端确认无其他执行者，有效期 1–480 分钟')
                keys=[]
                for key in args.jira:
                    b.pilot(key);keys.append(key)
                cfg['seat_auto_permit']={'jiraKeys':keys,'until':(dt.datetime.now(dt.timezone.utc)+dt.timedelta(minutes=args.minutes)).isoformat()}
            else:cfg.pop('seat_auto_permit',None)
            atomic_json(b.config_path,cfg);print('本机自动启动授权已'+('撤销' if args.action=='revoke-auto-start' else '登记'))


def bridge_version():
    path=Path(__file__).resolve().parent/'.bundle-sha256'
    value=path.read_text(encoding='utf-8').strip() if path.is_file() else ''
    return value if len(value)==64 and all(c in '0123456789abcdef' for c in value) else None
