"""Idle-only, version-directory upgrades for existing personal seats."""
from __future__ import annotations
import contextlib
import base64
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time


def windows_launcher_read(path):
    from platform_support import powershell
    result=powershell("$ErrorActionPreference='Stop';$p=$env:PAPERCLIP_LAUNCHER_PATH;if(Test-Path -LiteralPath $p){[Convert]::ToBase64String([IO.File]::ReadAllBytes($p))}else{'ABSENT'}",env=dict(os.environ,PAPERCLIP_LAUNCHER_PATH=str(path)))
    value=result.stdout.strip()
    return None if value=='ABSENT' else base64.b64decode(value,validate=True)


def windows_launcher_restore(path,data):
    from platform_support import powershell
    env=dict(os.environ,PAPERCLIP_LAUNCHER_PATH=str(path),PAPERCLIP_LAUNCHER_DATA='ABSENT' if data is None else base64.b64encode(data).decode('ascii'))
    powershell("$ErrorActionPreference='Stop';$p=$env:PAPERCLIP_LAUNCHER_PATH;if($env:PAPERCLIP_LAUNCHER_DATA -eq 'ABSENT'){if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p}}else{[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p))|Out-Null;[IO.File]::WriteAllBytes($p,[Convert]::FromBase64String($env:PAPERCLIP_LAUNCHER_DATA))}",env=env)
    if windows_launcher_read(path)!=data:raise RuntimeError('Windows 命令入口回滚核验失败')


def service_file():
    from seat_profiles import service_label,service_suffix
    if sys.platform == 'darwin':
        return Path.home()/('Library/LaunchAgents/'+service_label()+'.plist')
    if sys.platform == 'linux':
        return Path.home()/('.config/systemd/user/paperclip-dsp7-bridge'+service_suffix()+'.service')
    return None


def windows_service(script, bridge, alternative_bridge=None):
    from platform_support import powershell
    from seat_profiles import service_suffix,windows_watch_arguments
    if 'Export-ScheduledTask' in script:stage='备份旧计划任务'
    elif 'Unregister-ScheduledTask' in script:stage='停止并移除计划任务'
    elif 'Stop-ScheduledTask' in script:stage='停止计划任务'
    elif 'Start-ScheduledTask' in script:stage='启动计划任务'
    else:stage='核验计划任务路径'
    try:
        return powershell("""$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$name='Zhiyan-Seat-Bridge-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+$env:PAPERCLIP_TASK_SUFFIX;
$task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;
if($task){if($task.Actions.Count -ne 1 -or ($task.Actions.Arguments -ne $env:PAPERCLIP_OLD_ARGUMENTS -and $task.Actions.Arguments -ne $env:PAPERCLIP_ALT_ARGUMENTS)){throw 'Unknown seat task; refusing to replace it'};
"""+script+'\n}', env=dict(os.environ,PAPERCLIP_TASK_SUFFIX=service_suffix(),PAPERCLIP_OLD_ARGUMENTS=windows_watch_arguments(bridge),PAPERCLIP_ALT_ARGUMENTS=windows_watch_arguments(alternative_bridge or bridge)))
    except subprocess.CalledProcessError as error:
        raise upgrade_subprocess_error(stage,error) from None


def upgrade_subprocess_error(stage,error):
    import re
    detail=error.stderr or ''
    if isinstance(detail,bytes):detail=detail.decode('utf-8',errors='replace')
    detail=str(detail)
    if 'Unknown seat task; refusing to replace it' in detail:
        return RuntimeError('升级失败阶段：'+stage+'。计划任务指向其他客户端目录，未覆盖；请核对任务与升级恢复记录')
    if any(value in detail.lower() for value in ('0x80070005','access is denied','permissiondenied','拒绝访问','访问被拒绝')):
        code='（0x80070005）' if '0x80070005' in detail.lower() else ''
        return RuntimeError('升级失败阶段：'+stage+'。Windows 拒绝访问'+code+'；请在同一 Windows 用户的提升权限终端重试，或由任务所有者处理权限；不要重新登记席位')
    # Return only stable error identifiers; never expose scripts, environment,
    # XML backups, command lines or arbitrary child output.
    codes=re.findall(r'0x[0-9a-fA-F]{8}',detail)
    identifier=re.search(r'FullyQualifiedErrorId\s*:\s*([A-Za-z0-9_.:-]{1,120})',detail)
    context=('；错误码 '+codes[0]) if codes else ''
    if identifier:context+='；错误标识 '+identifier.group(1)
    return RuntimeError('升级失败阶段：'+stage+'（退出码 '+str(error.returncode)+'）'+context+'。现有身份保留，请核对该阶段及已有升级备份')


