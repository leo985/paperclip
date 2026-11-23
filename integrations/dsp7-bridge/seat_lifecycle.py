"""Short cross-platform commands for the current user's registered seat."""
from __future__ import annotations
import argparse
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.request
from pilot import Bridge, BridgeError, DEFAULT_CONFIG, atomic_json, read_json
from platform_support import fcntl

SERVICE_CONFIG = DEFAULT_CONFIG


def offline_requested(b):
    return (Path(b.cfg['database']).parent/'seat-offline.json').is_file()


def watcher_running(b):
    path=Path(b.cfg['database']).with_suffix('.watch.lock')
    with path.open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return True
    return False


def finish_offline(b):
    """Watcher exits successfully only after all registered activity is idle."""
    if not offline_requested(b):return False
    from seat_upgrade import assert_idle
    try:assert_idle(b)
    except (RuntimeError,OSError,ValueError,subprocess.SubprocessError):return False
    return True


def command(argv):
    parser=argparse.ArgumentParser(description='智研席位：online 上线 / offline 安全下线 / doctor 诊断 / upgrade 升级 / service install 补装登录后自动上线服务')
    parser.add_argument('action',choices=('online','offline','doctor','upgrade','service'))
    parser.add_argument('operation',nargs='?',choices=('install',))
    parser.add_argument('--config',type=Path,default=DEFAULT_CONFIG)
    parser.add_argument('--this-seat',action='store_true',help='仅更新选中席位；网页管理员请求使用此范围')
    parser.add_argument('--no-service',action='store_true',help='升级自定义配置时不管理后台服务')
    parser.add_argument('--seat',action='store_true',help=argparse.SUPPRESS)
    args=parser.parse_args(argv)
    if (args.action=='service') != (args.operation=='install'):
        parser.error('服务安装用法：harness service install')
    if args.action=='service' and args.no_service:
        parser.error('harness service install 不能与 --no-service 一起使用')
    if not args.config.is_file():raise BridgeError('这位操作系统用户尚未接入，请从网页“席位管理 → 接入新电脑”复制命令完成首次登记。')
    cfg=read_json(args.config)
    if cfg.get('execution_transport')!='outbound' and args.action!='upgrade':raise BridgeError('此席位仍使用旧 SSH 接入，请先从网页复制更新命令迁移，或执行 harness upgrade。')
    if args.action=='service' and not cfg.get('seat_runtime'):
        raise BridgeError('本机席位运行登记尚未完成，请从网页恢复接入流程，再执行 harness service install；不会重复创建席位。')
    b=Bridge(args.config)
    marker=Path(b.cfg['database']).parent/'seat-offline.json'
    root=Path(__file__).resolve().parent
    if args.action in ('online','service'):
        if args.config.resolve()!=SERVICE_CONFIG.resolve():raise BridgeError('自定义配置请手动运行 pilot.py --config <配置路径> watch，不覆盖默认后台服务。')
        if (marker.parent/'upgrade-in-progress.json').exists():raise BridgeError('席位有未结束的升级，请先执行 harness upgrade 恢复完成，再执行 harness online；不要删除升级记录或重新登记席位。')
        watchdog_recovery=os.environ.get('PAPERCLIP_SEAT_WATCHDOG_RECOVERY')=='1'
        if watchdog_recovery and marker.exists():
            print('席位已手动下线，巡检跳过自动上线。');return
        previous=marker.read_bytes() if marker.exists() else None
        # A concurrent manual offline must remain authoritative during recovery.
        if not watchdog_recovery:marker.unlink(missing_ok=True)
        try:
            subprocess.run([sys.executable,str(root/'install_service.py')],check=True,capture_output=True)
            if sys.platform=='darwin':subprocess.run(['launchctl','kickstart','gui/'+str(os.getuid())+'/'+__import__('seat_profiles').service_label()],check=True,capture_output=True)
        except BaseException:
            if previous is not None:marker.write_bytes(previous);marker.chmod(0o600)
            raise
        if args.action=='service':
            print('已补装并核验当前用户登录后自动上线服务及每分钟巡检，接入服务已启动；已有匹配服务会复用，席位身份与本机配置保留。')
        print('接入服务已启动，将自动连接网站。请稍后查看席位心跳；若仍离线，执行 harness doctor。网页原有的暂停接单设置保持不变。')
    elif args.action=='offline':
        atomic_json(marker,{'requested':True})
        # Persist pause first. Running tasks retain heartbeat, notifications and decisions.
        with contextlib.ExitStack() as stack:
            for path in (marker.parent/'upgrade.lock',marker.parent/'interactive/operator.lock'):
                path.parent.mkdir(parents=True,exist_ok=True)
                lock=stack.enter_context(path.open('a'))
                try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:
                    print('已暂停本机新任务。当前请求或会话结束后，接入服务会自动下线；不会中断 Claude。');return
            if not finish_offline(b):
                print('已暂停本机新任务。当前运行、启动请求或人工决策处理结束后自动下线；网络异常时保留服务等待重连。');return
        print('已暂停本机新任务；空闲的接入服务将在下一轮检查时安全退出，随后网页显示离线。恢复请执行 harness online。')
    elif args.action=='doctor':
        print('接入服务：'+('运行中' if watcher_running(b) else '未运行，执行 harness online'))
        print('本机接单：'+('已暂停／待下线，执行 harness online 恢复' if marker.exists() else '未主动暂停'))
        try:
            with urllib.request.urlopen(b.cfg['paperclip_url'].rstrip('/')+'/api/health',timeout=10) as response:
                healthy=json.load(response).get('status')=='ok'
            print('网站网络：'+('正常' if healthy else '网站健康状态异常'))
        except Exception:print('网站网络：无法连接，请检查网络、VPN 或代理设置')
        from seat_control import inspect_configuration
        checks=inspect_configuration(b)
        for item in checks:print(('通过' if item['status']=='pass' else '失败' if item['status']=='fail' else '提示')+' · '+item['label']+'：'+item['message'])
        if any(item['status']=='fail' for item in checks):raise BridgeError('诊断发现异常，请根据上方提示处理；此检查未执行 Claude 任务。')
    else:
        if args.config.resolve()!=SERVICE_CONFIG.resolve() and not args.no_service:raise BridgeError('自定义配置升级请追加 --no-service')
        from quick_install import bridge_release_url, download, installed_bridge_channel
        channel=installed_bridge_channel(b.cfg)
        payload=download(bridge_release_url(b.cfg['paperclip_url'], channel)+'/dsp7-install.py',1024*1024)
        # Fetch the current installer rather than upgrade with a stale bundled installer.
        with tempfile.TemporaryDirectory(prefix='zhiyan-upgrade-') as directory:
            entry=Path(directory)/'install.py';entry.write_bytes(payload)
            cli=[sys.executable,str(entry),'--server',b.cfg['paperclip_url'],'--upgrade']
            from device_upgrade import seat_scoped_environment
            if channel == 'v2':
                cli+=['--bridge-channel','v2']
            if channel == 'v2' or args.this_seat or seat_scoped_environment():
                cli+=['--agent-id',b.cfg['agent_id'],'--config',str(args.config),'--this-seat']
            else:
                cli+=['--all-seats']
            if args.no_service:cli+=['--no-service']
            subprocess.run(cli,check=True)


def main(argv=None):
    try:command(sys.argv[1:] if argv is None else argv)
    except Exception as error:
        from quick_install import installation_error
        print('席位操作未完成：'+installation_error(error),file=sys.stderr)
        raise SystemExit(2)
