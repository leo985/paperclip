"""Resolve a server-pinned domain route against this machine's live registry.
No directory, script, shell command or skill supplied by a task is executable.
"""
from pathlib import Path
from harness_capabilities import inspect
from pilot import BridgeError
from seats import identity, seat_api


def resolve_route(b, route, run_id, task_id, kind):
    if route is None:
        if kind != 'development': raise BridgeError('新领域缺少经过核验的 Harness 路由')
        return None  # enrolled legacy development remains compatible
    machine = identity(b)
    if (route.get('protocolVersion') != 1 or route.get('runId') != run_id or route.get('taskId') != task_id
            or route.get('agentId') != b.cfg['agent_id'] or route.get('companyId') != b.cfg['company_id']
            or route.get('machineId') != machine['machine_id']):
        raise BridgeError('Harness 路由与本机运行身份不匹配')
    registry = seat_api(b).request('GET','/agents/'+b.cfg['agent_id']+'/dsp7-harness-capabilities')
    if registry.get('version') != 1 or registry.get('revision') != route.get('registryRevision'):
        raise BridgeError('Harness 路由版本已变化，请重新核验授权')
    capability = next((c for c in registry.get('items',[]) if c.get('id') == route.get('capabilityId')),None)
    if not capability or capability.get('kind') != kind: raise BridgeError('Harness 能力不属于本机的目标领域')
    local = next((c for c in b.cfg.get('harness_capabilities',{}).get('items',[]) if c.get('id') == route.get('capabilityId')),None)
    if not local or any(local.get(k) != capability.get(k) for k in route.get('capability',{})):
        raise BridgeError('该能力没有本机登记回执，请在本机重新登记，不接受网页任意目录')
    current = inspect(capability['root'],kind,capability['profile'])
    if any(current[k] != capability.get(k) or current[k] != route.get('capability',{}).get(k) for k in current):
        raise BridgeError('Harness 仓库、profile、文件或版本已变化，请空闲时重新登记')
    return current


def assert_legacy_development_root(b, resolved):
    if resolved and Path(resolved['root']).resolve() != b.root.resolve():
        raise BridgeError('该旧研发任务已绑定原 Harness；不能静默迁移到另一个目录，请在目标 Harness 重新接入任务')