@contextlib.contextmanager
def upgrade_step(stage):
    try:yield
    except subprocess.CalledProcessError as error:
        raise upgrade_subprocess_error(stage,error) from None


def assert_idle(b, api=None):
    from pilot import ACTIVE, rows, processes_for_run, read_json
    api=b.pc if api is None else api
    runs=rows(api.request('GET','/companies/'+b.cfg['company_id']+'/heartbeat-runs?agentId='+b.cfg['agent_id']+'&limit=1000'))
    if any(r.get('agentId')==b.cfg['agent_id'] and r.get('status') in ACTIVE for r in runs):
        raise RuntimeError('席位有执行中、已排队或等待响应的运行。请待任务结束后重新更新；不会终止 Claude。')
    run_ids={str(r[0]) for r in b.db.execute('SELECT run_id FROM runs')}
    folder=Path(b.cfg['database']).parent/'interactive/runs'
    for path in folder.glob('*/session.json'):
        info=read_json(path)
        run_ids.add(path.parent.name)
        from platform_support import process_alive
        if info.get('status') in ('running','starting','waiting_for_terminal') and info.get('pid') and process_alive(int(info['pid'])) and not (path.parent/'summary.json').is_file():
            raise RuntimeError('本机仍有未结束的 Claude 会话，请确认结束后再更新。')
    if any(processes_for_run(rid) for rid in run_ids):
        raise RuntimeError('本机仍有 Claude 任务进程，请结束任务后再更新。')
    intent=Path(b.cfg['database']).parent/'interactive/intents'
    if any(not read_json(p).get('consumed_run_id') and time.time()-p.stat().st_mtime<180 for p in intent.glob('*.json')):
        raise RuntimeError('本机刚收到启动请求，请稍后确认任务状态再更新。')
    agent=api.request('GET','/agents/'+b.cfg['agent_id'])
    if agent.get('status')=='running':raise RuntimeError('服务端仍标记席位正在运行，请待运行结束后更新。')
    presence=(agent.get('adapterConfig') or {}).get('dsp7SeatPresence') or {}
    from datetime import datetime, timezone
    seen=presence.get('lastSeenAt')
    recent=bool(seen) and (datetime.now(timezone.utc)-datetime.fromisoformat(str(seen).replace('Z','+00:00'))).total_seconds()<90
    if recent and presence.get('state') in ('busy','waiting_decision','awaiting_local'):
        raise RuntimeError('席位仍在执行或等待人工响应，请处理完成后再更新。')


def migration_request(b, action, migration_id=None, profile=None):
    from seats import identity, seat_api
    body={**identity(b),'action':action}
    if migration_id:body['migration_id']=migration_id
    if profile:body['runtime']=profile
    return seat_api(b).request('POST','/agents/'+b.cfg['agent_id']+'/dsp7-outbound-migration',body)


def acquire_upgrade_lock(stream, timeout=20):
    """Allow short heartbeat/poll critical sections to finish, without bypassing locks."""
    from platform_support import fcntl
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise RuntimeError('席位正在启动、配置或更新，等待操作锁超时；请空闲后重试。') from None
            time.sleep(.2)


