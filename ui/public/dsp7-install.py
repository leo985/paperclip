#!/usr/bin/env python3
"""Single-command personal seat installer. Standard library; no model/Jira keys uploaded."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
import urllib.parse
import uuid
import zipfile

FILES={'jira_dispatch.py','pilot.py','seats.py','seat_control.py','onboard.py','interactive.py','interactive_wait.py','jira_intake.py','claude-interactive-wrapper','install_launchagent.py','config.example.json','README.md','outbound.py','quick_install.py','install_service.py','platform_support.py','windows_terminal.py','watch_windows.py','harness_entry.py','install_windows.ps1'}

def choose(label,candidates,validator):
    candidates=list(dict.fromkeys(str(x) for x in candidates if validator(Path(x))))
    if len(candidates)==1:
        value=candidates[0];print(label+'：'+value)
        return Path(value)
    if candidates:
        print(label+'候选：')
        for i,value in enumerate(candidates,1):print(str(i)+'. '+value)
        raw=input('输入序号，或填写绝对路径：').strip()
        if raw.isdigit() and 1<=int(raw)<=len(candidates):return Path(candidates[int(raw)-1])
    else:raw=input('请输入'+label+'的绝对路径：').strip()
    path=Path(raw).expanduser()
    if not path.is_absolute() or not validator(path):raise RuntimeError(label+'无效，请准备后重新执行')
    return path.resolve()

def scan(roots,max_depth=3):
    found=[];seen=set()
    for root in roots:
        if not root.is_dir():continue
        root=root.resolve()
        for current,dirs,_ in os.walk(root):
            path=Path(current)
            if path in seen:dirs[:]=[];continue
            seen.add(path);found.append(path)
            dirs[:]=[d for d in dirs if not d.startswith('.') and d not in ('node_modules','build','dist','target')]
            if len(path.relative_to(root).parts)>=max_depth:dirs[:]=[]
            if len(found)>=3000:return found
    return found

def download(url,limit):
    with urllib.request.urlopen(url,timeout=30) as r:data=r.read(limit+1)
    if len(data)>limit:raise RuntimeError('下载文件超过大小限制')
    return data

def install_bundle(server,install_root):
    manifest=json.loads(download(server+'/dsp7-bridge-manifest.json',4096))
    digest=manifest['sha256']
    if len(digest)!=64 or any(x not in '0123456789abcdef' for x in digest):raise RuntimeError('安装包摘要无效')
    archive=download(server+'/dsp7-bridge.zip',10*1024*1024)
    if hashlib.sha256(archive).hexdigest()!=digest:raise RuntimeError('安装包版本正在更新或摘要不一致，请稍后重试')
    dest=install_root/digest[:16];dest.mkdir(parents=True,exist_ok=True,mode=0o700)
    import io
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        if any(n not in FILES for n in z.namelist()) or sum(x.file_size for x in z.infolist())>20*1024*1024:raise RuntimeError('安装包内容无效')
        for item in z.infolist():
            path=dest/item.filename
            if path.is_symlink():raise RuntimeError('安装目录包含符号链接，停止覆盖')
            path.write_bytes(z.read(item));path.chmod(0o700 if item.filename=='claude-interactive-wrapper' else 0o600)
    return dest

def jira_credentials(root,config_root,explicit=None):
    if explicit:
        path=Path(explicit).expanduser().resolve(strict=True)
        from platform_support import credential_private
        if not credential_private(path):raise RuntimeError('Jira 凭证文件必须仅当前用户可读（Windows 请检查文件安全权限）')
        value=json.loads(path.read_text(encoding='utf-8'))
        if not value.get('base_url') or not value.get('token'):raise RuntimeError('Jira 凭证文件格式无效')
        return path
    spec=importlib.util.spec_from_file_location('quick_jira',root/'harness/scripts/jira_confirmation.py');module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
    try:base,token=module.resolve_jira_config()
    except Exception:
        print('没有发现现有 Jira 凭证。可填写权限 0600 的 JSON 文件路径，或直接回车跳过，接入后在网页“Jira 自动执行规则”配置地址和 PAT。')
        selected=input('Jira 凭证文件路径（可回车跳过）：').strip()
        return jira_credentials(root,config_root,selected) if selected else None
    from pilot import atomic_json
    path=config_root/'jira-credential.json';atomic_json(path,{'base_url':base,'token':token});path.chmod(0o600)
    print('已使用本机现有 Jira 配置，凭证不会上传。');return path

def bind_projects(b,candidates):
    from seats import command, normalize_remote
    from jira_intake import git
    projects=b.pc.request('GET','/companies/'+b.cfg['company_id']+'/projects')
    if not isinstance(projects,list):raise RuntimeError('无法读取组织项目')
    choices=[(p,w) for p in projects if not p.get('archivedAt') for w in p.get('workspaces',[]) if w.get('repoUrl')]
    if not choices:
        print('组织暂未配置项目仓库。接入已完成，管理员创建 Project 仓库后再执行 harness repo connect。');return
    print('选择要接入的项目仓库（直接回车跳过）：')
    for i,(p,w) in enumerate(choices,1):print(str(i)+'. '+p['name']+' / '+str(w.get('name') or w['repoUrl']))
    raw=input('项目序号：').strip()
    if not raw:return
    if not raw.isdigit() or not 1<=int(raw)<=len(choices):raise RuntimeError('项目选择无效')
    project,workspace=choices[int(raw)-1];matched=[]
    for path in candidates:
        if not (path/'.git').exists() or path.resolve()==b.root:continue
        try:
            if normalize_remote(git(path,'remote','get-url','origin'))==normalize_remote(workspace['repoUrl']):matched.append(path)
        except Exception:continue
    repo=choose('项目本机仓库',matched,lambda p:(p/'.git').exists())
    b.cfg.setdefault('intake_repository_roots',[])
    if str(repo.parent) not in b.cfg['intake_repository_roots']:b.cfg['intake_repository_roots'].append(str(repo.parent))
    from pilot import atomic_json
    atomic_json(b.config_path,b.cfg)
    command(b,['repo','bind','--project',project['id'],'--workspace',workspace['id'],'--path',str(repo)])
    print('项目本机仓库已关联。')

def existing_bridge(root,previous):
    local_file=root/'.harness-local.json'
    local=json.loads(local_file.read_text(encoding='utf-8')) if local_file.is_file() else {}
    explicit=os.environ.get('HARNESS_PAPERCLIP_BRIDGE') or local.get('paperclipBridgeRoot') or (previous.get('quick_setup') or {}).get('bridge')
    candidates=[Path(explicit).expanduser()] if explicit else [root.parent/'paperclip-dsp7-integration']
    valid=[p.resolve() for p in candidates if (p/'pilot.py').is_file() and (p/'seats.py').is_file()]
    if not valid:
        print('已发现旧席位配置，但没有找到接入桥。请选择这台电脑原有的接入桥目录。')
        return choose('Paperclip 接入桥',[],lambda p:(p/'pilot.py').is_file() and (p/'seats.py').is_file())
    return valid[0]

def installation_error(error):
    # Report local causes without dumping configs, HTTP response bodies or keys.
    import re
    if isinstance(error,KeyboardInterrupt):return '接入已取消，已有配置保留。'
    if isinstance(error,FileNotFoundError):return '缺少文件：'+str(error.filename or '未指定路径')+'。请核对已有席位配置中的目录。'
    if isinstance(error,PermissionError):return '无法读取或写入本机文件，请核对当前用户的文件权限。'
    if isinstance(error,json.JSONDecodeError):return '本机配置不是有效 JSON，请检查最近提示的配置文件。'
    if isinstance(error,ModuleNotFoundError):return '接入桥或 Harness 依赖模块缺失：'+str(error.name)+'。请核对接入桥目录和 Python 环境。'
    if isinstance(error,subprocess.CalledProcessError):return '后台服务安装失败（退出码 '+str(error.returncode)+'）。可追加 --no-service 后按提示手动运行后台接入桥。'
    if type(error).__name__=='BridgeError' or isinstance(error,RuntimeError):
        message=str(error)[:600]
        http=re.search(r'HTTP (\d{3})',message)
        if http:return '网站请求失败（HTTP '+http.group(1)+'）。请检查登录授权、接入码有效期和已有席位登记；现有配置保留。'
        message=re.sub(r'pcp_[A-Za-z0-9_-]+|Bearer\s+\S+|[a-fA-F0-9]{64}', '[已隐藏]',message)
        return message
    if isinstance(error,(urllib.error.URLError,TimeoutError)):return '无法连接网站，请检查本机网络和网站地址。'
    return '接入未完成（'+type(error).__name__+'）。请核对本机配置，已有席位配置保留。'

def install_cli(root,bridge):
    if sys.platform=='win32':
        from platform_support import private_directory,powershell
        bin_root=private_directory(Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'ZhiyanSeat'/'bin');entry=bin_root/'harness.cmd'
        def cmd_path(value):return str(value).replace('%','%%')
        launcher='@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n"'+cmd_path(sys.executable)+'" "'+cmd_path(bridge/'harness_entry.py')+'" %*\r\n'
        if entry.exists() and entry.read_bytes()!=launcher.encode('utf-8'):raise RuntimeError('harness.cmd 已存在且内容不同，请核对后再接入；不覆盖已有命令')
        entry.write_text(launcher,encoding='utf-8',newline='')
        env=dict(os.environ,PAPERCLIP_SEAT_BIN=str(bin_root))
        powershell("$p=[Environment]::GetEnvironmentVariable('Path','User'); if($env:PAPERCLIP_SEAT_BIN -notin ($p -split ';')){[Environment]::SetEnvironmentVariable('Path',((([string]$p).TrimEnd(';')+';'+$env:PAPERCLIP_SEAT_BIN).TrimStart(';')),'User')}",env=env)
        print('已安装 harness.cmd；请重新打开 PowerShell 后使用 harness。')
    else:
        bin_root=Path.home()/'.local/bin';bin_root.mkdir(parents=True,exist_ok=True);entry=bin_root/'harness'
        if not entry.exists() and not entry.is_symlink():entry.symlink_to(root/'harness/bin/harness')

def finish_setup(b,bridge,no_service):
    install_cli(b.root,bridge)
    from seats import command
    pending=b.cfg.get('quick_setup') or {}
    if not b.cfg.get('seat_runtime'):
        if not pending:raise RuntimeError('本机缺少完整登记信息，请管理员核对现有席位')
        cli=['seat','register','--claude',pending['claude'],'--environment',pending['environment']]
        cli+=['--settings',pending['settings']] if pending.get('settings') else ['--use-default-settings']
        command(b,cli)
    command(b,['seat','check'])
    if not no_service:subprocess.run([sys.executable,str(bridge/'install_service.py')],check=True)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--server',required=True);parser.add_argument('--code');parser.add_argument('--config',type=Path);parser.add_argument('--harness',type=Path);parser.add_argument('--jira-credential-file');parser.add_argument('--no-service',action='store_true');args=parser.parse_args()
    if sys.version_info<(3,9):raise RuntimeError('需要 Python 3.9 或更新版本')
    if args.config and not args.no_service:raise RuntimeError('独立配置需同时使用 --no-service，避免覆盖默认后台服务')
    server=args.server.rstrip('/');parsed=urllib.parse.urlsplit(server)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('','/') or parsed.query or parsed.fragment:raise RuntimeError('网站地址无效')
    if sys.platform not in ('darwin','linux','win32'):raise RuntimeError('当前安装器支持 macOS、Linux 和 Windows')
    if sys.platform=='win32':
        if sys.version_info<(3,10) or sys.getwindowsversion().build<17763:raise RuntimeError('Windows 需要 Python 3.10+ 与 Windows 10 1809+／Windows 11')
        try:import winpty
        except ImportError:raise RuntimeError('请从网页选择 Windows 并使用 PowerShell 安装命令，以安装 pywinpty 终端依赖') from None
    config=args.config or Path.home()/'.config/paperclip-dsp7-bridge/config.json'
    if config.exists():
        print('发现已有席位配置，正在检查并复用：'+str(config))
        previous=json.loads(config.read_text(encoding='utf-8'))
        if not previous.get('harness_root'):raise RuntimeError('已有席位配置缺少 harness_root，请核对配置文件')
        if previous.get('paperclip_url','').rstrip('/')!=server:raise RuntimeError('已有席位连接的是其他网站，请使用原网站或单独配置，不覆盖现有席位')
        root=Path(previous['harness_root']).expanduser()
        if not root.is_dir():raise RuntimeError('已有席位的 Harness 工程目录不存在：'+str(root))
        bridge=existing_bridge(root,previous);print('使用已有接入桥：'+str(bridge));sys.path.insert(0,str(bridge))
        if sys.platform=='win32':
            from platform_support import private_directory
            private_directory(config.parent)
        from pilot import Bridge
        from seats import command
        b=Bridge(config)
        if b.cfg.get('execution_transport')=='outbound':finish_setup(b,bridge,args.no_service)
        else:command(b,['seat','check'])
        print('这台电脑已接入，复用原席位。')
        candidates=scan([Path.cwd(),Path.home()/'work']);bind_projects(b,candidates);return
    if not args.code:raise RuntimeError('请从网页“接入我的电脑”复制安装命令')
    invite_id,token=args.code.split(':',1);uuid.UUID(invite_id)
    if len(token)!=64 or any(x not in '0123456789abcdef' for x in token):raise RuntimeError('邀请格式无效')
    candidates=scan([Path.cwd(),Path.home()/'work',Path.home()/'projects'])
    root=choose('Harness 工程',([args.harness] if args.harness else [Path.cwd(),*candidates]),lambda p:(p/'harness/bin/harness').is_file() and (p/'harness/scripts/jira_confirmation.py').is_file())
    entry=root/'harness/scripts/harness_cli.py'
    if not entry.is_file() or 'cmd_paperclip_terminal' not in entry.read_text(encoding='utf-8'):raise RuntimeError('此 Harness 版本尚不支持 Paperclip 终端入口，请先更新 Harness')
    if sys.platform=='linux' and 'execution_transport' not in entry.read_text(encoding='utf-8'):raise RuntimeError('此 Harness 版本尚不支持 Linux 主动连接，请先更新 Harness')
    executable=shutil.which('claude')
    claude=choose('Claude 可执行文件',([Path(executable)] if executable else []),lambda p:p.is_file() and os.access(p,os.X_OK))
    settings=root/'.claude/settings.local.json';settings=settings if settings.is_file() else None
    name=input('电脑席位名称（回车使用 '+Path.home().name+' 的电脑）：').strip() or Path.home().name+' 的电脑'
    if input('确认使用以上本机路径和现有模型配置，连接 '+server+'？输入 yes：').strip().lower()!='yes':print('已取消接入。');return
    bridge=install_bundle(server,Path.home()/'.local/share/paperclip/bridge');sys.path.insert(0,str(bridge))
    if sys.platform=='win32':
        from platform_support import private_directory
        private_directory(bridge.parent);private_directory(bridge);private_directory(config.parent)
    from pilot import Api, Bridge, atomic_json
    from seats import fingerprint,runtime_profile,command
    config.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    jira=jira_credentials(root,config.parent,args.jira_credential_file)
    class Local:cfg={'harness_root':str(root)}
    runtime_profile(Local(),str(claude),str(settings) if settings else None,'pending')
    machine_id=str(uuid.uuid4())
    response=Api(server+'/api','').request('POST','/dsp7-quick-enroll',{'invitationId':invite_id,'token':token,'machine_id':machine_id,'machine_fingerprint':fingerprint(),'profile':{'harnessRoot':str(root),'bridgeRoot':str(bridge),'claudeCommand':str(claude),'settingsFile':str(settings) if settings else None,'name':name}})
    name=response['name']
    credential=config.parent/'seat-credential.json';atomic_json(credential,response);credential.chmod(0o600)
    cfg={'paperclip_url':server,'company_id':response['companyId'],'agent_id':response['agentId'],'credential_file':str(credential),'seat_credential_file':str(credential),'database':str(config.parent/'bridge.sqlite3'),'harness_root':str(root),'execution_transport':'outbound','poll_seconds':20,'notifications':'local','auto_resume':False,'same_session_resume':True,'confirmation_wait_seconds':3600,'web_jira_intake_enabled':True,'paperclip_intake_user_ids':response['intakeUserIds'],'paperclip_replay_approver_user_ids':response['intakeUserIds'],'jira_credential_file':str(jira) if jira else None,'intake_repository_roots':[str(root.parent)],'intake_worktree_root':str(config.parent/'worktrees'),'project_repositories':{},'seat':{'agent_id':response['agentId'],'machine_id':machine_id,'machine_fingerprint':fingerprint(),'name':name}}
    cfg['quick_setup']={'bridge':str(bridge),'claude':str(claude),'settings':str(settings) if settings else None,'environment':response['environmentId']}
    atomic_json(config,cfg);config.chmod(0o600)
    local_file=root/'.harness-local.json';local=json.loads(local_file.read_text(encoding='utf-8')) if local_file.is_file() else {};local['paperclipBridgeRoot']=str(bridge);atomic_json(local_file,local)
    atomic_json(config.parent/'interactive-enabled.json',{'enabled':True})
    b=Bridge(config)
    finish_setup(b,bridge,args.no_service)
    bind_projects(b,candidates)
    import seat_control
    seat_control.tick(b)
    print('接入完成！回到 '+server+' 的“席位”页面查看电脑在线状态。模型密钥保留本机，无需 SSH。')
    if args.no_service:print('尚未安装后台服务，请运行：'+sys.executable+' '+str(bridge/'pilot.py')+' --config '+str(config)+' watch')

if __name__=='__main__':
    try:main()
    except (Exception,KeyboardInterrupt) as error:
        print(installation_error(error),file=sys.stderr);sys.exit(2)
