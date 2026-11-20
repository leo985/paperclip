"""Enroll the existing default development root, then refresh enrolled content."""
import time
import subprocess
from pathlib import Path
from platform_support import fcntl
from pilot import BridgeError, atomic_json, read_json
from harness_capabilities import inspect
from seats import identity, seat_api


IDENTITY_FIELDS = ('kind', 'repository', 'root', 'profile', 'protocolVersion', 'roles')


def same_identity(left, right):
    return all(key in left and key in right and left[key] == right[key] for key in IDENTITY_FIELDS)


def refresh(b):
    """Caller establishes local idleness; server serializes against dispatches."""
    with (Path(b.cfg['database']).parent / 'config.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cfg = read_json(b.config_path)
        if any(cfg.get(k) != b.cfg.get(k) for k in ('agent_id', 'company_id', 'seat')):
            raise BridgeError('自动登记的席位身份已变化，请人工核对')
        b.cfg = cfg
        local = cfg.get('harness_capabilities') or {'version': 1, 'items': []}
        api = seat_api(b)
        endpoint = '/agents/' + cfg['agent_id'] + '/dsp7-harness-capabilities'
        registry = api.request('GET', endpoint)
        if registry.get('version') != 1 or local.get('version') != 1:
            raise BridgeError('Harness 登记协议不支持自动刷新')
        local_ids = {c['id'] for c in local['items']}
        remote_ids = {c['id'] for c in registry['items']}
        if remote_ids != local_ids:
            # A timed-out first POST may have committed remotely. Recover only
            # that receipt, after checking the same root and exact local files.
            extra = [c for c in registry['items'] if c['id'] not in local_ids]
            root = (cfg.get('seat_runtime') or {}).get('harnessRoot')
            recoverable = local_ids < remote_ids and len(extra) == 1 and extra[0]['kind'] == 'development' and not any(c['kind'] == 'development' for c in local['items'])
            if not recoverable or not root or Path(root).resolve(strict=True) != Path(cfg['harness_root']).resolve(strict=True):
                raise BridgeError('Harness 登记集合已变化，请人工核对')
            current = inspect(root, 'development', 'default')
            if any(value != extra[0].get(key) for key, value in current.items()) or inspect(root, 'development', 'default') != current:
                raise BridgeError('研发能力回执与本机文件不一致，请人工核对')
            from seat_upgrade import assert_idle
            assert_idle(b)
            local = {**local, 'items': [*local['items'], extra[0]]}
        changed = 0
        if not any(c['kind'] == 'development' for c in registry['items']):
            # The user already chose this root during device enrollment. Do not
            # scan the computer, infer skills, or use a different checkout.
            root = (cfg.get('seat_runtime') or {}).get('harnessRoot')
            if root:
                if Path(root).resolve(strict=True) != Path(cfg['harness_root']).resolve(strict=True):
                    raise BridgeError('默认研发目录与设备登记不一致，请核对后重新登记')
                current = inspect(root, 'development', 'default')
                if inspect(root, 'development', 'default') != current:
                    raise BridgeError('Harness 文件仍在更新，稍后自动重试')
                from seat_upgrade import assert_idle
                assert_idle(b)
                registry = api.request('POST', endpoint, {
                    **identity(b), 'expectedRevision': registry['revision'],
                    'automatic': True, 'capability': current,
                })
                cfg['harness_capabilities'] = registry
                atomic_json(b.config_path, cfg)
                changed += 1
        # Only roots already trusted both locally and remotely are eligible.
        for prior in local['items']:
            remote = next((c for c in registry['items'] if c['id'] == prior['id']), None)
            if not remote or not same_identity(prior, remote):
                raise BridgeError('Harness 身份或能力范围已变化，请人工登记')
            current = inspect(prior['root'], prior['kind'], prior['profile'])
            if not same_identity(prior, current):
                raise BridgeError('Harness 身份或能力范围已变化，请人工登记')
            if all(current[k] == remote.get(k) for k in current):
                continue
            # Reject a moving checkout rather than enrolling a mixed observation.
            if inspect(prior['root'], prior['kind'], prior['profile']) != current:
                raise BridgeError('Harness 文件仍在更新，稍后自动重试')
            from seat_upgrade import assert_idle
            assert_idle(b)
            registry = api.request('POST', endpoint, {
                **identity(b), 'expectedRevision': registry['revision'],
                'automatic': True, 'capability': current,
            })
            # Persist every successful receipt, even if another root fails later.
            cfg['harness_capabilities'] = registry
            atomic_json(b.config_path, cfg)
            changed += 1
        cfg['harness_capabilities'] = registry
        atomic_json(b.config_path, cfg)
        return changed


def refresh_when_idle(b, presence, state, stamp=None):
    stamp = time.time() if stamp is None else stamp
    if not (b.cfg.get('harness_capabilities') or {}).get('items') and not (b.cfg.get('seat_runtime') or {}).get('harnessRoot'):
        return
    if presence.get('state') != 'idle' or presence.get('activeRuns'):
        return
    if stamp - state.get('harnessRefreshEpoch', 0) >= 60:
        state['harnessRefreshEpoch'] = stamp
        try:
            count = refresh(b)
            state['harnessRefresh'] = {'status': 'ok', 'updatedCount': count}
        except (RuntimeError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            # Do not suppress polling (a queued run may have won the server lock).
            # Its pinned route still undergoes strict validation before any launch.
            state['harnessRefresh'] = {'status': 'deferred'}
    if (state.get('harnessRefresh') or {}).get('status') == 'deferred':
        presence['checks'] = [c for c in presence.get('checks', []) if c['id'] != 'harness_auto_registration'] + [{
            'id': 'harness_auto_registration', 'label': 'Harness 自动登记',
            'status': 'warn', 'message': 'Harness 能力自动登记未完成，将在空闲时重试。请核对已选研发目录、原生技能文件及客户端版本；也可运行 harness capability register 显式登记。',
        }]
