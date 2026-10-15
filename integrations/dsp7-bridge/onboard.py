"""Consume a one-use administrator invitation and install only local seat files."""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import subprocess
import sys
import uuid
from pilot import Api, Bridge, BridgeError, DEFAULT_CONFIG, atomic_json, read_json
from seats import fingerprint, runtime_profile

def main(argv=None):
    p=argparse.ArgumentParser(prog='harness seat enroll');p.add_argument('--invitation',type=Path,required=True);p.add_argument('--jira-credential-file',type=Path,required=True);p.add_argument('--repository-root',type=Path,action='append',required=True);p.add_argument('--install-watcher',action='store_true')
    p.add_argument('--config',type=Path,default=DEFAULT_CONFIG)
    args=p.parse_args(argv);config_path=args.config.expanduser().absolute();invite=read_json(args.invitation)
    if args.install_watcher and config_path.resolve()!=DEFAULT_CONFIG.resolve():raise BridgeError('后台安装仅支持默认运行配置；独立验收配置请手动检查')
    if args.invitation.stat().st_mode & 0o077:raise BridgeError('邀请文件包含一次性凭证，请先 chmod 600')
    if config_path.exists():raise BridgeError('本机已有接入配置，请使用原席位登记，不覆盖已有执行者')
    root=Path(invite['harnessRoot']).expanduser().resolve(strict=True);bridge=Path(invite['bridgeRoot']).expanduser().resolve(strict=True)
    if bridge!=Path(__file__).resolve().parent or not (root/'harness/bin/harness').is_file():raise BridgeError('安装位置与邀请中的 Harness／桥路径不一致')
    jira=args.jira_credential_file.expanduser().resolve(strict=True)
    if jira.stat().st_mode & 0o077:raise BridgeError('Jira 凭证权限必须为 0600')
    jc=read_json(jira)
    if not jc.get('base_url') or not jc.get('token'):raise BridgeError('Jira 凭证格式需要 base_url 和 token')
    roots=[str(r.expanduser().resolve(strict=True)) for r in args.repository_root]
    (bridge/'claude-interactive-wrapper').chmod(0o700)
    runtime=config_path.parent;runtime.mkdir(mode=0o700,parents=True,exist_ok=True)
    draft={'harness_root':str(root)}
    class Local:
        cfg=draft
    runtime_profile(Local(),invite['claudeCommand'],invite.get('settingsFile'),invite['environmentId'])
    machine_id=str(uuid.uuid4());local={'seat_id':invite['agentId'],'machine_id':machine_id,'machine_fingerprint':fingerprint()}
    url=invite['paperclipUrl'].rstrip('/')
    # Invitation is the sole enrollment proof; omit the Authorization header.
    response=Api(url+'/api','').request('POST','/dsp7-seat-enroll',{**local,'invitationId':invite['invitationId'],'token':invite['token']})
    credentials=runtime/'seat-credential.json';atomic_json(credentials,response);credentials.chmod(0o600)
    cfg={'paperclip_url':url,'company_id':invite['companyId'],'agent_id':invite['agentId'],'credential_file':str(credentials),'seat_credential_file':str(credentials),'database':str(runtime/'bridge.sqlite3'),'harness_root':str(root),'poll_seconds':20,'notifications':'local','auto_resume':False,'same_session_resume':True,'confirmation_wait_seconds':3600,'web_jira_intake_enabled':True,'paperclip_intake_user_ids':invite['intakeUserIds'],'paperclip_replay_approver_user_ids':invite['intakeUserIds'],'jira_credential_file':str(jira),'intake_repository_roots':roots,'intake_worktree_root':str(runtime/'worktrees'),'project_repositories':{},'seat':{'agent_id':invite['agentId'],'machine_id':machine_id,'machine_fingerprint':local['machine_fingerprint'],'name':invite['name']}}
    atomic_json(config_path,cfg);config_path.chmod(0o600)
    harness_local=root/'.harness-local.json'
    existing=read_json(harness_local) if harness_local.is_file() else {}
    existing['paperclipBridgeRoot']=str(bridge);atomic_json(harness_local,existing)
    # Allow subsequent normal registration even if a transient network failure
    # happens after the one-use invitation was consumed.
    atomic_json(runtime/'interactive-enabled.json',{'enabled':True,'installed_at':__import__('pilot').now()})
    from seats import command
    registration=['seat','register','--claude',invite['claudeCommand']]
    registration+=['--settings',invite['settingsFile']] if invite.get('settingsFile') else ['--use-default-settings']
    command(Bridge(config_path),registration)
    local_bin=Path.home()/'.local/bin';local_bin.mkdir(mode=0o700,parents=True,exist_ok=True)
    cli=local_bin/'harness'
    if not cli.exists() and not cli.is_symlink():cli.symlink_to(root/'harness/bin/harness')
    print('Harness CLI 位于 '+str(cli)+'；请确认 ~/.local/bin 在 PATH 中。')
    if args.install_watcher:subprocess.run(['/usr/bin/python3',str(bridge/'install_launchagent.py')],check=True)
    args.invitation.unlink() # One-use secret must not remain in a download folder.
    print('席位接入完成。接下来使用 harness repo bind 绑定本机仓库，在网页查看在线状态。')

if __name__=='__main__':
    try:main()
    except (BridgeError,KeyError,ValueError,OSError) as e:print('接入失败：'+str(e),file=sys.stderr);sys.exit(2)
