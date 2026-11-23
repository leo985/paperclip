#!/usr/bin/env python3
"""Single-command personal seat installer. Standard library; no model/Jira keys uploaded."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
import urllib.parse
import uuid
import zipfile

FILES={'windows_validation_supervisor.py','harness_composition.py','harness_bundle_install.py','harness_bundle.py','harness_bundle_registry.py','harness_observation.py','harness_observation_runtime.py','harness_observer_binding.py', 'harness_validation.py','harness_validation_process.py','device_upgrade.py','seat_remote_upgrade.py','seat_watchdog.py','install_watchdog.py','seat_launch_options.py','seat_profiles.py','harness_repositories.py','delivery_execution.py','harness_routing.py','process_tree.py','harness_launch.py','service_status.py','mac_notifications.py','command_receiver.py','terminal_display.py','seat_lifecycle.py','seat_upgrade.py','jira_workload.py','phase_gate.py','quality_collection.py','managed_sessions.py','session_hook.py','jira_dispatch.py','pilot.py','seats.py','seat_control.py','onboard.py','interactive.py','interactive_wait.py','jira_intake.py','claude-interactive-wrapper','install_launchagent.py','config.example.json','README.md','outbound.py','quick_install.py','install_service.py','platform_support.py','windows_terminal.py','watch_windows.py','harness_entry.py','harness_capabilities.py','analysis_runtime.py','analysis_execution.py','execution_permit.py','install_windows.ps1'}


DEFAULT_BRIDGE_CHANNEL = 'v1'


@contextmanager
def setup_step(label):
    print(label+'…',flush=True)
    try:
        yield
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(label+'超时（'+str(error.timeout)+' 秒）；已有配置和席位保留，请重新运行原接入命令继续，勿重复创建席位') from None
    except (urllib.error.URLError,TimeoutError) as error:
        raise RuntimeError(label+'失败：'+installation_error(error)) from None

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
    with setup_step('下载 '+urllib.parse.urlsplit(url).path):
        with urllib.request.urlopen(url,timeout=30) as r:data=r.read(limit+1)
    if len(data)>limit:raise RuntimeError('下载文件超过大小限制')
    return data

def secure_bundle_directory(path):
    """Bootstrap ACLs before importing an installed package, including on reuse.

    Python 3.13+ creates mode-0700 Windows temp directories with owner-only
    ACLs. An elevated install may have Administrators as owner, which excludes
    the same user's unelevated logon task. chmod does not fix that DACL.
    This bootstrap cannot depend on platform_support in the unreadable bundle.
    """
    path=Path(path)
    if path.is_symlink() or (sys.platform=='win32' and getattr(path.lstat(),'st_file_attributes',0)&0x400):
        raise RuntimeError('接入桥安装目录不能是链接或目录联接')
    if sys.platform!='win32':return
    script="""[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';
$p=$env:PAPERCLIP_ACL_PATH;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$directory=[IO.DirectoryInfo]::new($p);
$owner=$directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value;
if($owner -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')){throw 'Seat package directory has another owner'};
$acl=$directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Access);
$acl.SetAccessRuleProtection($true,$false);
foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){$acl.RemoveAccessRuleSpecific($rule)};
foreach($who in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};
$directory.SetAccessControl($acl)"""
    try:
        subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',script],
                       env=dict(os.environ,PAPERCLIP_ACL_PATH=str(path.resolve())),
                       stdin=subprocess.DEVNULL,capture_output=True,encoding='utf-8',errors='replace',
                       check=True,timeout=30,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    except subprocess.CalledProcessError:
        raise RuntimeError('Windows 接入桥安装目录权限核验失败；请核对目录所有者，未允许其他用户访问：'+str(path)) from None

def bridge_release_url(server, channel):
    if channel not in ('v1', 'v2'):
        raise ValueError('未知的 Bridge 分发渠道')
    return server.rstrip('/') + ('/bridge-v2' if channel == 'v2' else '')


def bridge_install_root(channel):
    return Path.home()/'.local/share/paperclip'/('bridge-v2' if channel == 'v2' else 'bridge')


def installed_bridge_channel(config):
    bridge = (config.get('quick_setup') or {}).get('bridge') or __file__
    folder = Path(bridge).expanduser().resolve()
    if folder.is_file():
        folder = folder.parent
    return 'v2' if folder.parent == bridge_install_root('v2').resolve() else 'v1'


def install_bundle(server,install_root):
    manifest=json.loads(download(server+'/dsp7-bridge-manifest.json',4096))
    digest=manifest['sha256']
    if len(digest)!=64 or any(x not in '0123456789abcdef' for x in digest):raise RuntimeError('安装包摘要无效')
    expected=os.environ.get('PAPERCLIP_UPGRADE_TARGET_SHA256') or os.environ.get('PAPERCLIP_AUTO_UPGRADE_SHA256')
    if expected and digest!=expected:raise RuntimeError('自动升级目标已变化，本次延后；保留当前版本')
    archive=download(server+'/dsp7-bridge.zip',10*1024*1024)
    if hashlib.sha256(archive).hexdigest()!=digest:raise RuntimeError('安装包版本正在更新或摘要不一致，请稍后重试')
    # Version directories are immutable: never overwrite a running client.
    import io
    install_root.mkdir(parents=True,exist_ok=True,mode=0o700)
    secure_bundle_directory(install_root)
    dest=install_root/digest[:16]
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        if set(z.namelist())!=FILES or len(z.namelist())!=len(FILES) or sum(x.file_size for x in z.infolist())>20*1024*1024:raise RuntimeError('安装包内容无效')
        if dest.exists():
            secure_bundle_directory(dest)
            if dest.is_symlink() or any((dest/name).is_symlink() or not (dest/name).is_file() or (dest/name).read_bytes()!=z.read(name) for name in FILES):raise RuntimeError('已有版本目录内容不完整或已修改，请先保留该目录并联系管理员核对')
            # Older installers did not write a version receipt; code files stay untouched.
            (dest/'.bundle-sha256').write_text(digest,encoding='utf-8')
            return dest
        staging=Path(tempfile.mkdtemp(prefix='.download-',dir=install_root))
        try:
            secure_bundle_directory(staging)
            for item in z.infolist():
                path=staging/item.filename
                path.write_bytes(z.read(item));path.chmod(0o700 if item.filename=='claude-interactive-wrapper' else 0o600)
            (staging/'.bundle-sha256').write_text(digest,encoding='utf-8')
            staging.rename(dest)
        finally:
            if staging.exists():shutil.rmtree(staging)
    return dest

def jira_credentials(root,config_root,explicit=None):
    if explicit:
        path=Path(explicit).expanduser().resolve(strict=True)
        from platform_support import credential_private
        if not credential_private(path):raise RuntimeError('Jira 凭证文件必须仅当前用户可读（Windows 请检查文件安全权限）')
        value=json.loads(path.read_text(encoding='utf-8'))
        if not value.get('base_url') or not value.get('token'):raise RuntimeError('Jira 凭证文件格式无效')
        return path
    from pilot import load_module
    module=load_module('quick_jira',root/'harness/scripts/jira_confirmation.py')
    try:base,token=module.resolve_jira_config()
    except Exception:
        print('没有发现现有 Jira 凭证。可填写权限 0600 的 JSON 文件路径，或直接回车跳过，接入后在网页“Jira 自动执行规则”配置地址和 PAT。')
        selected=input('Jira 凭证文件路径（可回车跳过）：').strip()
        return jira_credentials(root,config_root,selected) if selected else None
    from pilot import atomic_json
    path=config_root/'jira-credential.json';atomic_json(path,{'base_url':base,'token':token});path.chmod(0o600)
    print('已使用本机现有 Jira 配置，凭证不会上传。');return path

def existing_bridge(root,previous):
    local_file=root/'.harness-local.json'
    local=json.loads(local_file.read_text(encoding='utf-8')) if local_file.is_file() else {}
    explicit=os.environ.get('HARNESS_PAPERCLIP_BRIDGE') or (previous.get('quick_setup') or {}).get('bridge') or local.get('paperclipBridgeRoot')
    candidates=[Path(explicit).expanduser()] if explicit else [root.parent/'paperclip-dsp7-integration']
    if sys.platform=='win32':
        for candidate in candidates:
            if candidate.is_dir():secure_bundle_directory(candidate)
    valid=[p.resolve() for p in candidates if (p/'pilot.py').is_file() and (p/'seats.py').is_file()]
    if not valid:
        print('已发现旧席位配置，但没有找到接入桥。请选择这台电脑原有的接入桥目录。')
        return choose('Paperclip 接入桥',[],lambda p:(p/'pilot.py').is_file() and (p/'seats.py').is_file())
    return valid[0]

def installation_error(error):
    # Report local causes without dumping configs, HTTP response bodies or keys.
    import re
    if isinstance(error,KeyboardInterrupt):return '接入已取消，已有配置保留。'
    # HTTPError is a URLError too: a rejected request is not a connection failure.
    if isinstance(error,urllib.error.HTTPError):
        if (urllib.parse.urlsplit(error.filename or '').path == '/api/dsp7-quick-enroll/inspect'
                and error.code in (403,410)):
            return '接入码无效或已过期（HTTP '+str(error.code)+'）。请在网站“席位 → 接入我的电脑”重新生成接入命令，并在 15 分钟内执行；已有配置和席位保留。'
        return '网站请求失败（HTTP '+str(error.code)+'）。请核对服务端、代理及接入码有效期；已有配置保留。'
    if isinstance(error,(urllib.error.URLError,TimeoutError)):
        reason=error.reason if isinstance(error,urllib.error.URLError) else error
        if isinstance(reason,socket.gaierror):detail='地址解析失败'
        elif isinstance(reason,ConnectionRefusedError):detail='连接被拒绝，请检查服务和端口'
        elif isinstance(reason,TimeoutError):detail='连接或读取超时，请检查网络、端口和防火墙'
        elif isinstance(reason,ssl.SSLCertVerificationError):detail='HTTPS 证书校验失败，请检查证书信任链'
        elif isinstance(reason,ConnectionResetError):detail='连接被重置，请检查服务、代理和防火墙'
        else:detail='网络连接失败'
        code=getattr(reason,'winerror',None) or getattr(reason,'errno',None)
        if isinstance(code,int):detail+='（系统错误码 '+str(code)+'）'
        # Never print raw exception reasons, proxy URLs, response bodies or codes.
        proxy_hint=''
        if any(key in urllib.request.getproxies() for key in ('http','https','all')):
            proxy_hint='检测到 Python 代理配置；PowerShell 下载成功不代表 Python 能连接，请核对该内网地址的代理绕过规则。'
        return detail+'。'+proxy_hint+'已有配置保留。'
    if isinstance(error,FileNotFoundError):return '缺少文件：'+str(error.filename or '未指定路径')+'。请核对已有席位配置中的目录。'
    if isinstance(error,PermissionError):return '无法读取或写入本机文件，请核对当前用户的文件权限。'
    if isinstance(error,json.JSONDecodeError):return '本机配置不是有效 JSON，请检查最近提示的配置文件。'
    if isinstance(error,ModuleNotFoundError):return '接入桥或 Harness 依赖模块缺失：'+str(error.name)+'。请核对接入桥目录和 Python 环境。'
    if isinstance(error,subprocess.CalledProcessError):
        command=error.cmd if isinstance(error.cmd,(list,tuple)) else []
        if any(Path(str(part)).name in ('install_service.py','install_launchagent.py') for part in command):
            diagnostic=error.stderr or ''
            if isinstance(diagnostic,bytes):diagnostic=diagnostic.decode('utf-8',errors='replace')
            for line in str(diagnostic).splitlines():
                if line.startswith('PAPERCLIP_SERVICE_ERROR: '):
                    try:
                        message=str(json.loads(line.split(': ',1)[1])['message'])[:600]
                        return re.sub(r'pcp_[A-Za-z0-9_-]+|Bearer\s+\S+|[a-fA-F0-9]{64}', '[已隐藏]',message)
                    except (ValueError,KeyError,TypeError):pass
            return '后台服务安装或启动失败（退出码 '+str(error.returncode)+'）。请核对当前用户的计划任务权限与启动日志；已有席位配置保留。'
        return '接入准备步骤执行失败（退出码 '+str(error.returncode)+'）；请核对前面的具体错误，不能据此判断后台服务安装失败。'
    if type(error).__name__=='BridgeError' or isinstance(error,RuntimeError):
        message=str(error)[:600]
        http=re.search(r'HTTP (\d{3})',message)
        if http and type(error).__name__=='BridgeError':return '网站请求失败（HTTP '+http.group(1)+'）。请检查登录授权、接入码有效期和已有席位登记；现有配置保留。'
        message=re.sub(r'pcp_[A-Za-z0-9_-]+|Bearer\s+\S+|[a-fA-F0-9]{64}', '[已隐藏]',message)
        return message
    return '接入未完成（'+type(error).__name__+'）。请核对本机配置，已有席位配置保留。'

def install_cli(root,bridge,previous_bridge=None):
    if sys.platform=='darwin':
        try:
            result=subprocess.run([sys.executable,str(bridge/'mac_notifications.py'),'--install'],capture_output=True,timeout=65)
            if result.returncode:print('提示：通知工具安装未完成。可安装 terminal-notifier 后启用点击定位；提醒仍会发送。')
        except subprocess.SubprocessError:
            print('提示：通知工具安装超时，提醒保留；安装 terminal-notifier 后启用点击定位。')
    if sys.platform=='win32':
        from platform_support import private_directory,powershell
        from seat_profiles import cli_name,config_path,service_suffix
        bin_root=private_directory(Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'ZhiyanSeat'/'bin');entry=bin_root/(cli_name()+'.cmd')
        def cmd_path(value):return str(value).replace('%','%%')
        environment=('set "DSP7_BRIDGE_CONFIG='+cmd_path(config_path())+'"\r\n') if service_suffix() else ''
        launcher='@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n'+environment+'"'+cmd_path(sys.executable)+'" "'+cmd_path(bridge/'harness_entry.py')+'" %*\r\n'
        if entry.exists() and entry.read_bytes()!=launcher.encode('utf-8'):
            old_launcher=launcher.replace(cmd_path(bridge/'harness_entry.py'),cmd_path(previous_bridge/'harness_entry.py')) if previous_bridge else None
            if old_launcher is None or entry.read_bytes()!=old_launcher.encode('utf-8'):raise RuntimeError('harness.cmd 不是已登记的旧版入口，不覆盖未知命令')
        entry.write_bytes(launcher.encode('utf-8'))
        env=dict(os.environ,PAPERCLIP_SEAT_BIN=str(bin_root))
        powershell("$p=[Environment]::GetEnvironmentVariable('Path','User'); if($env:PAPERCLIP_SEAT_BIN -notin ($p -split ';')){[Environment]::SetEnvironmentVariable('Path',((([string]$p).TrimEnd(';')+';'+$env:PAPERCLIP_SEAT_BIN).TrimStart(';')),'User')}",env=env)
        print('已安装 '+entry.name+'；请重新打开 PowerShell 后使用 '+cli_name()+'。')
    else:
        import shlex
        from seat_profiles import cli_name,config_path,service_suffix
        bin_root=Path.home()/'.local/bin';bin_root.mkdir(parents=True,exist_ok=True);entry=bin_root/cli_name()
        def launcher_for(target):
            environment=('env DSP7_BRIDGE_CONFIG='+shlex.quote(str(config_path()))+' ') if service_suffix() else ''
            return '#!/bin/sh\n# Zhiyan personal seat command; managed by quick_install.py\nexec '+environment+shlex.quote(sys.executable)+' '+shlex.quote(str(target/'harness_entry.py'))+' "$@"\n'
        launcher=launcher_for(bridge)
        if entry.is_symlink():
            if entry.resolve()!=(root/'harness/bin/harness').resolve():raise RuntimeError('harness 链接指向其他工程，不覆盖未知命令')
        elif entry.exists() and entry.read_text(encoding='utf-8') not in (launcher,launcher_for(previous_bridge) if previous_bridge else launcher):
            raise RuntimeError('harness 命令不是已登记的入口，不覆盖未知命令')
        temporary=entry.with_name(entry.name+'.install-tmp');temporary.write_text(launcher,encoding='utf-8');temporary.chmod(0o700);os.replace(temporary,entry)

def finish_setup(b,bridge,no_service):
    with setup_step('安装本机 harness 命令'):
        install_cli(b.root,bridge)
    from seats import command
    pending=b.cfg.get('quick_setup') or {}
    if not b.cfg.get('seat_runtime'):
        if not pending:raise RuntimeError('本机缺少完整登记信息，请管理员核对现有席位')
        cli=['seat','register','--claude',pending['claude'],'--environment',pending['environment']]
        cli+=['--settings',pending['settings']] if pending.get('settings') else ['--use-default-settings']
        with setup_step('登记本机 Claude 运行配置'):
            command(b,cli)
    with setup_step('核验席位连接及运行配置'):
        command(b,['seat','check'])
    if not no_service:
        with setup_step('安装并核验后台自动上线服务'):
            subprocess.run([sys.executable,str(bridge/'install_service.py')],check=True)
    else:print("未启用登录后自动上线（已选择手动运行）；不会停用已有后台服务。")


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--server',required=True);parser.add_argument('--code');parser.add_argument('--config',type=Path);parser.add_argument('--harness',type=Path);parser.add_argument('--jira-credential-file');parser.add_argument('--no-service',action='store_true');parser.add_argument('--upgrade',action='store_true');parser.add_argument('--all-seats',action='store_true');parser.add_argument('--this-seat',action='store_true');parser.add_argument('--agent-id');parser.add_argument('--bridge-channel',choices=('v1','v2'),default=DEFAULT_BRIDGE_CHANNEL);args=parser.parse_args()
    if sys.version_info<(3,9):raise RuntimeError('需要 Python 3.9 或更新版本')
    server=args.server.rstrip('/');parsed=urllib.parse.urlsplit(server)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('','/') or parsed.query or parsed.fragment:raise RuntimeError('网站地址无效')
    if sys.platform not in ('darwin','linux','win32'):raise RuntimeError('当前安装器支持 macOS、Linux 和 Windows')
    if sys.platform=='win32':
        if sys.version_info<(3,10) or sys.getwindowsversion().build<17763:raise RuntimeError('Windows 需要 Python 3.10+ 与 Windows 10 1809+／Windows 11')
        try:import winpty
        except ImportError:raise RuntimeError('请从网页选择 Windows 并使用 PowerShell 安装命令，以安装 pywinpty 终端依赖') from None
    # Inspect the invitation before reusing any local identity. A different
    # company gets its own private directory and login service.
    if args.bridge_channel == 'v2' and args.upgrade and not args.this_seat:
        raise RuntimeError('V2 更新须明确选择单个席位，请加 --this-seat')
    bootstrap=install_bundle(bridge_release_url(server,args.bridge_channel),bridge_install_root(args.bridge_channel))
    sys.path.insert(0,str(bootstrap))
    from seat_profiles import select_config,activate,configurations,default_config
    target=None
    if args.code:
        invite_id,token=args.code.split(':',1);uuid.UUID(invite_id)
        if len(token)!=64 or any(x not in '0123456789abcdef' for x in token):raise RuntimeError('邀请格式无效')
        request=urllib.request.Request(server+'/api/dsp7-quick-enroll/inspect',data=json.dumps({'invitationId':invite_id,'token':token}).encode(),headers={'Content-Type':'application/json'})
        with setup_step('检查接入码 /api/dsp7-quick-enroll/inspect'):
            with urllib.request.urlopen(request,timeout=20) as response:target=json.load(response)
        config=select_config(server,target['companyId'],args.config)
        print('目标组织：'+target['companyName']+'；使用独立组织身份，其他组织席位保持原样。')
    elif args.agent_id:
        matches=[p for p in configurations() if json.loads(p.read_text()).get('agent_id')==args.agent_id and json.loads(p.read_text()).get('paperclip_url','').rstrip('/')==server]
        if len(matches)!=1:raise RuntimeError('本机没有唯一匹配的席位配置，请核对席位编号')
        config=matches[0]
    else:config=args.config or Path(os.environ.get('DSP7_BRIDGE_CONFIG') or default_config())
    from device_upgrade import seat_scoped_environment
    if args.all_seats:
        if not args.upgrade or args.code or args.agent_id or args.config or args.this_seat or seat_scoped_environment():
            raise RuntimeError('--all-seats 仅用于当前用户同一网站的统一升级，不能与席位选择或接入码混用')
        if os.environ.get('HARNESS_PAPERCLIP_BRIDGE'):
            raise RuntimeError('请先取消 HARNESS_PAPERCLIP_BRIDGE 环境变量，避免升级后仍使用旧桥')
        from device_upgrade import upgrade_all
        upgrade_all(server, bootstrap, no_service=args.no_service)
        return
    activate(config)
    if config.exists():
        print('发现已有席位配置，正在检查并复用：'+str(config))
        previous=json.loads(config.read_text(encoding='utf-8'))
        if not previous.get('harness_root'):raise RuntimeError('已有席位配置缺少 harness_root，请核对配置文件')
        if previous.get('paperclip_url','').rstrip('/')!=server:raise RuntimeError('已有席位连接的是其他网站，请使用原网站或单独配置，不覆盖现有席位')
        root=Path(previous['harness_root']).expanduser()
        if not root.is_dir():raise RuntimeError('已有席位的 Harness 工程目录不存在：'+str(root))
        bridge=existing_bridge(root,previous)
        pending_setup=bool(not previous.get('seat_runtime') and previous.get('quick_setup') and previous.get('execution_transport')=='outbound')
        from device_upgrade import seat_scoped_environment
        if args.upgrade and not pending_setup and not args.this_seat and not seat_scoped_environment():
            if os.environ.get('HARNESS_PAPERCLIP_BRIDGE'):
                raise RuntimeError('请先取消 HARNESS_PAPERCLIP_BRIDGE 环境变量，避免升级后仍使用旧桥')
            from device_upgrade import upgrade_all
            upgrade_all(server, bootstrap, no_service=args.no_service)
            return
        if args.upgrade or pending_setup:
            if os.environ.get('HARNESS_PAPERCLIP_BRIDGE'):raise RuntimeError('请先取消 HARNESS_PAPERCLIP_BRIDGE 环境变量，避免升级后仍使用旧桥')
            new_bridge=bootstrap
            sys.path.insert(0,str(new_bridge))
            from seat_upgrade import upgrade
            if pending_setup:print('发现未完成的首次接入：保留原席位，先更新接入桥，再继续运行配置登记和服务安装。')
            # An incomplete first setup has no registered runtime yet. Switch
            # the bridge using the guarded upgrade path, then finish enrollment
            # before installing/starting its service.
            with setup_step('更新接入桥并保留原席位身份'):
                upgrade(config,root,bridge,new_bridge,install_cli=install_cli,no_service=True if pending_setup else args.no_service,agent_id=args.agent_id)
            if not pending_setup:return
            bridge=new_bridge
        print('使用已有接入桥：'+str(bridge));sys.path.insert(0,str(bridge))
        if sys.platform=='win32':
            from platform_support import private_directory
            private_directory(config.parent)
        from pilot import Bridge
        from seats import command
        with setup_step('校验本机席位凭据权限'):
            b=Bridge(config)
        if b.cfg.get('execution_transport')=='outbound':finish_setup(b,bridge,args.no_service)
        else:command(b,['seat','check'])
        print('这台电脑已接入，复用原席位。')
        return
    if args.upgrade:raise RuntimeError('当前操作系统用户尚未注册席位，请从网页复制首次接入命令。')
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
    bridge=bootstrap;sys.path.insert(0,str(bridge))
    if sys.platform=='win32':
        from platform_support import private_directory
        private_directory(bridge.parent);private_directory(bridge);private_directory(config.parent)
    from pilot import Api, Bridge, atomic_json
    from seats import fingerprint,runtime_profile,command
    config.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    jira=jira_credentials(root,config.parent,args.jira_credential_file)
    class Local:cfg={'harness_root':str(root)}
    with setup_step('校验本机 Claude 运行环境'):
        runtime_profile(Local(),str(claude),str(settings) if settings else None,'pending')
    machine_id=str(uuid.uuid4())
    response=Api(server+'/api','').request('POST','/dsp7-quick-enroll',{'invitationId':invite_id,'token':token,'machine_id':machine_id,'machine_fingerprint':fingerprint(),'profile':{'harnessRoot':str(root),'bridgeRoot':str(bridge),'claudeCommand':str(claude),'settingsFile':str(settings) if settings else None,'name':name}})
    if target and response['companyId']!=target['companyId']:raise RuntimeError('服务端返回了不同组织，未覆盖本机配置')
    name=response['name']
    credential=config.parent/'seat-credential.json';atomic_json(credential,response);credential.chmod(0o600)
    cfg={'paperclip_url':server,'company_id':response['companyId'],'agent_id':response['agentId'],'credential_file':str(credential),'seat_credential_file':str(credential),'database':str(config.parent/'bridge.sqlite3'),'harness_root':str(root),'execution_transport':'outbound','poll_seconds':20,'notifications':'local','auto_resume':False,'same_session_resume':True,'confirmation_wait_seconds':3600,'web_jira_intake_enabled':True,'paperclip_intake_user_ids':response['intakeUserIds'],'paperclip_replay_approver_user_ids':response['intakeUserIds'],'jira_credential_file':str(jira) if jira else None,'intake_repository_roots':[str(root.parent)],'intake_worktree_root':str(config.parent/'worktrees'),'project_repositories':{},'seat':{'agent_id':response['agentId'],'machine_id':machine_id,'machine_fingerprint':fingerprint(),'name':name}}
    if target:cfg['company_name']=target['companyName']
    cfg['quick_setup']={'bridge':str(bridge),'claude':str(claude),'settings':str(settings) if settings else None,'environment':response['environmentId']}
    atomic_json(config,cfg);config.chmod(0o600)
    from seat_profiles import service_suffix
    if not service_suffix():
        local_file=root/'.harness-local.json';local=json.loads(local_file.read_text(encoding='utf-8')) if local_file.is_file() else {};local['paperclipBridgeRoot']=str(bridge);atomic_json(local_file,local)
    atomic_json(config.parent/'interactive-enabled.json',{'enabled':True})
    with setup_step('校验本机席位凭据权限'):
        b=Bridge(config)
    finish_setup(b,bridge,args.no_service)
    import seat_control
    seat_control.tick(b)
    print('接入完成！回到 '+server+' 的“席位”页面查看电脑在线状态。模型密钥保留本机，无需 SSH。')
    from seat_profiles import cli_name
    entry=cli_name()
    print('当前组织命令：'+entry+' online 上线 / '+entry+' offline 安全下线 / '+entry+' doctor 诊断 / '+entry+' upgrade 更新。')
    if args.no_service:print('尚未安装后台服务；稍后启用登录后自动上线请运行：'+entry+' service install。临时手动运行：'+sys.executable+' '+str(bridge/'pilot.py')+' --config '+str(config)+' watch')

if __name__=='__main__':
    try:main()
    except (Exception,KeyboardInterrupt) as error:
        print(installation_error(error),file=sys.stderr);sys.exit(2)
