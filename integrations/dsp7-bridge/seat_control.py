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
from pilot import Bridge, BridgeError, atomic_json, now, read_json, ACTIVE
from seats import identity, runtime_profile, seat_api, verify_runtime

DEFAULT_POLICY={'mode':'manual','jiraKeys':[],'reminderMinutes':10,'escalationMinutes':30}
TERMINAL={'succeeded','failed','denied','cancelled','expired'}

def setup(b):
    b.db.executescript('''CREATE TABLE IF NOT EXISTS seat_commands(command_id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,opened INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS seat_control_notices(notice_key TEXT PRIMARY KEY,created_at TEXT NOT NULL);''')
    folder=Path(b.cfg['database']).parent/'seat-control';folder.mkdir(mode=0o700,exist_ok=True)
    return folder

def notify(title,message):
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
    script='on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\nend run'
    result=subprocess.run(['/usr/bin/osascript','-e',script,title,message],capture_output=True,timeout=15)
    return 'submitted' if result.returncode==0 else 'failed'

def once_notice(b,key,title,message):
    if b.db.execute('SELECT 1 FROM seat_control_notices WHERE notice_key=?',(key,)).fetchone():return
    # Record before delivery: unknown outcomes must not cause a notification storm.
    with b.db:b.db.execute('INSERT INTO seat_control_notices VALUES(?,?)',(key,now()))
    result=notify(title,message)
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
    latest=b.db.execute("SELECT data FROM events WHERE kind='dingtalk_notification' ORDER BY id DESC LIMIT 1").fetchone()
    if latest:
        status=json.loads(latest['data']).get('status')
        add('dingtalk','钉钉最近提醒','pass' if status=='submitted' else 'warn','平台已受理，接收人是否已读未知' if status=='submitted' else '发送失败或投递结果未知；请在本机检查 DWS 登录及桥事件，不自动重发')
    return checks

def receipt(b,command,status,message,run_id=None):
    result=seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-seat-command-result',{**identity(b),'commandId':command['commandId'],'status':status,'message':message,'runId':run_id})
    with b.db:b.db.execute('UPDATE seat_commands SET status=?,updated_at=? WHERE command_id=?',(result['status'],now(),command['commandId']))
    return result

