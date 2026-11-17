"""Frozen platform observation attachments, carried by the original run permit."""
import json
import uuid
from pilot import BridgeError

ENV = 'DSP7_HARNESS_OBSERVER_ATTACHMENT'
KEYS = {'schema','companyId','seatId','machineId','taskId','runId','projectId',
        'registryRevision','bundle','purpose','executionReady','loadState'}


def validate_binding(value, cfg, run_id, task_id, check_local=True):
    if value is None:
        return None
    if (not isinstance(value,dict) or set(value)!=KEYS or
            value['schema']!='harness.observer-binding/1' or value['purpose']!='observation-only' or
            value['executionReady'] is not False or value['loadState']!='unconfirmed' or
            type(value['registryRevision']) is not int or not 0<=value['registryRevision']<=9007199254740991):
        raise BridgeError('平台观察附件合同无效')
    expected=dict(companyId=cfg['company_id'],seatId=cfg['agent_id'],machineId=cfg['seat']['machine_id'],
                  runId=run_id,taskId=task_id)
    if any(value[k]!=v for k,v in expected.items()):
        raise BridgeError('平台观察附件运行身份不匹配')
    try:
        for key in (*expected,'projectId'):
            if key=='projectId' and value[key] is None:continue
            if not isinstance(value[key],str) or str(uuid.UUID(value[key]))!=value[key]:raise ValueError()
    except (ValueError,TypeError,AttributeError):raise BridgeError('平台观察附件身份无效')
    if check_local:
        from harness_bundle_registry import descriptor
        config=cfg.get('harness_v2_observation',{})
        scope=cfg.get('harness_v2_pilot',{})
        if (config.get('enabled') is not True or not config.get('bundleRoot') or
                scope.get('companyId')!=cfg['company_id'] or scope.get('seatId')!=cfg['agent_id'] or
                task_id not in scope.get('taskIds',[])):
            raise BridgeError('平台观察附件未命中本机试点配置')
        local=descriptor(config)
        # Registry normalizes skill/package order; JSON types remain exact.
        def canonical(bundle):
            bundle=json.loads(json.dumps(bundle))
            for package in bundle['packages']:package['skills'].sort()
            bundle['packages'].sort(key=lambda p:p['layer'])
            return json.dumps(bundle,sort_keys=True,separators=(',',':'))
        try:
            if canonical(value['bundle'])!=canonical(local):raise ValueError()
        except (ValueError,TypeError,KeyError,AttributeError):raise BridgeError('平台观察附件与本机冻结包不匹配')
    return value


def from_env(env):
    if ENV not in env:return None
    raw=env[ENV]
    try:
        if not isinstance(raw,str) or not raw or len(raw)>16384:raise ValueError()
        value=json.loads(raw)
        if value is None:raise ValueError()
        return value
    except (ValueError,TypeError):raise BridgeError('平台观察附件传输无效')


def check_renewal(expected, permit):
    current=permit.get('harnessObserver') if isinstance(permit,dict) else None
    if current!=expected:
        raise BridgeError('平台观察附件续租发生变化，停止原运行')
