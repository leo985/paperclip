"""Machine-bound seats and local-only Project repository mappings."""
import argparse
from platform_support import fcntl
import hashlib
import json
import os
import shutil
from pathlib import Path
import re
import subprocess
import sys
import uuid
from functools import lru_cache
from pilot import Api, BridgeError, atomic_json, read_json
from platform_support import WINDOWS, credential_private, claude_argv


@lru_cache(maxsize=1)
def fingerprint():
    if sys.platform == 'darwin':
        output=subprocess.run(['/usr/sbin/ioreg','-rd1','-c','IOPlatformExpertDevice'],capture_output=True,text=True,check=True,timeout=15).stdout
        match=re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"',output)
        if not match:raise BridgeError('无法读取本机身份')
        value=match.group(1)
    elif WINDOWS:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,r'SOFTWARE\Microsoft\Cryptography',0,winreg.KEY_READ|winreg.KEY_WOW64_64KEY) as key:
            value=winreg.QueryValueEx(key,'MachineGuid')[0]
    else:
        value=Path('/etc/machine-id').read_text(encoding='utf-8').strip()
    return hashlib.sha256(value.encode()).hexdigest()


def identity(b):
    seat=b.cfg.get('seat') or {}
    if seat.get('agent_id')!=b.cfg['agent_id'] or seat.get('machine_fingerprint')!=fingerprint():raise BridgeError('请先登记本机席位；禁止复制其他电脑的席位配置')
    return {'seat_id':seat['agent_id'],'machine_id':seat['machine_id'],'machine_fingerprint':seat['machine_fingerprint']}


def seat_api(b):
    identity(b)
    path=Path(b.cfg.get('seat_credential_file') or '')
    if not credential_private(path):raise BridgeError('请先登记仅当前用户可读的本席位 Agent 凭证')
    credentials=read_json(path)
    if credentials.get('agentId')!=b.cfg['agent_id'] or credentials.get('companyId')!=b.cfg['company_id']:raise BridgeError('席位凭证身份不匹配')
    return Api(b.cfg['paperclip_url'].rstrip('/')+'/api',credentials['token'])


def runtime_profile(b,command,settings,environment_id):
    if WINDOWS:
        from platform_support import windows_git_bash
        windows_git_bash()
    executable=shutil.which(command)
    if not executable:raise BridgeError('找不到 Claude 可执行文件，请指定 --claude /绝对路径/claude')
    executable=str(Path(executable).absolute())
    # Keep the stable symlink path: Claude upgrades can replace its target.
    if not os.access(executable,os.X_OK):raise BridgeError('Claude 文件不可执行')
    try:
        version=subprocess.run(claude_argv(executable,['--version']),capture_output=True,text=True,encoding='utf-8',check=True,timeout=20).stdout.strip()
    except (OSError,subprocess.SubprocessError):raise BridgeError('无法读取 Claude 版本') from None
    if not version or len(version)>200:raise BridgeError('Claude 版本输出无效')
    root=Path(b.cfg['harness_root']).expanduser().resolve(strict=True)
    if not (root/'harness/bin/harness').is_file():raise BridgeError('Harness 根目录无效')
    settings_file=None;digest=None
    if settings:
        path=Path(settings).expanduser()
        if not path.is_absolute():raise BridgeError('配置文件必须为绝对路径')
        try:path=path.resolve(strict=True)
        except OSError:raise BridgeError('Claude 配置文件不存在，请检查本机路径') from None
        if path.suffix!='.json' or not path.is_file():raise BridgeError('请选择有效的 JSON 配置文件')
        try:
            contents=path.read_bytes()
            if not isinstance(json.loads(contents),dict):raise ValueError()
        except (OSError,ValueError):raise BridgeError('无法读取有效的 Claude JSON 配置；内容不会上传') from None
        settings_file=str(path);digest=hashlib.sha256(contents).hexdigest()
    return {'environmentId':environment_id,'claudeCommand':executable,'claudeVersion':version,
            'claudeSettingsFile':settings_file,'configurationSource':'local-settings-file' if settings_file else 'local-default',
            'harnessRoot':str(root),'settingsDigest':digest}


def verify_runtime(b):
    stored=b.cfg.get('seat_runtime')
    if not stored:raise BridgeError('请先运行 harness seat register 登记本机 Claude 配置')
    identity(b)
    current=runtime_profile(b,stored['claudeCommand'],stored.get('claudeSettingsFile'),stored['environmentId'])
    if any(stored.get(key)!=value for key,value in current.items()):raise BridgeError('本机 Claude 版本、配置或 Harness 路径已变化，请运行 harness seat register 刷新')
    # Machine diagnostics need the full registration, not the board user's
    # permission-filtered display view. Agent mode already uses a seat key.
    api=b.pc if b.agent_mode else seat_api(b)
    agent=api.request('GET','/agents/'+b.cfg['agent_id'])
    remote=(agent.get('adapterConfig') or {}).get('dsp7SeatRuntime') or {}
    seat=(agent.get('adapterConfig') or {}).get('dsp7Seat') or {}
    local=identity(b)
    if agent.get('defaultEnvironmentId')!=current['environmentId'] or remote.get('revision')!=stored.get('revision') or any(remote.get(key)!=value for key,value in current.items()) or seat.get('machineId')!=local['machine_id'] or seat.get('machineFingerprint')!=local['machine_fingerprint']:raise BridgeError('服务端席位、环境或登记版本已变化，请联系管理员核对并重新登记')
    api.request('GET','/agents/'+b.cfg['agent_id']+'/dsp7-seat-registration')
    return current