def open_terminal(b,command,automatic=False):
    entry=Path(__file__).resolve().parent/'interactive.py'
    cli=[sys.executable,str(entry),'seat','accept',command['commandId']]
    if automatic:cli.append('--automatic')
    if sys.platform=='darwin':
        shell=' '.join(shlex.quote(x) for x in cli)
        script='on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run'
        result=subprocess.run(['/usr/bin/osascript','-e',script,shell],capture_output=True,timeout=20)
        if result.returncode:raise BridgeError('无法打开 Terminal，请核对本机终端权限')
    elif sys.platform=='linux':
        for name,separator in [('gnome-terminal','--'),('konsole','-e'),('x-terminal-emulator','-e'),('xterm','-e')]:
            terminal=shutil.which(name)
            if terminal:
                subprocess.Popen([terminal,separator,*cli],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                return
        raise BridgeError('Linux 自动执行需要桌面终端程序；请安装终端并保持图形登录')
    elif sys.platform=='win32':
        subprocess.Popen(cli,creationflags=subprocess.CREATE_NEW_CONSOLE)
    else:raise BridgeError('自动打开可见终端仅支持 macOS 和 Linux 桌面')

def permit(b,key):
    value=b.cfg.get('seat_auto_permit') or {}
    try:return value if dt.datetime.fromisoformat(value['until']).timestamp()>time.time() and key in value.get('jiraKeys',[]) else None
    except (KeyError,TypeError,ValueError):return None

def collect(b,checks,folder):
    saved=read_json(folder/'state.json') if (folder/'state.json').is_file() else {}
    policy=saved.get('policy') or DEFAULT_POLICY
    b.cfg['_dispatch_rule']=saved.get('dispatch')
    tasks=[];alerts=[];active=None;run_id=None;state='idle';registered={}
    for row in b.db.execute('SELECT jira_key FROM pilots ORDER BY updated_at DESC LIMIT 50').fetchall():
        p=b.pilot(row['jira_key'])
        if not p['task_id']:continue
        try:task=b.pc.request('GET','/issues/'+p['task_id'])
        except BridgeError:continue
        if task['status'] in ('done','cancelled'):continue
        registered[p['task_id']]=p
        runs=b.runs_for(p);running=[r for r in runs if r['status'] in ACTIVE]
        domain=b.state(p,required=False);cur=b.jc.current_confirmation(domain)
        ready=not running and not p['enabled'] and task['status'] in ('backlog','todo') and not p.get('last_error')
        tasks.append({'taskId':p['task_id'],'jiraKey':p['jira_key'],'status':task['status'],'mode':'replay' if p['details'].get('mode')=='replay' else 'formal','ready':ready,'automatic':bool(p['details'].get('jira_dispatch'))})
        if running:state='busy';active=p['task_id'];run_id=running[0]['id']
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
                once_notice(b,aid+':'+level+':'+str(bucket),'Paperclip：待决策'+('（超时升级）' if level=='urgent' else ''),message)
            dingtalk_notice(b,policy,p['jira_key'],aid+':'+level+':'+str(bucket),('【超时升级】' if level=='urgent' else '【待决策】')+message,p['task_id'])
            if b.cfg.get('notifications')=='dingtalk' and p['details'].get('notifications_authorized'):
                # Reuse existing Harness delivery authorization/dedup, no new receiver.
                b.notify_block(p,domain)
        elif p.get('last_error') or task['status']=='blocked':
            alerts.append({'id':p['jira_key']+':blocked','taskId':p['task_id'],'jiraKey':p['jira_key'],'level':'warning','message':p['jira_key']+' 执行已阻塞，请查看任务与本机日志','elapsedMinutes':0})
            once_notice(b,p['jira_key']+':blocked:'+p['updated_at'],'Paperclip：执行阻塞',alerts[-1]['message'])
            dingtalk_notice(b,policy,p['jira_key'],p['jira_key']+':blocked:'+p['updated_at'],alerts[-1]['message'],p['task_id'])
    if b.db.execute("SELECT 1 FROM seat_commands WHERE status='awaiting_local'").fetchone() and state=='idle':state='awaiting_local'
    if any(c['status']=='fail' for c in checks):state='config_error'
    auto=b.cfg.get('seat_auto_permit') or {}
    try:auto=auto if dt.datetime.fromisoformat(auto['until']).timestamp()>time.time() else None
    except (KeyError,TypeError,ValueError):auto=None
    return {'checkedAt':now(),'revision':(b.cfg.get('seat_runtime') or {}).get('revision'),'state':state,'activeTaskId':active,'runId':run_id,'checks':checks,'alerts':alerts[:20],'tasks':tasks,'autoPermit':auto},registered

def tick(b):
    folder=setup(b);path=folder/'state.json';old=read_json(path) if path.is_file() else {}
    if time.time()-old.get('checkedEpoch',0)>=60:
        checks=inspect_configuration(b);old.update(checks=checks,checkedEpoch=time.time())
        atomic_json(path,old)
    checks=old.get('checks') or []
    if checks and all(c['status']!='fail' for c in checks) and time.time()-old.get('refreshedEpoch',0)>=3600:
        from seats import command as seat_command
        seat_command(b,['seat','check'])
        old['refreshedEpoch']=time.time();atomic_json(path,old)
    presence,registered=collect(b,checks,folder)
    if presence['state']=='config_error':once_notice(b,'configuration:'+str((b.cfg.get('seat_runtime') or {}).get('revision'))+':'+str(int(time.time()/600)),'Paperclip：配置已变化','本机检查未通过，请打开席位管理页查看并刷新登记')
    presence['checkedAt']=dt.datetime.fromtimestamp(old.get('checkedEpoch',time.time()),dt.timezone.utc).isoformat()
    api=seat_api(b);response=api.request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-seat-heartbeat',{**identity(b),**presence})
    b.cfg['_dispatch_rule']=response.get('dispatch')
    old.update(policy=response['policy'],dispatch=response.get('dispatch'),lastHeartbeat=now());atomic_json(path,old)
    # Reconcile website cancellation/expiry so stale local prompts cannot launch.
    remote={c['commandId']:c for c in response['commands']}
    for row in b.db.execute("SELECT command_id FROM seat_commands WHERE status='awaiting_local'").fetchall():
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
            p=registered.get(command['taskId'])
            if not p:receipt(b,command,'failed','本机未登记该任务，不能执行');continue
            if previous and previous['opened']:continue
            if (response.get('dispatch') or {}).get('intakePaused'):continue
            policy=response['policy']
            from jira_dispatch import authorized
            automatic=authorized(b,p,response.get('dispatch')) or (policy['mode']=='auto' and p['jira_key'] in policy['jiraKeys'] and bool(permit(b,p['jira_key'])))
            receipt(b,command,'awaiting_local','已到达本机，等待终端确认' if not automatic else '网页调度或本机限时授权有效，准备自动打开可见终端')
            # Persist handoff before external UI action. No double terminal after crash.
            with b.db:b.db.execute('UPDATE seat_commands SET opened=1 WHERE command_id=?',(command['commandId'],))
            try:
                open_terminal(b,command,automatic)
                once_notice(b,'start:'+command['commandId'],'Paperclip：启动请求到达',p['jira_key']+' 已打开终端，请核对并确认')
            except BridgeError:receipt(b,command,'failed','Terminal 自动打开失败，请在本机使用 harness seat accept')
    if checks!=presence['checks']:
        presence['checks']=checks;presence['checkedAt']=now()
        if all(c['status']!='fail' for c in checks) and presence['state']=='config_error':presence['state']='idle'
        api.request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-seat-heartbeat',{**identity(b),**presence})
    # Proactive scheduling only for registered, ready, explicitly allowlisted jobs.
    policy=response['policy']
    from jira_dispatch import authorized
    if (policy['mode']!='manual' or (response.get('dispatch') or {}).get('enabled')) and not (response.get('dispatch') or {}).get('intakePaused') and presence['state']=='idle':
        for task in presence['tasks']:
            p=registered.get(task['taskId'])
            if not task['ready'] or not p or (not authorized(b,p,response.get('dispatch')) and (policy['mode']=='manual' or task['jiraKey'] not in policy['jiraKeys'])):continue
            key='auto:'+task['taskId']+':'+str(presence['revision'])+(':'+str((response.get('dispatch') or {}).get('revision')) if task.get('automatic') else '')
            if b.db.execute('SELECT 1 FROM seat_control_notices WHERE notice_key=?',(key,)).fetchone():continue
            request_id=str(uuid.uuid5(uuid.NAMESPACE_URL,b.cfg['agent_id']+key))
            try:
                api.request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-seat-auto-request',{**identity(b),'command':{'requestId':request_id,'kind':'start','taskId':task['taskId'],'revision':presence['revision'],'confirmNoOtherExecutor':True}})
                with b.db:b.db.execute('INSERT OR IGNORE INTO seat_control_notices VALUES(?,?)',(key,now()))
            except BridgeError:pass
            break
    return presence

def accept(b,command_id,automatic=False,deny=False):
    folder=setup(b);uuid.UUID(command_id)
    if not sys.stdin.isatty() or not sys.stdout.isatty():raise BridgeError('请在本机可见终端确认启动')
    with (folder/'accept.lock').open('a') as lock:
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
            if authorized(b,p,rule):verify(b,p['task_id'],start=True)
            elif policy['mode']!='auto' or p['jira_key'] not in policy['jiraKeys'] or not permit(b,p['jira_key']):raise BridgeError('本机自动授权失效，请手动核对请求')
        else:
            print('网页请求执行 '+p['jira_key']+'。请确认没有其他 Claude／人员正在执行此工单。',flush=True)
            if input('输入 yes 启动；其他输入拒绝：').strip().lower()!='yes':receipt(b,command,'denied','研发人员已在本机拒绝启动');return
        # Recheck receipt on server immediately before wake. Website cancellation
        # wins while awaiting_local; accepted is an atomic, irreversible claim.
        receipt(b,command,'accepted','研发人员已确认，开始核验与连接')
        from interactive import start
        try:
            verify_runtime(b)
            start(b,p['jira_key'],True,seat_command=command)
        except BaseException:
            if p['details'].get('jira_dispatch'):
                b.update(p['jira_key'],last_error='自动启动或连接失败，请核对任务、运行和本机日志')
                with contextlib.suppress(Exception):b.pc.request('PATCH','/issues/'+p['task_id'],{'status':'blocked'})
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
