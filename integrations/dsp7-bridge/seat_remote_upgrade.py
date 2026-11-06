"""Run only durable administrator upgrade requests; never upgrade on publication."""
import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        temporary.chmod(0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


@contextlib.contextmanager
def exclusive(path):
    with path.open('a+b') as stream:
        if sys.platform == 'win32':
            import msvcrt
            stream.seek(0)
            try: msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                yield False
                return
            try: yield True
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try: fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            try: yield True
            finally: fcntl.flock(stream, fcntl.LOCK_UN)


def api(config, action, body=None):
    cfg = read_json(config)
    server = cfg['paperclip_url'].rstrip('/')
    origin = urllib.parse.urlsplit(server)
    if origin.scheme not in ('http', 'https') or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment:
        raise ValueError('Invalid registered server')
    credentials = read_json(cfg['seat_credential_file'])
    if credentials.get('agentId') != cfg['agent_id'] or credentials.get('companyId') != cfg['company_id']:
        raise ValueError('Seat credential mismatch')
    seat = cfg['seat']
    identity = {'seat_id': cfg['agent_id'], 'machine_id': seat['machine_id'], 'machine_fingerprint': seat['machine_fingerprint']}
    request = urllib.request.Request(server + '/api/agents/' + cfg['agent_id'] + '/dsp7-seat-upgrade/' + action,
        data=json.dumps({**identity, **(body or {})}).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + credentials['token'], 'Content-Type': 'application/json'})
    # Never forward bearer credentials through an HTTP redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl): return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
        raw = response.read(32769)
        if len(raw) > 32768: raise ValueError('Upgrade response too large')
        return json.loads(raw)


def run_upgrade(settings, config, cfg, digest):
    entry = Path(cfg['quick_setup']['bridge']) / 'harness_entry.py'
    if not entry.is_file(): return 'failed'
    result = subprocess.run([settings['python'], str(entry), 'upgrade'],
        env=dict(os.environ, DSP7_BRIDGE_CONFIG=str(config), PAPERCLIP_UPGRADE_TARGET_SHA256=digest, PAPERCLIP_UPGRADE_SCOPE='seat'),
        stdin=subprocess.DEVNULL, capture_output=True,
        **({'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}))
    installed = read_json(config.parent / 'bridge-version.json').get('sha256')
    if result.returncode == 0 and installed == digest: return 'installed'
    output = (result.stdout + result.stderr).decode('utf-8', errors='replace')
    if any(word in output for word in ('空闲', '席位正在启动', '仍有', '执行中', '未结束')): return 'deferred'
    return 'failed'


def check(directory, now=None):
    directory = Path(directory); now = time.time() if now is None else now
    with exclusive(directory / 'remote-upgrade.lock') as acquired:
        if not acquired: return {'condition': 'check_running'}
        settings = read_json(directory / 'settings.json'); config = Path(settings['config']); cfg = read_json(config)
        runtime = Path(cfg['database']).parent
        result = {'condition': 'no_request'}
        state_path = directory / 'remote-upgrade.json'
        try: previous = read_json(state_path)
        except (OSError, ValueError): previous = {}
        if (runtime / 'seat-offline.json').exists(): result['condition'] = 'manual_offline'
        elif (runtime / 'upgrade-in-progress.json').exists(): result['condition'] = 'upgrading'
        else:
            try:
                request = api(config, 'poll').get('request')
                if request and request.get('status') in ('queued', 'claimed', 'verifying'):
                    digest = request.get('targetSha256'); request_id = request.get('requestId')
                    if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest): raise ValueError('Invalid target digest')
                    import uuid
                    if str(uuid.UUID(request_id)) != request_id: raise ValueError('Invalid upgrade request')
                    payload = {'requestId': request_id, 'targetSha256': digest}
                    result.update(request_id=request_id, target_sha256=digest)
                    current = read_json(config.parent / 'bridge-version.json').get('sha256')
                    if current == digest:
                        if request['status'] != 'queued': api(config, 'result', {**payload, 'status': 'installed'})
                        result['condition'] = 'installed'
                    elif request['status'] != 'queued':
                        # A crashed/unknown attempt must not be blindly replayed.
                        result['condition'] = 'awaiting_previous_attempt'
                        if previous.get('request_id') == request_id and now - previous.get('attempt_epoch', now) >= 600:
                            api(config, 'result', {**payload, 'status': 'failed'}); result['condition'] = 'failed'
                    else:
                        api(config, 'claim', payload)
                        result.update(condition='claimed', attempt_epoch=now)
                        save_json(state_path, result)
                        if (runtime / 'seat-offline.json').exists(): outcome = 'deferred'
                        else: outcome = run_upgrade(settings, config, read_json(config), digest)
                        api(config, 'result', {**payload, 'status': outcome})
                        result['condition'] = outcome
                elif request:
                    result['condition'] = request.get('status', 'no_request')
            except urllib.error.HTTPError as error:
                result.update(condition='deferred' if error.code == 409 else 'request_failed', http_status=error.code)
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
                result.update(condition='check_failed', error_type=type(error).__name__)
        if previous.get('request_id') == result.get('request_id') and 'attempt_epoch' in previous:
            result.setdefault('attempt_epoch', previous['attempt_epoch'])
        result['checked_at'] = dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat()
        save_json(state_path, result)
        return result
