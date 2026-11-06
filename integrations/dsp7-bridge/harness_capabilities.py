"""Read-only local Harness inspection and machine-bound capability registration.

Registration changes metadata only: it never switches the legacy harness_root,
executes a domain task, or grants execution authority.
"""
import argparse
import base64
import shutil
import sys
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.parse
from pilot import Bridge, BridgeError, atomic_json
from seats import identity, seat_api

ROLE_SKILLS = {
    'analysis': {'requirements-analysis': 'requirements-analysis'},
    'development': {'system-design': 'jira-design-doc', 'coding': 'jira-feature-dev', 'bug-fix': 'jira-bug-fix', 'code-review': 'jira-code-review', 'design-review': 'jira-design-review'},
    'qa': {'test-cases': 'jira-testcase-writing', 'functional-test': 'jira-testcase-execution', 'test-case-review': 'jira-testcase-review'},
}

def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, timeout=15)
    if result.returncode: raise BridgeError('无法读取 Harness Git 身份，请检查仓库及 origin 配置')
    return result.stdout.strip()

def repository_identity(remote):
    if re.match(r'^[A-Za-z]:[\\/]', remote):
        raise BridgeError('Harness origin 不能使用本机目录')
    if remote.startswith(('http://', 'https://', 'ssh://')):
        url = urllib.parse.urlsplit(remote)
        host = url.hostname or ''
        # Tokens, credentials, query strings and fragments never leave this computer.
        host += ':' + str(url.port) if url.port else ''
        path = url.path
    else:
        match = re.fullmatch(r'(?:[^@\s]+@)?([A-Za-z0-9.-]+):(.+)', remote)
        if not match: raise BridgeError('Harness origin 必须是共享 Git 仓库地址，不能使用本机目录')
        host, path = match.groups()
    result = host.lower() + '/' + path.strip('/').removesuffix('.git')
    if not re.fullmatch(r'[A-Za-z0-9.-]+(?::\d+)?/[A-Za-z0-9_./-]+', result) or any(segment in ('.', '..') for segment in result.split('/')):
        raise BridgeError('Harness 共享仓库身份无效')
    return result

