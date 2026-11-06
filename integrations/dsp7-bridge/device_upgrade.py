"""Upgrade one OS user's registrations at the same server with one verified bundle.

The local operator authorizes the batch. Remote organization requests remain
seat-scoped. Each worker starts fresh so imported profile defaults cannot leak.
"""
from __future__ import annotations
import argparse
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys


def seat_scoped_environment():
    # Early deployed remote updaters pin a digest but do not set SCOPE yet.
    # Keep their existing organization authorization boundary during bootstrap.
    return os.environ.get('PAPERCLIP_UPGRADE_SCOPE') == 'seat' or bool(
        os.environ.get('PAPERCLIP_UPGRADE_TARGET_SHA256') or os.environ.get('PAPERCLIP_AUTO_UPGRADE_SHA256'))


def targets(server):
    from seat_profiles import configurations
    found = []
    identities = set()
    for config in configurations():
        cfg = json.loads(config.read_text(encoding='utf-8'))
        if cfg.get('paperclip_url', '').rstrip('/') != server.rstrip('/'):
            continue
        identity = cfg.get('agent_id')
        if not identity or identity in identities:
            raise RuntimeError('本机席位身份缺失或重复，请先核对配置；未开始更新。')
        identities.add(identity)
        found.append((config, cfg))
    if not found:
        raise RuntimeError('此网站尚无本机席位，不能更新。')
    return found


def worker(config, bridge, action, no_service=False):
    env = dict(os.environ, DSP7_BRIDGE_CONFIG=str(config))
    command = [sys.executable, str(Path(bridge) / 'device_upgrade.py'), action,
               '--config', str(config), '--bridge', str(bridge)]
    if no_service:
        command.append('--no-service')
    subprocess.run(command, env=env, check=True, stdin=subprocess.DEVNULL)


def upgrade_all(server, bridge, no_service=False):
    from platform_support import fcntl, private_directory
    from pilot import atomic_json
    directory = private_directory(Path.home() / '.local/share/paperclip')
    with (directory / 'device-upgrade.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('本机已有客户端更新正在执行，请稍后重试。') from None
        selected = targets(server)
        # A failed preflight must leave every registration untouched.
        print('检查同一网站的全部本机席位，共 ' + str(len(selected)) + ' 个；保留各组织身份与配置。', flush=True)
        for config, cfg in selected:
            print('核验本机席位：' + str(cfg.get('company_name') or cfg['company_id']) + ' / ' + cfg['agent_id'], flush=True)
            worker(config, bridge, 'preflight', no_service)
        state = {'targetSha256': (Path(bridge) / '.bundle-sha256').read_text().strip(),
                 'status': 'running', 'completed': [],
                 'remaining': [cfg['agent_id'] for _, cfg in selected]}
        receipt = directory / 'device-upgrade.json'
        atomic_json(receipt, state)
        for config, cfg in selected:
            print('更新本机席位：' + str(cfg.get('company_name') or cfg['company_id']) + ' / ' + cfg['agent_id'], flush=True)
            try:
                # Recheck idleness and take the normal per-seat execution locks.
                worker(config, bridge, 'upgrade', no_service)
            except (OSError, subprocess.SubprocessError):
                state['status'] = 'incomplete'
                atomic_json(receipt, state)
                raise RuntimeError('本机统一更新未全部完成。已完成 ' + str(len(state['completed'])) +
                    ' 个，剩余 ' + str(len(state['remaining'])) +
                    ' 个；不会终止任务。处理上方错误后重新执行 harness upgrade；身份及备份保留。') from None
            state['completed'].append(cfg['agent_id'])
            state['remaining'].remove(cfg['agent_id'])
            atomic_json(receipt, state)
        state['status'] = 'installed'
        atomic_json(receipt, state)
        print('同一网站的全部本机席位已更新。请在网页核对各席位的新版本心跳。', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('preflight', 'upgrade'))
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--bridge', required=True, type=Path)
    parser.add_argument('--no-service', action='store_true')
    args = parser.parse_args()
    from seat_profiles import activate
    activate(args.config)
    from pilot import Bridge, read_json
    from quick_install import existing_bridge, install_cli
    from seat_upgrade import assert_idle, upgrade, acquire_upgrade_lock
    from platform_support import fcntl, private_directory
    cfg = read_json(args.config)
    root = Path(cfg['harness_root']).expanduser()
    if not root.is_dir() or not cfg.get('seat_runtime'):
        raise RuntimeError('本机席位尚未完成登记或 Harness 目录缺失，请先恢复该席位；未开始统一更新。')
    old = existing_bridge(root, cfg)
    if args.action == 'upgrade':
        upgrade(args.config, root, old, args.bridge, install_cli=install_cli,
                no_service=args.no_service, agent_id=cfg['agent_id'])
    else:
        runtime = Path(cfg['database']).parent
        interactive = private_directory(runtime / 'interactive')
        with contextlib.ExitStack() as stack:
            for path in (runtime / 'upgrade.lock', interactive / 'operator.lock', runtime / 'config.lock'):
                stream = stack.enter_context(path.open('a+b'))
                acquire_upgrade_lock(stream)
            assert_idle(Bridge(args.config))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        from quick_install import installation_error
        print('本机更新未完成：' + installation_error(error), file=sys.stderr)
        raise SystemExit(2)
