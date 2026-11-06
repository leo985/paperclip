"""Local identities for one computer enrolled in several organizations."""
from pathlib import Path
import hashlib
import json
import os
import uuid


def default_config():
    return Path.home()/'.config/paperclip-dsp7-bridge/config.json'


def config_path():
    return Path(os.environ.get('DSP7_BRIDGE_CONFIG') or default_config()).expanduser().resolve()


def organization_config(server, company_id):
    company_id = str(uuid.UUID(company_id))
    host = hashlib.sha256(server.rstrip('/').encode()).hexdigest()[:16]
    return default_config().parent/'organizations'/host/company_id/'config.json'


def configurations():
    return [p for p in [default_config(), *sorted(default_config().parent.glob('organizations/*/*/config.json'))] if p.is_file()]


def select_config(server, company_id, explicit=None):
    for path in ([Path(explicit)] if explicit else configurations()):
        if path.is_file():
            cfg = json.loads(path.read_text())
            if cfg.get('paperclip_url', '').rstrip('/') == server.rstrip('/') and cfg.get('company_id') == company_id:
                return path
            if explicit:
                raise RuntimeError('指定配置属于其他组织或网站，不能覆盖；请取消 --config 后重试')
    return Path(explicit) if explicit else (default_config() if not default_config().exists() else organization_config(server, company_id))


def service_suffix():
    path = config_path()
    return '' if path == default_config().resolve() else '-'+hashlib.sha256(str(path).encode()).hexdigest()[:16]


def service_label():
    return 'com.leo.paperclip-dsp7-bridge'+service_suffix()


def cli_name():
    return 'harness'+service_suffix()


def windows_watch_arguments(bridge):
    # Preserve the original default task's arguments for in-place compatibility.
    arguments='"'+str(Path(bridge)/'watch_windows.py')+'"'
    if service_suffix():arguments+=' --config "'+str(config_path())+'"'
    return arguments


def activate(path):
    os.environ['DSP7_BRIDGE_CONFIG'] = str(Path(path).expanduser().resolve())


def route_cli(argv):
    """Select before importing pilot, whose defaults are resolved at import time."""
    selector = None
    if argv[:1] == ['--company']:
        if len(argv) < 3: raise RuntimeError('用法：harness --company <组织名称或 UUID> <命令>')
        selector = ('company', argv[1]); argv = argv[2:]
    else:
        for flag in ('--seat-id', '--agent-id'):
            if flag in argv:
                index = argv.index(flag)
                if index+1 < len(argv): selector = ('agent', argv[index+1])
    if selector:
        matches = []
        for path in configurations():
            cfg = json.loads(path.read_text())
            values = (cfg.get('company_id'), cfg.get('company_name')) if selector[0] == 'company' else (cfg.get('agent_id'),)
            if selector[1] in values: matches.append(path)
        if len(matches) != 1: raise RuntimeError('未找到唯一的本机组织席位，请核对组织名称或席位编号')
        activate(matches[0])
    return argv