def reserve(b,task_id):
    local=identity(b)
    if b.agent_mode:
        api=b.pc
    else:
        credentials=read_json(b.cfg.get('seat_credential_file') or '')
        if credentials.get('agentId')!=b.cfg['agent_id'] or credentials.get('companyId')!=b.cfg['company_id']:raise BridgeError('席位凭证身份不匹配')
        path=Path(b.cfg['seat_credential_file'])
        if not credential_private(path):raise BridgeError('席位凭证文件必须仅当前用户可读')
        api=Api(b.cfg['paperclip_url'].rstrip('/')+'/api',credentials['token'])
    return api.request('POST','/issues/'+task_id+'/dsp7-reservation',local)


def normalize_remote(value):
    value=re.sub(r'^ssh://(?:[^@/]+@)?', '', str(value).strip())
    value=re.sub(r'^https?://(?:[^@/]+@)?','',value)
    return re.sub(r'^[^@]+@([^:]+):',r'\1/',value).rstrip('/').removesuffix('.git')


def source_repo(b,project_id,workspace):
    identity(b)
    mapping=(b.cfg.get('project_repositories') or {}).get(project_id+':'+workspace['id'])
    if not mapping:raise BridgeError('本席位尚未绑定该 Project 工作区；请执行 harness repo bind')
    if not workspace.get('repoUrl'):raise BridgeError('共享工作区需要仓库 URL，不使用其他电脑的 cwd')
    repo=Path(mapping).expanduser()
    if not repo.is_absolute():raise BridgeError('本机仓库映射必须是绝对路径')
    repo=repo.resolve(strict=True)
    from jira_intake import git
    roots=[Path(x).expanduser().resolve(strict=True) for x in b.cfg.get('intake_repository_roots',[])]
    if repo==b.root or not any(repo.is_relative_to(root) for root in roots):raise BridgeError('源仓库不在本机业务源码白名单内')
    if Path(git(repo,'rev-parse','--show-toplevel')).resolve()!=repo:raise BridgeError('本机映射不再指向 Git 根目录')
    if normalize_remote(git(repo,'remote','get-url','origin'))!=normalize_remote(workspace['repoUrl']):raise BridgeError('本机仓库 origin 已变化，停止执行')
    return repo


def check(b,pilot):
    d=pilot['details']
    if d.get('seat_id'):
        verify_runtime(b)
        local=identity(b)
        if d['seat_id']!=local['seat_id'] or d['machine_id']!=local['machine_id']:raise BridgeError('本工单属于其他执行席位')
        reserve(b,pilot['task_id'])
    elif d.get('mode')!='replay':
        raise BridgeError('正式工单必须通过新版网页接入并绑定执行席位；旧登记需人工迁移')


