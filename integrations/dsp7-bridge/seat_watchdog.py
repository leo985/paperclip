"""One-shot, per-seat recovery probe. Copied to a stable path by the installer.

Keep this file standard-library-only: it must survive bridge upgrades/rollbacks.
"""
import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import time

INTERVAL_SECONDS = 60
HEARTBEAT_TTL_SECONDS = 90
RETRY_SECONDS = 300


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        temporary.chmod(0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


@contextlib.contextmanager
def try_lock(path):
    """Use the same first-byte OS lock as the bridge, including on Windows."""
    with path.open('a+b') as stream:
        if sys.platform == 'win32':
            import msvcrt
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                yield False
                return
            try:
                yield True
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            try:
                yield True
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)


def heartbeat_age(runtime, now):
    try:
        stamp = read_json(runtime / 'seat-control/state.json')['lastHeartbeat']
        seen = dt.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
        if seen.tzinfo is None:
            return None
        return round(now - seen.timestamp(), 1)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def probe(config, cfg, settings, now):
    runtime = Path(cfg['database']).expanduser().parent
    if (runtime / 'seat-offline.json').exists():
        return {'condition': 'manual_offline'}
    if (runtime / 'upgrade-in-progress.json').exists():
        return {'condition': 'upgrading'}
    if cfg.get('execution_transport') != 'outbound' or not cfg.get('seat_runtime'):
        return {'condition': 'unregistered'}
    age = heartbeat_age(runtime, now)
    # The exclusive watch lock is also held by a manually started watcher.
    with try_lock(Path(cfg['database']).with_suffix('.watch.lock')) as available:
        running = not available
    result = {'heartbeat_age_seconds': age, 'watcher_running': running}
    if age is not None and -5 <= age < HEARTBEAT_TTL_SECONDS and running:
        return dict(result, condition='healthy')
    if now - settings.get('installed_at', 0) < HEARTBEAT_TTL_SECONDS:
        return dict(result, condition='starting')
    return dict(result, condition='heartbeat_stale' if running else 'service_stopped')


def recover(config, cfg, settings):
    # Read the current bridge from config on every probe. An upgrade rollback
    # restores this value, so the timer never resurrects the replaced bridge.
    bridge = Path((cfg.get('quick_setup') or {}).get('bridge') or settings['bridge'])
    entry = bridge / 'harness_entry.py'
    if not entry.is_file():
        return {'action': 'command_missing'}
    try:
        result = subprocess.run(
            [settings['python'], str(entry), 'online'],
            env=dict(os.environ, DSP7_BRIDGE_CONFIG=str(config), PAPERCLIP_SEAT_WATCHDOG_RECOVERY='1'),
            capture_output=True, timeout=60,
            **({'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}),
        )
        return {'action': 'online_requested', 'exit_code': result.returncode}
    except subprocess.TimeoutExpired:
        return {'action': 'online_timeout'}
    except OSError:
        return {'action': 'online_failed'}


def check(directory, now=None):
    now = time.time() if now is None else now
    settings = read_json(directory / 'settings.json')
    config = Path(settings['config'])
    cfg = read_json(config)
    runtime = Path(cfg['database']).expanduser().parent
    with try_lock(directory / 'check.lock') as acquired:
        if not acquired:
            return {'condition': 'check_running'}
        # Hold the upgrader's lock through recovery so it cannot start between
        # our guard and online. online itself does not acquire this lock.
        with try_lock(runtime / 'upgrade.lock') as upgrade_available:
            if not upgrade_available:
                result = {'condition': 'upgrading'}
            else:
                cfg = read_json(config)
                result = probe(config, cfg, settings, now)
                if result['condition'] in ('service_stopped', 'heartbeat_stale'):
                    try:
                        previous = read_json(directory / 'attempt.json')
                    except (OSError, ValueError):
                        previous = {}
                    elapsed = now - previous.get('at', 0)
                    if 0 <= elapsed < RETRY_SECONDS:
                        result['action'] = 'cooldown'
                    else:
                        # Persist before invoking online; failed calls are also
                        # rate limited and never reset the last real heartbeat.
                        write_json(directory / 'attempt.json', {'at': now})
                        result.update(recover(config, cfg, settings))
            result['checked_at'] = dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat()
            write_json(directory / 'status.json', result)
            if result.get('action') and result['action'] != 'cooldown':
                log = directory / 'watchdog.log'
                if log.exists() and log.stat().st_size > 1024 * 1024:
                    os.replace(log, directory / 'watchdog.previous.log')
                with log.open('a', encoding='utf-8') as stream:
                    log.chmod(0o600)
                    stream.write(json.dumps(result, ensure_ascii=False) + '\n')
            return result


def main():
    directory = Path(__file__).resolve().parent
    try:
        result = check(directory)
        updater = directory / 'remote_upgrade.py'
        if updater.is_file() and result.get('condition') in ('healthy', 'starting', 'upgrading'):
            import importlib.util
            spec = importlib.util.spec_from_file_location('paperclip_seat_remote_upgrade', updater)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.check(directory)
    except (OSError, ValueError, KeyError, TypeError) as error:
        # No credentials, HTTP bodies or arbitrary exception text in logs.
        write_json(directory / 'status.json', {'condition': 'check_failed', 'error_type': type(error).__name__})
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