def inspect(root, kind, profile='default'):
    root = Path(root).expanduser().resolve(strict=True)
    if not root.is_dir() or Path(git(root, 'rev-parse', '--show-toplevel')).resolve() != root:
        raise BridgeError('请选择 Harness 的 Git 根目录')
    if kind not in ROLE_SKILLS or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', profile): raise BridgeError('Harness 类型或 profile 无效')
    if kind == 'analysis' and profile == 'default':
        active = root / 'harness/profiles/active.json'
        if not active.is_file() or not active.resolve().is_relative_to(root):
            raise BridgeError('分析 Harness 缺少默认 profile')
        profile = json.loads(active.read_text(encoding='utf-8')).get('profile')
        if not isinstance(profile, str) or not re.fullmatch(r'[a-z0-9-]{1,64}', profile):
            raise BridgeError('分析 Harness 默认 profile 无效')
    files = [root / 'CLAUDE.md']
    roles = []
    for role, skill in ROLE_SKILLS[kind].items():
        path = root / '.claude/skills' / skill / 'SKILL.md'
        if path.is_file():
            if role in ('design-review','test-case-review'):
                contract=root/'harness/delivery-review-protocols.json'
                if not contract.is_file():continue
                protocols=json.loads(contract.read_text(encoding='utf-8'))
                if protocols.get(role)!={'workflow': 'design-review' if role=='design-review' else 'testcase-review', 'guardRole':role,'version':1}:continue
                files += [contract,root/'harness/issue-policy.json',path.parent/'templates/state.json']
                layout=root/'harness/artifact-layout.json'
                if layout.is_file():files.append(layout)
                files += [root/'harness/scripts'/name for name in ('issue_guard.py','execution_time.py','zhiyan_bridge.py','zhiyan_auto.py')]
                if role=='test-case-review':files.append(root/'.claude/skills/harness-report/scripts/harness_report.py')
            roles.append(role); files.append(path)
    if not roles: raise BridgeError('未发现匹配的原生 Harness 技能，不能声明此能力')
    if kind == 'analysis':
        files += [root / 'harness/scripts/analysis.py', root / 'harness/WORKFLOW.md']
        files.append(root / '.claude/skills/analysis-resume/SKILL.md')
        if profile != 'default':
            profile_file = root / 'harness/profiles' / (profile + '.json')
            files.append(profile_file)
            if not profile_file.is_file() or not profile_file.resolve().is_relative_to(root):
                raise BridgeError('Harness profile 文件缺失或越界')
            routing = json.loads(profile_file.read_text(encoding='utf-8')).get('routing')
            if not isinstance(routing, dict) or not routing:
                raise BridgeError('Harness profile 缺少技能路由')
            for skill in routing.values():
                if not isinstance(skill, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', skill):
                    raise BridgeError('Harness profile 技能路由无效')
                files.append(root / '.claude/skills' / skill / 'SKILL.md')
    rework=root/'harness/delivery-rework-protocol.json'
    if rework.is_file():files += [rework,root/'harness/scripts/delivery_rework.py',root/'harness/scripts/issue_guard.py',root/'harness/scripts/zhiyan_bridge.py',root/'harness/scripts/execution_time.py']
    digest = hashlib.sha256()
    for file in sorted(files):
        if not file.is_file() or not file.resolve().is_relative_to(root): raise BridgeError('Harness 必要文件缺失或越界：' + file.name)
        digest.update(str(file.relative_to(root)).encode()); digest.update(b'\0'); digest.update(hashlib.sha256(file.read_bytes()).digest())
    commit = git(root, 'rev-parse', 'HEAD')
    if not re.fullmatch(r'[a-f0-9]{40,64}', commit): raise BridgeError('Harness Git 版本无效')
    return {'kind': kind, 'repository': repository_identity(git(root, 'remote', 'get-url', 'origin')), 'root': str(root), 'profile': profile, 'commit': commit, 'manifestDigest': digest.hexdigest(), 'roles': sorted(roles), 'protocolVersion': 1}

def register(b, capability):
    api = seat_api(b); endpoint = '/agents/' + b.cfg['agent_id'] + '/dsp7-harness-capabilities'
    current = api.request('GET', endpoint)
    result = api.request('POST', endpoint, {**identity(b), 'expectedRevision': current['revision'], 'capability': capability})
    b.cfg['harness_capabilities'] = result
    atomic_json(b.config_path, b.cfg)
    return result

def choose_directory():
    """Ask the logged-in desktop user, without interpolating a path into code."""
    try:
        if sys.platform == 'darwin':
            command = ['osascript', '-e', 'try\nPOSIX path of (choose folder with prompt "请选择本机 Harness Git 根目录")\non error number -128\nreturn ""\nend try']
        elif sys.platform == 'win32':
            script = """[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false);
Add-Type -AssemblyName System.Windows.Forms;
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;
$dialog.Description = 'Select the local Harness Git root folder';
$dialog.ShowNewFolderButton = $false;
try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) } } finally { $dialog.Dispose() }
"""
            encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
            command = ['powershell.exe', '-NoProfile', '-STA', '-EncodedCommand', encoded]
        elif shutil.which('zenity'):
            command = ['zenity', '--file-selection', '--directory', '--title=请选择本机 Harness Git 根目录']
        elif shutil.which('kdialog'):
            command = ['kdialog', '--getexistingdirectory', str(Path.home()), '--title', '请选择本机 Harness Git 根目录']
        else:
            try:
                import tkinter
                from tkinter import filedialog
                window = tkinter.Tk(); window.withdraw()
                try: return filedialog.askdirectory(title='请选择本机 Harness Git 根目录', mustexist=True) or None
                finally: window.destroy()
            except Exception as error:
                raise BridgeError('无法打开目录选择框。请在已登录桌面的终端运行；无图形界面的电脑可继续使用 --path 指定目录') from error
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=600)
        if result.returncode == 1 and sys.platform not in ('darwin', 'win32') and not result.stderr.strip():
            return None  # zenity/kdialog cancellation
        if result.returncode:
            raise BridgeError('目录选择框未能打开，请在对应电脑已登录桌面的终端重试；也可使用 --path 指定目录')
        return result.stdout.strip() or None
    except (OSError, subprocess.TimeoutExpired) as error:
        raise BridgeError('目录选择未完成，请重试；无桌面环境时可使用 --path 指定目录') from error

def main(argv):
    parser = argparse.ArgumentParser(description='登记本机多个 Harness；不改变现有席位目录或执行授权')
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('list')
    add = sub.add_parser('register')
    location = add.add_mutually_exclusive_group(required=True)
    location.add_argument('--path', help='Harness Git 根目录')
    location.add_argument('--choose', action='store_true', help='打开本机系统目录选择框，免填路径')
    add.add_argument('--kind', choices=ROLE_SKILLS, required=True)
    add.add_argument('--profile', default='default')
    add.add_argument('--seat-id', help='网页生成命令绑定的席位；防止在其他席位电脑误登记')
    sub.add_parser('check')
    args = parser.parse_args(argv); b = Bridge()
    if args.action == 'register':
        if args.seat_id and args.seat_id != b.cfg.get('agent_id'):
            raise BridgeError('此命令属于其他席位，请在网页所选席位对应的电脑和原注册用户下执行；未修改登记')
        root = choose_directory() if args.choose else args.path
        if not root:
            print('已取消目录选择，未修改任何能力登记。'); return
        capability = inspect(root, args.kind, args.profile)
        result = register(b, capability)
    else:
        result = seat_api(b).request('GET', '/agents/' + b.cfg['agent_id'] + '/dsp7-harness-capabilities')
        if args.action == 'check':
            for item in result['items']: result = register(b, inspect(item['root'], item['kind'], item['profile']))
    print(json.dumps({'registry': result, 'message': '已保存本机 Harness 能力登记；刷新网页查看。登记不会启动任务；条目自动交付可按对应领域能力授权执行，需新版客户端。'}, ensure_ascii=False, indent=2))