def command(b,argv):
    with (Path(b.cfg['database']).parent/'config.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        b.cfg=read_json(b.config_path)
        return _command(b,argv)


def _command(b,argv):
    p=argparse.ArgumentParser(prog='harness '+argv[0]);sub=p.add_subparsers(dest='action',required=True)
    if argv[0]=='seat':
        sub.add_parser('info')
        register=sub.add_parser('register');register.add_argument('--claude');register.add_argument('--settings');register.add_argument('--use-default-settings',action='store_true');register.add_argument('--environment')
        sub.add_parser('check')
        init=sub.add_parser('init');init.add_argument('--name',required=True);init.add_argument('--credential-file')
    else:
        sub.add_parser('list')
        bind=sub.add_parser('bind');bind.add_argument('--project',required=True);bind.add_argument('--workspace',required=True);bind.add_argument('--path',required=True)
    args=p.parse_args(argv[1:])
    if argv[0]=='seat' and args.action in ('register','check'):
        api=seat_api(b)
        me=api.request('GET','/agents/me')
        if me.get('id')!=b.cfg['agent_id']:raise BridgeError('凭证不属于本席位')
        agent=api.request('GET','/agents/'+b.cfg['agent_id'])
        stored=b.cfg.get('seat_runtime') or {}
        if args.action=='check':
            profile=verify_runtime(b)
        else:
            if args.settings and args.use_default_settings:raise BridgeError('--settings 与 --use-default-settings 不能同时使用')
            environment_id=args.environment or agent.get('defaultEnvironmentId')
            if not environment_id:raise BridgeError('请管理员先为席位设置执行环境')
            settings=None if args.use_default_settings else args.settings or stored.get('claudeSettingsFile')
            if not settings and not args.use_default_settings:
                candidate=Path(b.cfg['harness_root'])/'.claude/settings.local.json'
                if candidate.is_file():settings=str(candidate)
            profile=runtime_profile(b,args.claude or stored.get('claudeCommand') or 'claude',settings,environment_id)
        result=api.request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-seat-registration',{**identity(b),'runtime':profile})
        b.cfg['execution_transport']=(agent.get('adapterConfig') or {}).get('dsp7Transport') or 'ssh'
        b.cfg['seat_runtime']=result
        atomic_json(b.config_path,b.cfg)
        print(json.dumps({'registration':result,'message':'登记已刷新；网页选择本席位即可复用现有智能体。登记不代表电脑持续在线。'},ensure_ascii=False,indent=2))
        return
    elif argv[0]=='seat' and args.action=='init':
        current=b.cfg.get('seat') or {}
        fp=fingerprint()
        if current and current.get('machine_fingerprint')!=fp:raise BridgeError('配置属于另一台电脑，请使用独立 Agent 和接入配置')
        agent=b.pc.request('GET','/agents/'+b.cfg['agent_id']);config=dict(agent.get('adapterConfig') or {});remote=config.get('dsp7Seat') or {}
        mid=current.get('machine_id') or str(uuid.uuid4())
        if remote and (remote.get('machineId')!=mid or remote.get('machineFingerprint')!=fp):raise BridgeError('该 Agent 已绑定另一席位，不可覆盖；请为新电脑创建独立 Agent')
        if not args.name.strip():raise BridgeError('席位名称不能为空')
        b.cfg['seat']={'agent_id':b.cfg['agent_id'],'machine_id':mid,'machine_fingerprint':fp,'name':args.name.strip()}
        if args.credential_file:
            path=Path(args.credential_file).expanduser().resolve(strict=True)
            if not credential_private(path):raise BridgeError('Agent 凭证文件必须仅当前用户可读')
            credentials=read_json(path)
            if credentials.get('companyId')!=b.cfg['company_id'] or credentials.get('agentId')!=b.cfg['agent_id']:raise BridgeError('Agent 凭证身份不匹配')
            me=Api(b.cfg['paperclip_url'].rstrip('/')+'/api',credentials['token']).request('GET','/agents/me')
            if me.get('id')!=b.cfg['agent_id']:raise BridgeError('凭证不属于本席位 Agent')
            b.cfg['seat_credential_file']=str(path)
        atomic_json(b.config_path,b.cfg)
        config.update(dsp7WebJiraIntake=True,dsp7Seat={'machineId':mid,'machineFingerprint':fp,'name':args.name.strip(),'intakeUserIds':b.cfg.get('paperclip_intake_user_ids',[])})
        # Server configuration is an administrator operation; never broaden bridge permissions.
        print(json.dumps({'administrator_adapter_config':{'dsp7WebJiraIntake':True,'dsp7Seat':config['dsp7Seat']},'registration_pending':not bool(remote)},ensure_ascii=False,indent=2))
    elif argv[0]=='repo' and args.action=='bind':
        from jira_intake import git
        identity(b)
        for value in (args.project,args.workspace):uuid.UUID(value)
        project=b.pc.request('GET','/projects/'+args.project)
        if project.get('companyId')!=b.cfg['company_id'] or project.get('archivedAt'):raise BridgeError('Project 不可用')
        workspace=next((w for w in project.get('workspaces',[]) if w['id']==args.workspace),None)
        if not workspace or not workspace.get('repoUrl'):raise BridgeError('共享工作区必须配置仓库 URL')
        path=Path(args.path).expanduser()
        if not path.is_absolute():raise BridgeError('本机仓库路径必须为绝对路径')
        repo=path.resolve(strict=True)
        roots=[Path(x).expanduser().resolve(strict=True) for x in b.cfg.get('intake_repository_roots',[])]
        if repo==b.root or not any(repo.is_relative_to(root) for root in roots):raise BridgeError('请选择本机白名单内的业务源码仓库')
        if Path(git(repo,'rev-parse','--show-toplevel')).resolve()!=repo:raise BridgeError('必须绑定 Git 根目录')
        if normalize_remote(git(repo,'remote','get-url','origin'))!=normalize_remote(workspace['repoUrl']):raise BridgeError('本地 origin 与共享仓库 URL 不一致')
        base=workspace.get('repoRef') or workspace.get('defaultRef')
        if not base or base.startswith('-'):raise BridgeError('共享工作区缺少有效基线分支')
        git(repo,'rev-parse','--verify',base+'^{commit}')
        # Do not change a mapping underneath a registered, unfinished task.
        for row in b.db.execute('SELECT config FROM pilots'):
            d=json.loads(row['config'])
            if d.get('project_id')==args.project and d.get('source_workspace_id')==args.workspace and d.get('source_repo')!=str(repo):raise BridgeError('该工作区已有登记工单；请人工核对后迁移路径')
        b.cfg.setdefault('project_repositories',{})[args.project+':'+args.workspace]=str(repo)
        atomic_json(b.config_path,b.cfg)
    if argv[0]=='seat':print(json.dumps({'seat':b.cfg.get('seat'),'agent_id':b.cfg['agent_id'],'runtime':b.cfg.get('seat_runtime')},ensure_ascii=False,indent=2))
    else:print(json.dumps(b.cfg.get('project_repositories',{}),ensure_ascii=False,indent=2))
