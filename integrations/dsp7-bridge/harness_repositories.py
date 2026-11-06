"""Read-only discovery within the seat's existing business-source allowlist.
No clone, fetch, framework execution, credentials or local paths are uploaded.
"""
import os
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.parse
from pilot import BridgeError


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, timeout=2,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    if result.returncode: raise BridgeError('无法读取本机业务仓库')
    return result.stdout.strip()


def safe_url(remote):
    if remote.startswith(('https://', 'http://', 'ssh://')):
        url = urllib.parse.urlsplit(remote)
        host = url.hostname or ''
        if url.port: host += ':' + str(url.port)
        value = url.scheme + '://' + host + url.path
    else:
        if '://' in remote: raise BridgeError('业务仓库 origin 协议无效')
        match = re.fullmatch(r'(?:[^@\s]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9_./-]+)', remote)
        if not match: raise BridgeError('业务仓库需要共享 Git origin')
        value = 'ssh://' + match[1].lower() + '/' + match[2]
    url = urllib.parse.urlsplit(value)
    if not re.fullmatch(r'[A-Za-z0-9.-]+', url.hostname or '') or not re.fullmatch(r'/[A-Za-z0-9_./-]+', url.path) or any(p in ('.', '..') for p in url.path.split('/')):
        raise BridgeError('业务仓库 origin 无效')
    return value.rstrip('/').removesuffix('.git')


def discover(b):
    roots = []
    for value in b.cfg.get('intake_repository_roots', []):
        try:
            path = Path(value).expanduser()
            if path.is_absolute() and path.is_dir(): roots.append(path.resolve(strict=True))
        except (OSError, ValueError, TypeError): continue
    if not roots: return []
    frameworks = {b.root.resolve()}
    for capability in b.cfg.get('harness_capabilities', {}).get('items', []):
        try: frameworks.add(Path(capability['root']).resolve())
        except (KeyError, OSError, ValueError): continue
    candidates = list((b.cfg.get('project_repositories') or {}).values())
    configured = False
    # additionalDirectories is Claude's directory permission list, not a Git
    # manifest. Read only that field, never env, hooks, commands or credentials.
    for framework in sorted(frameworks):
        settings = framework/'.claude/settings.local.json'
        try:
            if not settings.is_file() or settings.is_symlink() or not settings.resolve().is_relative_to(framework) or settings.stat().st_size > 1_000_000: continue
            data = json.loads(settings.read_text(encoding='utf-8'))
            directories = data.get('permissions', {}).get('additionalDirectories', [])
            if not isinstance(directories, list):
                configured = True
                continue
            for value in directories[:100]:
                if not isinstance(value, str) or not value.strip(): continue
                configured = True
                path = Path(value).expanduser()
                if not path.is_absolute():
                    # A foreign Windows path must not become a relative POSIX path.
                    if re.match(r'^[A-Za-z]:[\\/]', value) or value.startswith('\\'): continue
                    path = framework/path
                candidates.append(str(path))
        except (OSError, ValueError, TypeError, AttributeError):
            configured = True  # malformed native settings must not select unrelated repos
    deadline = time.monotonic() + 5
    # Legacy suites without directory references can still discover allowlisted
    # checkouts. An explicit native list is authoritative, even if stale/empty of
    # usable Git roots; never substitute an unrelated sibling repository for it.
    if not configured:
        scan_roots = list(roots)
        for framework in sorted(frameworks):
            for name in ('workspace', 'workspaces', 'repos'):
                folder = framework/name
                if folder.is_dir() and not folder.is_symlink() and any(folder.resolve().is_relative_to(root) for root in roots):
                    scan_roots.append(folder.resolve())
        visited = 0
        for root in scan_roots:
            for current, dirs, _ in os.walk(root, followlinks=False):
                visited += 1
                path = Path(current)
                dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in ('node_modules', 'build', 'dist', 'target', 'tickets') and not (path/d).is_symlink())
                if (path/'.git').exists():
                    candidates.append(str(path)); dirs[:] = []
                if len(path.relative_to(root).parts) >= 2: dirs[:] = []
                if visited >= 2000 or time.monotonic() >= deadline: break
            if visited >= 2000 or time.monotonic() >= deadline: break
    found = []; seen = set()
    for value in candidates:
        if len(found) >= 100 or time.monotonic() >= deadline: break
        try:
            path = Path(value).expanduser().resolve(strict=True)
            if path in seen or path in frameworks or not any(path.is_relative_to(root) for root in roots): continue
            seen.add(path)
            if (path/'harness/bin/harness').is_file(): continue
            if Path(git(path, 'rev-parse', '--show-toplevel')).resolve() != path: continue
            url = safe_url(git(path, 'remote', 'get-url', 'origin'))
            ref = git(path, 'symbolic-ref', '--quiet', '--short', 'HEAD')
            if not ref or len(ref)>250 or re.search(r'\s',ref): continue
            git(path, 'rev-parse', '--verify', '--end-of-options', ref+'^{commit}')
            found.append({'url': url, 'ref': ref, 'path': str(path)})
        except (OSError, ValueError, subprocess.TimeoutExpired, BridgeError): continue
    return found


def public_inventory(b):
    return [ {k: item[k] for k in ('url', 'ref')} for item in discover(b) ]


def resolve_existing(b, workspace):
    from seats import normalize_remote
    target = normalize_remote(workspace.get('repoUrl', ''))
    if not target: raise BridgeError('代码任务需要配置项目业务仓库；测试任务可只使用测试 Harness')
    candidates = [item for item in discover(b) if normalize_remote(item['url']) == target]
    ref = workspace.get('repoRef') or workspace.get('defaultRef')
    if ref:
        verified = []
        for item in candidates:
            try:
                git(item['path'], 'rev-parse', '--verify', '--end-of-options', ref+'^{commit}'); verified.append(item)
            except (BridgeError, subprocess.TimeoutExpired): continue
        candidates = verified
    paths = sorted({item['path'] for item in candidates})
    if len(paths) != 1:
        raise BridgeError('未找到唯一的本机业务仓库，请检查 Harness 工作区或使用 harness repo bind 明确绑定')
    return paths[0]