def upgrade(config, root, old_bridge, new_bridge, *, install_cli, no_service=False, agent_id=None):
    from pilot import Bridge, atomic_json, read_json
    from platform_support import fcntl, private_directory
    import uuid
    from seat_profiles import activate,cli_name,service_label,service_suffix
    activate(config)
    requested_bridge=Path(new_bridge)
    b=Bridge(config)
    if agent_id and b.cfg['agent_id']!=agent_id:
        raise RuntimeError('该命令属于另一个席位，请在对应电脑和操作系统用户下执行。')
    if b.cfg.get('execution_transport','ssh') not in ('ssh','outbound'):
        raise RuntimeError('此执行方式不支持自动更新；已有配置未修改。')
    runtime=Path(b.cfg['database']).parent
    interactive=private_directory(runtime/'interactive')
    with contextlib.ExitStack() as stack:
        for path in (runtime/'upgrade.lock',interactive/'operator.lock',runtime/'config.lock'):
            lock=stack.enter_context(path.open('a'))
            acquire_upgrade_lock(lock)
        b.cfg=read_json(config)
        marker=runtime/'upgrade-in-progress.json'
        pending=read_json(marker) if marker.exists() else None
        recovering=bool(pending)
        migration_id=None;remote=None;completed=False;keep_marker=False
        if pending:
            if pending.get('agentId')!=b.cfg['agent_id'] or bool(pending.get('noService'))!=no_service:
                raise RuntimeError('发现未结束的升级记录，请先按记录核对本机服务，不重复更新。')
            migration_id=pending.get('migrationId')
            # An outbound version update has no server transport migration.
            # Its local transaction still needs the same guarded recovery.
            if not migration_id and b.cfg.get('execution_transport')!='outbound':
                raise RuntimeError('旧 SSH 席位的升级记录缺少迁移编号，请保留记录并联系管理员。')
            old_bridge=Path(pending['oldBridge']);new_bridge=Path(pending['newBridge'])
            if sys.platform=='win32':
                from quick_install import secure_bundle_directory
                for directory in (old_bridge,new_bridge):secure_bundle_directory(directory)
            if not (new_bridge/'.bundle-sha256').is_file():raise RuntimeError('待恢复的新版目录缺失，请保留迁移记录并联系管理员。')
            if migration_id:
                remote=migration_request(b,'inspect',migration_id)
                if remote['state']=='completed':
                    atomic_json(config.parent/'bridge-version.json',{'sha256':(new_bridge/'.bundle-sha256').read_text().strip(),'bridge':str(new_bridge),'backup':pending['backup']})
                    marker.unlink();print('上轮迁移已完成，已确认服务端结果；请回网页查看席位心跳。');return
            print('正在恢复上轮席位'+('迁移' if migration_id else '版本更新')+'，保留原席位身份。')
        elif b.cfg.get('execution_transport','ssh')=='ssh':
            remote=migration_request(b,'inspect')
            if remote['state'] in ('prepared','rolled_back'):raise RuntimeError('服务端有未完成迁移，但本机缺少对应记录，请联系管理员；不会覆盖。')
            if remote['transport']!='outbound':
                migration_id=str(uuid.uuid4())
                print('检测到旧 SSH 席位，将保留原身份迁移为本机主动连接；切换期间暂停派工。')
            else:print('服务端已使用本机主动连接，将同步本机旧标记。')
        with upgrade_step('核验本机空闲状态'):assert_idle(b)
        if not recovering and not migration_id and old_bridge.resolve()==new_bridge.resolve() and b.cfg.get('execution_transport')=='outbound':
            install_cli(root,new_bridge,previous_bridge=old_bridge)
            print('本机已是网站当前版本，命令入口已重新核验。');return
        file=service_file();service_exists=False
        if not no_service:
            if sys.platform=='win32':
                # During recovery the service may already point at the new version.
                service_exists=bool(windows_service('Write-Output exists',old_bridge,new_bridge if recovering else None).stdout.strip())
            elif file and file.exists():
                text=file.read_text(encoding='utf-8')
                candidates=(old_bridge,new_bridge) if recovering else (old_bridge,)
                if sys.platform=='darwin':
                    args=plistlib.loads(file.read_bytes()).get('ProgramArguments',[])
                    known=any(len(args)==3 and args[1:]==[str(candidate/'pilot.py'),'watch'] for candidate in candidates)
                else:known=any(str(candidate/'pilot.py') in text and ' watch' in text for candidate in candidates)
                if not known:raise RuntimeError('后台服务不是原接入桥管理的服务，请人工核对；未覆盖。')
                service_exists=True
        launcher_path=None
        paths=[config]
        if not service_suffix():paths.append(root/'.harness-local.json')
        if file and not no_service:paths.append(file)
        if sys.platform!='win32':paths.append(Path.home()/'.local/bin'/cli_name())
        else:
            launcher_path=Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'ZhiyanSeat'/'bin'/(cli_name()+'.cmd')
            paths.append(launcher_path)
        if recovering:
            backup=Path(pending['backup'])
            saved=read_json(backup/'files.json')
            if set(saved)!=set(map(str,paths)):raise RuntimeError('迁移备份路径与当前配置不匹配，请联系管理员。')
            originals={p:(backup/saved[str(p)]).read_bytes() if saved[str(p)] is not None else None for p in paths}
            links={Path(p):v for p,v in read_json(backup/'links.json').items()}
            modes={Path(p):v for p,v in read_json(backup/'modes.json').items()}
        else:
            backup=private_directory(config.parent/'upgrade-backups'/(time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]))
            links={p:os.readlink(p) for p in paths if p.is_symlink()}
            originals={p:(windows_launcher_read(p) if p==launcher_path else p.read_bytes() if p.exists() else None) for p in paths}
            modes={p:(0o600 if p==launcher_path else p.stat().st_mode & 0o777) for p in paths if originals[p] is not None}
            atomic_json(backup/'links.json',{str(p):target for p,target in links.items()})
            atomic_json(backup/'modes.json',{str(p):mode for p,mode in modes.items()})
            for i,(p,data) in enumerate(originals.items()):
                if data is not None:(backup/str(i)).write_bytes(data);(backup/str(i)).chmod(0o600)
            if sys.platform=='win32' and service_exists:
                task_xml=windows_service('Export-ScheduledTask -TaskName $name',old_bridge).stdout
                (backup/'scheduled-task.xml').write_text(task_xml,encoding='utf-8')
            atomic_json(backup/'files.json',{str(p):str(i) if data is not None else None for i,(p,data) in enumerate(originals.items())})
            atomic_json(marker,{'oldBridge':str(old_bridge),'newBridge':str(new_bridge),'backup':str(backup),'migrationId':migration_id,'agentId':b.cfg['agent_id'],'noService':no_service})
        had_service=(backup/'scheduled-task.xml').is_file() if sys.platform=='win32' else bool(file and originals.get(file))
        stopped=False;watch_lock=None;install_attempted=False
        if migration_id:keep_marker=True
        def stop():
            if not service_exists:return
            if sys.platform=='darwin':
                target='gui/'+str(os.getuid())+'/'+service_label()
                if subprocess.run(['launchctl','print',target],capture_output=True).returncode==0:
                    subprocess.run(['launchctl','bootout',target],check=True,capture_output=True)
            elif sys.platform=='linux':subprocess.run(['systemctl','--user','stop','paperclip-dsp7-bridge'+service_suffix()+'.service'],check=True,capture_output=True)
            else:windows_service('Stop-ScheduledTask -TaskName $name; Unregister-ScheduledTask -TaskName $name -Confirm:$false',old_bridge,new_bridge if recovering else None)
        try:
            with upgrade_step('核验本机空闲状态'):assert_idle(b)
            with upgrade_step('停止旧后台服务'):stop()
            stopped=True
            watch_lock=Path(b.cfg['database']).with_suffix('.watch.lock').open('a')
            deadline=time.monotonic()+10
            while True:
                try:fcntl.flock(watch_lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
                except BlockingIOError:
                    if time.monotonic()>=deadline:raise RuntimeError('仍有手工启动的接入桥，请先停止该 watch 进程后重试。') from None
                    time.sleep(.2)
            with upgrade_step('核验本机空闲状态'):assert_idle(b)
            if migration_id:
                if recovering and remote['state']!='prepared':raise RuntimeError('上轮迁移未提交，正在恢复原配置；请随后重试原更新命令。')
                if not recovering:
                    from seats import runtime_profile
                    stored=b.cfg.get('seat_runtime') or {}
                    if not stored.get('environmentId'):raise RuntimeError('旧席位缺少本机 Claude 登记，请先运行 harness seat register。')
                    profile=runtime_profile(b,stored.get('claudeCommand') or 'claude',stored.get('claudeSettingsFile'),stored['environmentId'])
                    remote=migration_request(b,'prepare',migration_id,profile)
                if remote['state'] not in ('prepared','already_outbound'):raise RuntimeError('迁移状态已变化，请重新核对。')
            cfg=read_json(config)
            if remote and remote.get('transport')=='outbound':
                cfg['execution_transport']='outbound'
                if remote.get('runtime'):cfg['seat_runtime']=remote['runtime']
            cfg.setdefault('quick_setup',{})['bridge']=str(new_bridge)
            atomic_json(config,cfg);b.cfg=cfg
            if not service_suffix():
                local=root/'.harness-local.json';value=read_json(local) if local.exists() else {}
                value['paperclipBridgeRoot']=str(new_bridge);atomic_json(local,value)
            with upgrade_step('更新本机命令入口'):install_cli(root,new_bridge,previous_bridge=old_bridge)
            if file and not no_service and file.exists():file.unlink()
            fcntl.flock(watch_lock,fcntl.LOCK_UN);watch_lock.close();watch_lock=None
            if not no_service:
                install_attempted=True
                installed=subprocess.run([sys.executable,str(new_bridge/'install_service.py')],check=True,capture_output=True,text=True)
                if installed.stdout.strip():print(installed.stdout.strip())
            if migration_id:
                result=migration_request(b,'finish',migration_id)
                if result['state']!='completed':raise RuntimeError('服务端未确认迁移完成，请重试原命令。')
                completed=True
            atomic_json(config.parent/'bridge-version.json',{'sha256':(new_bridge/'.bundle-sha256').read_text().strip(),'bridge':str(new_bridge),'backup':str(backup)})
        except BaseException:
            if watch_lock:watch_lock.close();watch_lock=None
            if migration_id:
                try:
                    state=migration_request(b,'inspect',migration_id)['state']
                    if state=='completed':
                        completed=True
                        atomic_json(config.parent/'bridge-version.json',{'sha256':(new_bridge/'.bundle-sha256').read_text().strip(),'bridge':str(new_bridge),'backup':str(backup)})
                    elif state=='prepared':
                        if migration_request(b,'rollback',migration_id)['state']!='rolled_back':raise RuntimeError('服务端迁移回退未确认')
                    elif state not in ('absent','rolled_back','restored'):raise RuntimeError('迁移状态未知')
                except BaseException:
                    keep_marker=True
                    raise RuntimeError('迁移结果暂时无法确认，已保留原身份与恢复记录。请网络恢复后重新执行原更新命令；不要删除配置或重建席位。记录：'+str(marker)) from None
            if not completed:
                if install_attempted:
                    try:
                        if sys.platform=='win32':windows_service('Stop-ScheduledTask -TaskName $name; Unregister-ScheduledTask -TaskName $name -Confirm:$false',new_bridge)
                        elif sys.platform=='linux':subprocess.run(['systemctl','--user','stop','paperclip-dsp7-bridge'+service_suffix()+'.service'],check=True,capture_output=True)
                        else:subprocess.run(['launchctl','bootout','gui/'+str(os.getuid())+'/'+service_label()],capture_output=True)
                    except Exception:
                        keep_marker=True
                        raise RuntimeError('新版接入服务停止失败，已保留备份与恢复记录，请管理员核对；未启动旧服务。') from None
                for p,data in originals.items():
                    if p==launcher_path:windows_launcher_restore(p,data)
                    elif p in links:
                        temporary=p.with_name(p.name+'.upgrade-restore');temporary.unlink(missing_ok=True);temporary.symlink_to(links[p]);os.replace(temporary,p)
                    elif data is None:p.unlink(missing_ok=True)
                    else:
                        temporary=p.with_name(p.name+'.upgrade-restore')
                        temporary.write_bytes(data);temporary.chmod(modes[p]);os.replace(temporary,p)
                if stopped and had_service:
                    try:
                        if sys.platform=='win32' and (backup/'scheduled-task.xml').is_file():
                            from platform_support import powershell
                            powershell("$ErrorActionPreference='Stop';$name='Zhiyan-Seat-Bridge-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+$env:PAPERCLIP_TASK_SUFFIX;Register-ScheduledTask -TaskName $name -Xml ([IO.File]::ReadAllText($env:PAPERCLIP_TASK_BACKUP)) -Force | Out-Null;Start-ScheduledTask -TaskName $name",env=dict(os.environ,PAPERCLIP_TASK_SUFFIX=service_suffix(),PAPERCLIP_TASK_BACKUP=str(backup/'scheduled-task.xml')))
                        elif sys.platform=='linux':subprocess.run(['systemctl','--user','daemon-reload'],check=True,capture_output=True)
                        if sys.platform!='win32':subprocess.run([sys.executable,str(old_bridge/'install_service.py')],check=True,capture_output=True)
                    except Exception:
                        keep_marker=True
                        raise RuntimeError('旧配置已恢复，但后台服务恢复失败。已保留迁移记录；请重试原命令。备份：'+str(backup)) from None
                if migration_id and state in ('prepared','rolled_back'):
                    if migration_request(b,'restore',migration_id)['state']!='restored':
                        raise RuntimeError('原配置已恢复，服务端仍保持暂停；请重试原更新命令。')
                keep_marker=False
                raise
        finally:
            if watch_lock:watch_lock.close()
            if completed or not keep_marker:marker.unlink(missing_ok=True)
        print(('迁移并更新完成' if migration_id else '更新完成')+'，保留原席位、负责人、Jira 和仓库配置。备份：'+str(backup))
        if no_service:print('请手工启动：'+sys.executable+' '+str(new_bridge/'pilot.py')+' --config '+str(config)+' watch')
        else:print('请回到网页确认席位上线和客户端版本；新启动的已登记任务使用新版采集。')
    # Finish the interrupted transaction using its original backup first.
    # Only then open a fresh transaction for a newer published bundle.
    if recovering and requested_bridge.resolve()!=new_bridge.resolve():
        print('上轮更新已恢复，继续更新到网站当前发布版本。')
        upgrade(config,root,new_bridge,requested_bridge,install_cli=install_cli,no_service=no_service,agent_id=agent_id)
