"""Resolve authoritative seat argv immediately before starting a managed Claude."""
import re
from pilot import BridgeError
from seats import identity, seat_api

VALUE_FLAGS = {'--model', '--effort', '--permission-mode'}
SKIP = '--dangerously-skip-permissions'


def validate(args):
    if not isinstance(args, list) or len(args) > 7 or not all(isinstance(a, str) and len(a) <= 160 for a in args):
        raise BridgeError('席位 Claude 启动参数无效')
    seen = set(); i = 0
    while i < len(args):
        flag = args[i]; i += 1
        if flag in seen: raise BridgeError('席位 Claude 启动参数重复')
        seen.add(flag)
        if flag == SKIP: continue
        if flag not in VALUE_FLAGS or i >= len(args): raise BridgeError('不支持的席位 Claude 启动参数')
        value = args[i]; i += 1
        if not value or value.startswith('-') or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
            raise BridgeError('席位 Claude 启动参数取值无效')
        if flag == '--model' and not re.fullmatch(r'[a-zA-Z0-9._:/-]{1,160}', value): raise BridgeError('Claude 模型参数无效')
        if flag == '--effort' and value not in ('low', 'medium', 'high', 'max'): raise BridgeError('Claude 推理强度无效')
        if flag == '--permission-mode' and value not in ('default', 'acceptEdits', 'plan', 'dontAsk', 'auto'): raise BridgeError('Claude 权限模式无效')
    if SKIP in seen and '--permission-mode' in seen: raise BridgeError('跳过权限确认与权限模式不能同时配置')
    return args


def resolve(b, args):
    # Do not use heartbeat caches: an explicit empty web setting disables legacy skip.
    value = seat_api(b).request('POST', '/agents/' + b.cfg['agent_id'] + '/dsp7-seat-launch-options', identity(b))
    if not isinstance(value, dict) or type(value.get('configured')) is not bool:
        raise BridgeError('无法核验席位 Claude 启动参数，请检查服务端版本')
    if not value['configured']:
        return list(args), b.cfg.get('claude_skip_permissions') is True, {'source': 'local', 'revision': 0}
    extra = validate(value.get('extraArgs'))
    revision = value.get('revision')
    if type(revision) is not int or revision < 1: raise BridgeError('席位启动配置版本无效')
    # Web settings fully replace the supported options from adapter/local argv.
    merged = []; i = 0
    while i < len(args):
        arg = args[i]; flag = arg.split('=', 1)[0]; i += 1
        if flag in VALUE_FLAGS:
            if '=' not in arg: i += 1
            continue
        if flag in (SKIP, '--allow-dangerously-skip-permissions'): continue
        merged.append(arg)
    merged.extend(extra)
    return merged, SKIP in extra, {'source': 'seat', 'revision': revision, 'extraArgs': extra}
