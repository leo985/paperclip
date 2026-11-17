"""Fixed synthetic entry under the original native permit and process supervisor.

No issue prompt, arbitrary script, Jira pilot, business checkout or new scheduler.
"""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
import uuid
from pilot import BridgeError
from harness_observer_binding import validate_binding, KEYS


def validate(packet, cfg):
    from platform_support import _JOB_HANDLES
    permit = packet.get('permit') or {}
    observer = validate_binding(permit.get('harnessObserver'), cfg, packet['runId'], packet['taskId'])
    value = permit.get('harnessValidation')
    fields = (KEYS - {'purpose', 'executionReady', 'loadState'}) | {'dispatchId', 'expiresAt', 'purpose', 'fixtureVersion'}
    if (not (os.name == 'posix' or (os.name == 'nt' and _JOB_HANDLES)) or not observer or not isinstance(value, dict) or set(value) != fields or
            value.get('schema') != 'harness.validation-binding/1' or value.get('purpose') != 'synthetic-history' or
            type(value.get('fixtureVersion')) is not int or value['fixtureVersion'] != 1 or
            value.get('dispatchId') != packet.get('harnessValidationDispatchId') or
            packet.get('executionKind') != 'validation' or packet.get('executionRoute') is not None):
        raise BridgeError('隔离验证合同或固定入口无效')
    try:
        if str(uuid.UUID(value['dispatchId'])) != value['dispatchId']: raise ValueError()
        expires = datetime.datetime.fromisoformat(value['expiresAt'].replace('Z', '+00:00'))
        if expires.tzinfo is None or expires.timestamp() <= datetime.datetime.now(datetime.timezone.utc).timestamp(): raise ValueError()
    except (ValueError, TypeError, AttributeError): raise BridgeError('隔离验证授权已到期或编号无效')
    if any(value[k] != observer[k] for k in KEYS - {'schema', 'purpose', 'executionReady', 'loadState'}):
        raise BridgeError('隔离验证与观察附件冻结范围不一致')
    if packet.get('skills') or packet.get('mcp'):
        raise BridgeError('隔离验证不接收任务脚本或动态 MCP')
    return value


def check_renewal(expected, permit):
    if not isinstance(permit, dict) or permit.get('harnessValidation') != expected:
        raise BridgeError('隔离验证授权续验发生变化')


def model_environment(env, profile):
    """Carry the enrolled local model connection into restricted Claude.

    Restricted mode omits implicit user settings. Copy only model connection
    keys, never plugins, hooks, platform keys or arbitrary settings env entries.
    Existing process values keep their normal precedence; nothing is persisted.
    """
    keys={'ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_MODEL'}
    settings=[Path.home()/'.claude/settings.json']
    if profile.get('claudeSettingsFile'):settings.append(Path(profile['claudeSettingsFile']))
    values={}
    for path in settings:
        if not path.exists():continue
        if not path.is_file() or path.stat().st_size>1024*1024:raise BridgeError('本机模型连接配置无效')
        try:document=json.loads(path.read_text(encoding='utf-8'));configured=document.get('env',{})
        except (OSError,ValueError,AttributeError):raise BridgeError('本机模型连接配置无效') from None
        if not isinstance(configured,dict):raise BridgeError('本机模型连接配置无效')
        values.update({k:v for k,v in configured.items() if k in keys and isinstance(v,str)})
    for key,value in values.items():env.setdefault(key,value)
    return env


