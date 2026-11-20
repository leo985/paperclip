"""Credential-free heartbeat diagnostics and cooperative, idle-only recovery."""
import contextlib
import datetime as dt
import subprocess
import sqlite3
import time
import urllib.error
from pathlib import Path

from pilot import atomic_json, now, read_json

STAGES = {'configuration', 'collection', 'repositories', 'heartbeat_request', 'commands'}


def folder(b):
    return Path(b.cfg['database']).parent / 'seat-control'


def load(path):
    try:
        return read_json(path)
    except (RuntimeError, OSError, ValueError):
        return {}


def failure(b, error):
    path = folder(b) / 'heartbeat-health.json'
    previous = load(path)
    status = None
    cause = error
    for _ in range(8):
        if isinstance(cause, urllib.error.HTTPError):
            status = cause.code
            break
        cause = getattr(cause, '__cause__', None)
        if cause is None:
            break
    stage = getattr(b, '_seat_heartbeat_stage', 'configuration')
    count = previous.get('consecutiveFailures', 0)
    count = count if type(count) is int and count >= 0 else 0
    diagnostic = {'at': now(), 'stage': stage if stage in STAGES else 'configuration',
                  'errorType': type(error).__name__ if type(error).__name__ in
                  ('BridgeError', 'ValueError', 'OSError', 'TimeoutExpired', 'CalledProcessError') else 'OtherError',
                  'httpStatus': status, 'consecutiveFailures': min(count + 1, 1000000),
                  'lastSuccessAt': previous.get('lastSuccessAt')}
    atomic_json(path, diagnostic)
    return diagnostic


def success(b):
    atomic_json(folder(b) / 'heartbeat-health.json',
                {'at': now(), 'lastSuccessAt': now(), 'consecutiveFailures': 0, 'stage': 'heartbeat_request'})


def recover_if_requested(b, stamp=None):
    """Return True to exit with failure for the normal supervisor to restart.

    Never signal a process, clear a task/lease, or treat stale presence as proof
    of idle. If gates cannot be verified, leave the watcher and tasks running.
    """
    from platform_support import fcntl
    from seat_upgrade import assert_idle
    from seats import seat_api
    runtime = Path(b.cfg['database']).parent
    request = folder(b) / 'heartbeat-recovery-request.json'
    if not request.is_file():
        return False
    stamp = time.time() if stamp is None else stamp
    def report(condition):
        try:
            atomic_json(folder(b) / 'heartbeat-recovery.json', {'at': now(), 'condition': condition})
        except (RuntimeError, OSError, ValueError):
            pass
        return False
    try:
        intent = read_json(request)
        if intent.get('agentId') != b.cfg['agent_id'] or not 0 <= stamp - intent['requestedEpoch'] <= 300:
            return report('request_invalid_or_expired')
        with contextlib.ExitStack() as stack:
            for path in (runtime / 'upgrade.lock', runtime / 'interactive/operator.lock', folder(b) / 'delivery.lock'):
                path.parent.mkdir(parents=True, exist_ok=True)
                lock = stack.enter_context(path.open('a'))
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return report('activity_lock_busy')
            if (runtime / 'seat-offline.json').exists() or (runtime / 'upgrade-in-progress.json').exists():
                return report('offline_or_upgrading')
            state = load(folder(b) / 'state.json')
            seen = state.get('lastHeartbeat')
            if seen and -5 <= stamp - dt.datetime.fromisoformat(seen.replace('Z', '+00:00')).timestamp() < 90:
                request.unlink(missing_ok=True)
                return report('heartbeat_recovered')
            attempts_path = folder(b) / 'heartbeat-restart-attempts.json'
            attempts = [x for x in load(attempts_path).get('epochs', []) if 0 <= stamp - x < 3600]
            if len(attempts) >= 3 or (attempts and stamp - attempts[-1] < 300):
                return report('restart_limit_reached')
            # Use the bound seat credential, not an old CLI credential.
            assert_idle(b, api=seat_api(b))
            from platform_support import process_alive
            for session in (runtime / 'interactive/runs').glob('*/session.json'):
                info = read_json(session)
                pid = int(info.get('wrapper_pid') or 0)
                if pid > 1 and process_alive(pid):
                    return report('local_wrapper_running')
            if b.db.execute("SELECT 1 FROM seat_commands WHERE status IN ('queued','accepted','running','awaiting_local') LIMIT 1").fetchone():
                return report('pending_commands')
            # Recheck explicit offline intent immediately before committing exit.
            if (runtime / 'seat-offline.json').exists() or (runtime / 'upgrade-in-progress.json').exists():
                return report('offline_or_upgrading')
            atomic_json(attempts_path, {'epochs': [*attempts, stamp]})
            request.unlink(missing_ok=True)
            report('idle_restart_ready')
            return True
    except (RuntimeError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, sqlite3.Error):
        return report('idle_unverified')


def diagnose(b, stamp=None):
    stamp = time.time() if stamp is None else stamp
    state = load(folder(b) / 'state.json')
    seen = state.get('lastHeartbeat')
    try:
        age = round(stamp - dt.datetime.fromisoformat(seen.replace('Z', '+00:00')).timestamp())
    except (ValueError, AttributeError, TypeError):
        age = None
    diagnostic = load(folder(b) / 'heartbeat-health.json')
    stage = diagnostic.get('stage')
    status = diagnostic.get('httpStatus')
    recovery = load(folder(b) / 'heartbeat-recovery.json').get('condition')
    conditions = {'request_invalid_or_expired', 'activity_lock_busy', 'offline_or_upgrading',
                  'heartbeat_recovered', 'restart_limit_reached', 'pending_commands',
                  'idle_restart_ready', 'idle_unverified', 'local_wrapper_running'}
    return {'heartbeatAgeSeconds': age, 'stage': stage if stage in STAGES else None,
            'httpStatus': status if type(status) is int and 100 <= status <= 599 else None,
            'consecutiveFailures': diagnostic.get('consecutiveFailures') if type(diagnostic.get('consecutiveFailures')) is int else None,
            'recovery': recovery if recovery in conditions else None}