def prepare(b, packet, folder):
    binding = validate(packet, b.cfg)
    from harness_bundle import validate as verify_bundle
    from seats import verify_runtime
    bundle = verify_bundle(b.cfg['harness_v2_observation'])
    # Verify all frozen bytes before importing the fixed helper and its siblings.
    tools = Path(bundle['runtimeRoot'])/'tools'
    for name in ('history_validation.py', 'history_acceptance.py', 'history-probe-tool.py'):
        if not (tools/name).is_file(): raise BridgeError('冻结组合缺少固定验证入口')
    spec = importlib.util.spec_from_file_location('pinned_history_validation', tools/'history_validation.py')
    runner = importlib.util.module_from_spec(spec)
    # Execute verified bytes without creating unlisted __pycache__ in the bundle.
    prior = sys.modules.pop('history_acceptance', None)
    try:
        helper_spec=importlib.util.spec_from_file_location('history_acceptance',tools/'history_acceptance.py')
        helper=importlib.util.module_from_spec(helper_spec)
        exec(compile((tools/'history_acceptance.py').read_bytes(),str(tools/'history_acceptance.py'),'exec'),helper.__dict__)
        sys.modules['history_acceptance']=helper
        exec(compile((tools/'history_validation.py').read_bytes(),str(tools/'history_validation.py'),'exec'),runner.__dict__)
    finally:
        sys.modules.pop('history_acceptance', None)
        if prior is not None: sys.modules['history_acceptance'] = prior
    profile = verify_runtime(b)
    state = runner.prepare(Path(bundle['root']), binding['bundle']['bundleDigest'], folder/'validation',
        packet['runId'], binding, profile['claudeCommand'])
    if profile.get('claudeSettingsFile'): state['command'] += ['--settings', profile['claudeSettingsFile']]
    state['env']=model_environment(state['env'],profile)
    # Remove platform credentials before launching the isolated model.
    for key in ('PAPERCLIP_API_KEY', 'DSP7_HARNESS_OBSERVER_ATTACHMENT', 'HARNESS_CORE_CONTEXT'):
        state['env'].pop(key, None)
    from managed_sessions import register_local, Collector
    register_local(b.cfg, packet['runId'], packet['taskId'], state['cwd'],
        state['workspace']/'output/analysis-state.json', folder, b.config_path)
    collector = Collector(b.cfg, packet['runId'])
    with collector.db:
        collector.setmeta('harness_observer_runtime', dict(binding=json.loads(state['binding_path'].read_text()),
            packageRoot=bundle['runtimeRoot'], packageDigest=bundle['sourceDigest'],
            bundleConfig=dict(b.cfg['harness_v2_observation']), platformAttachment=permit_observer(packet)))
        collector.event('collector', 'lifecycle', {'state':'started', 'policy':'full-visible-redacted-v1'})
    return dict(binding=binding, runner=runner, state=state, collector=collector)


def permit_observer(packet):
    return packet['permit']['harnessObserver']


def observe(context):
    from harness_observation_runtime import poll
    collector = context['collector']
    poll(collector)
    try: collector.upload(1)
    except Exception: collector.status('隔离验证观察待补传')


def finish(context, code):
    report, summary = context['runner'].finish(context['state'], code)
    # Independent semantics + native session required; never upgrade platformAccepted.
    report['platformAuthorized'] = True
    context['report'] = report
    (context['state']['probe']/'report.json').write_text(json.dumps(report, indent=2)+'\n')
    observe(context)
    collector = context['collector']
    with collector.db:
        collector.event('collector', 'lifecycle', {'state':'exited', 'boundary':'fixed-validation-finished'})
        collector.db.execute('UPDATE sessions SET ended=1 WHERE run_id=?', (collector.run_id,))
    try: collector.upload(1)
    except Exception: collector.status('隔离验证结果待补传')
    return report, summary


def recover_orphans(b):
    """Observe stopped orphan sessions after restart; never restart or kill work.

    Missing launch evidence remains unknown and retains native capacity fencing.
    The parent's child fence handles termination independently of network I/O.
    """
    import time
    import subprocess
    from platform_support import process_alive
    from process_tree import posix_members
    from pilot import atomic_json, read_json
    if os.name == 'nt':
        from windows_validation_supervisor import recover
        recover(b)
        return
    if os.name != 'posix': return
    root=(Path(b.cfg['database']).parent/'outbound').resolve()
    for journal in sorted(root.glob('*/validation-recovery.json'))[:20]:
        try:
            if journal.resolve()!=journal or journal.stat().st_size>4096:continue
            saved=read_json(journal);run=str(uuid.UUID(saved['runId']))
            if (journal.parent.name!=run or saved.get('receiptQueued') is True or
                    saved['companyId']!=b.cfg['company_id'] or saved['seatId']!=b.cfg['agent_id'] or
                    saved['machineId']!=b.cfg['seat']['machine_id'] or
                    type(saved['supervisorPid']) is not int or saved['supervisorPid']<=1 or
                    process_alive(saved['supervisorPid'])):continue
            uuid.UUID(saved['lease'])
            anchor=journal.parent/'process-tree-anchor.json'
            if anchor.resolve()!=anchor or not anchor.is_file() or anchor.stat().st_size>4096:continue
            value=read_json(anchor);sid=value.get('sessionId')
            if value.get('runId')!=run or value.get('supervisorPid')!=saved['supervisorPid'] or type(sid) is not int or sid<=1:continue
            first=time.time()
            if posix_members({sid}):continue
            time.sleep(.3)
            if posix_members({sid}):continue
            iso=lambda stamp:datetime.datetime.fromtimestamp(stamp,datetime.timezone.utc).isoformat()
            proof=dict(protocolVersion=1,runId=run,isolation='posix-sessions',firstObservedAt=iso(first),observedAt=iso(time.time()),observations=2,remaining=0)
            atomic_json(journal.parent/'exit-receipt.json',dict(runId=run,lease=saved['lease'],treeProof=proof))
            atomic_json(journal,{**saved,'receiptQueued':True})
        except (OSError,ValueError,KeyError,TypeError,BridgeError,subprocess.SubprocessError):continue
