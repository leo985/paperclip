"""Opt-in launcher/poller for the pinned Harness V2 observation package."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

FILES = ('mods/.claude-plugin/plugin.json', 'mods/hooks/hooks.json', 'mods/hooks/observe.ts', 'src/observation-query.mjs')


def package_digest(root):
    root = Path(root)
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError('Package root must be canonical')
    digest = hashlib.sha256()
    for name in FILES:
        path = root / name
        if path.resolve() != path or not path.is_file() or path.stat().st_size > 1024 * 1024:
            raise ValueError('Invalid package file')
        digest.update(name.encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def prepare(collector, cli_args, domain_context=None, platform_attachment=None):
    """Called only after existing run registration and permission checks.

    Does not grant authority or start a subprocess. Caller retains original args
    on failure. Resource digest is the operator's declared lock, not attestation.
    """
    if platform_attachment is not None:
        from harness_observer_binding import validate_binding
        validate_binding(platform_attachment,collector.cfg,collector.run_id,collector.row()['task_id'])
    config = collector.cfg.get('harness_v2_observation', {})
    if not config or config.get('enabled') is not True:
        return list(cli_args), {}
    # Restrict candidate loading to explicitly selected tasks on the selected seat.
    # This filter is not a substitute for the original platform run/permit checks.
    scope = collector.cfg.get('harness_v2_pilot')
    if not isinstance(scope, dict) or set(scope) != {'companyId', 'seatId', 'taskIds'}:
        raise ValueError('Explicit pilot scope required')
    task_ids = scope['taskIds']
    if not isinstance(task_ids, list) or not 1 <= len(task_ids) <= 16:
        raise ValueError('Invalid pilot task scope')
    for value in [scope['companyId'], scope['seatId'], *task_ids]:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError('Invalid pilot identity')
    if (scope['companyId'] != collector.cfg['company_id'] or
            scope['seatId'] != collector.cfg['agent_id'] or
            collector.row()['task_id'] not in task_ids):
        return list(cli_args), {}
    if os.name not in ('posix', 'nt'):
        raise ValueError('Observer candidate requires a supported native filesystem')
    bundle = None
    if 'bundleRoot' in config:
        if any(arg=='--plugin-dir' or arg.startswith('--plugin-dir=') for arg in cli_args):
            raise ValueError('Bundle candidate requires an explicit plugin set')
        from harness_bundle import validate
        bundle = validate(config, (collector.info['cwd'], collector.info.get('source_cwd',collector.info['cwd'])))
        root=Path(bundle['runtimeRoot'])
        source_digest=bundle['sourceDigest'];resource_digest=bundle['resourceDigest']
        plugin_paths=[str(root),bundle['resourceRoot']]
    else:
        if set(config) != {'enabled', 'packageRoot', 'packageDigest', 'resourceDigest'}:
            raise ValueError('Invalid observer configuration')
        if any(not isinstance(config[k], str) or not re.fullmatch('[a-f0-9]{64}', config[k]) for k in ('packageDigest', 'resourceDigest')):
            raise ValueError('Invalid package lock')
        root = Path(config['packageRoot'])
        if package_digest(root) != config['packageDigest']:
            raise ValueError('Observer package changed')
        source_digest=config['packageDigest'];resource_digest=config['resourceDigest']
        plugin_paths=[str(root/'mods')]
    positions = [i for i, arg in enumerate(cli_args) if arg == '--session-id']
    if len(positions) != 1 or positions[0]+1 >= len(cli_args) or cli_args[positions[0]+1] != collector.run_id:
        raise ValueError('Launcher session mismatch')
    if any(arg == '--resume' or arg.startswith('--session-id=') or arg.startswith('--resume=') for arg in cli_args):
        raise ValueError('Observer requires a fresh bound session')
    row = collector.row()
    if row['collection_paused'] or row['finalized'] or collector.meta('harness_observer_runtime'):
        raise ValueError('Observer run already bound or paused')
    # Dedicated folder ends in runId as required by the Mod contract.
    folder = collector.folder.resolve() / 'harness-observer' / collector.run_id
    if folder.parent.exists() and folder.parent.resolve() != folder.parent:
        raise ValueError('Observer folder cannot use a symlink')
    binding = dict(schema='harness.v2.binding/1', runId=collector.run_id,
        companyId=collector.cfg['company_id'], taskId=row['task_id'],
        seatAgentId=collector.cfg['agent_id'], machineId=collector.cfg['seat']['machine_id'],
        nativeSessionId=collector.run_id, streamId=str(uuid.uuid4()),
        sourceDigest=source_digest, resourceDigest=resource_digest, runFolder=str(folder))
    for key in ('companyId', 'taskId', 'seatAgentId', 'machineId'):
        if str(uuid.UUID(binding[key])) != binding[key]:
            raise ValueError('Invalid registered identity')
    path = folder / 'harness-v2-binding.json'
    state=dict(binding=binding,packageRoot=str(root),packageDigest=source_digest)
    if bundle:
        runtime_context=dict(schema='harness.runtime-context/1',
            roots=dict(runtime_root=str(root),project_root=collector.info['cwd'],
                resource_roots=[bundle['resourceRoot']],
                user_config_root=str(Path(collector.info['config_path']).parent),
                state_root=str(Path(collector.info['state_path']).parent)),
            source_root=collector.info.get('source_cwd',collector.info['cwd']),
            state_path=collector.info['state_path'],
            identity=dict(companyId=binding['companyId'],seatId=binding['seatAgentId'],
                machineId=binding['machineId'],taskId=binding['taskId'],runId=binding['runId'],
                projectId=platform_attachment['projectId'] if platform_attachment else None),
            project=config['project'],bundleDigest=config['bundleDigest'])
        raw=(json.dumps(runtime_context,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode()
        context_digest=hashlib.sha256(raw).hexdigest()
        # The bundle was verified before this pinned parser is executed. Parsing
        # is read-only and happens before creating any run binding files.
        subprocess.run([sys.executable,'-I',str(root/'src/harness_context.py'),'--stdin',
            '--expected-digest',context_digest],input=raw,capture_output=True,timeout=5,check=True)
        state.update(runtimeContext=runtime_context,runtimeContextDigest=context_digest,
            runtimeContextPath=str(folder/'harness-runtime-context.json'))
    if platform_attachment is not None:state['platformAttachment']=platform_attachment
    if domain_context is not None:
        # Supplied only by the existing delivery launcher after its original
        # context/route/Jira checks. Never accept an Agent-provided event here.
        route=domain_context['executionRoute'];stage=domain_context['stage']
        expected={'companyId':binding['companyId'],'taskId':binding['taskId'],
                  'agentId':binding['seatAgentId'],'machineId':binding['machineId'],'runId':binding['runId']}
        if (not bundle or any(route.get(k)!=v for k,v in expected.items()) or
                domain_context['runId']!=binding['runId'] or stage['taskId']!=binding['taskId'] or
                domain_context['statePath']!=collector.info['state_path'] or
                domain_context['root']!=collector.info['cwd']):
            raise ValueError('Native domain launch scope mismatch')
        native=dict(root=domain_context['root'],statePath=domain_context['statePath'],
                    ticket=stage['jiraKey'],parent=stage.get('parentKey'),workflow=domain_context['workflow'])
        native_root=Path(native['root']);native_path=Path(native['statePath'])
        if (not native_root.is_absolute() or native_root.resolve()!=native_root or
                not native_path.is_absolute() or native_path.resolve()!=native_path or
                not native_path.is_relative_to(native_root) or native_path.name!='state.json' or
                not re.fullmatch(r'[A-Z][A-Z0-9]+-[1-9][0-9]*',native['ticket']) or
                native['workflow'] not in ('feature','bugfix','design-doc','code-review','design-review') or
                (native['parent'] is not None and not re.fullmatch(r'[A-Z][A-Z0-9]+-[1-9][0-9]*',native['parent']))):
            raise ValueError('Invalid native domain path or identity')
        if not (root/'src/native-state-query.py').is_file():
            raise ValueError('Pinned runtime lacks native state reader')
        state['nativeDomain']=native
    folder.parent.mkdir(mode=0o700, exist_ok=True)
    folder.mkdir(mode=0o700, exist_ok=False)
    with path.open('x') as output:
        os.chmod(path, 0o600)
        json.dump(binding, output)
    env={'HARNESS_V2_OBSERVER_BINDING':str(path)}
    if bundle:
        context_path=Path(state['runtimeContextPath'])
        with context_path.open('xb') as output:
            os.chmod(context_path,0o600);output.write(raw)
        env.update(HARNESS_CONTEXT_FILE=str(context_path),HARNESS_CONTEXT_DIGEST=context_digest)
    if bundle:
        state['bundleConfig']=dict(config)
        env.update(HARNESS_RUNTIME_ROOT=str(root),HARNESS_RESOURCE_ROOT=bundle['resourceRoot'],
            HARNESS_BUNDLE_ROOT=bundle['root'],HARNESS_BUNDLE_DIGEST=config['bundleDigest'])
    with collector.db:
        collector.setmeta('harness_observer_runtime',state)
    # Claude 2.1.325 accepts one path per repeatable --plugin-dir option.
    position = positions[0]
    plugin_args=[arg for path in plugin_paths for arg in ('--plugin-dir',path)]
    args = [*cli_args[:position], *plugin_args, *cli_args[position:]]
    return args, env


def assert_current_context(collector,state):
    context=state['runtimeContext'];roots=context['roots']
    expected=dict(companyId=collector.cfg['company_id'],seatId=collector.cfg['agent_id'],
        machineId=collector.cfg['seat']['machine_id'],taskId=collector.row()['task_id'],runId=collector.run_id,
        projectId=state.get('platformAttachment',{}).get('projectId'))
    if (context['identity']!=expected or roots['project_root']!=collector.info['cwd'] or
            context['source_root']!=collector.info.get('source_cwd',collector.info['cwd']) or
            context['state_path']!=collector.info['state_path'] or
            roots['state_root']!=str(Path(collector.info['state_path']).parent) or
            roots['user_config_root']!=str(Path(collector.info['config_path']).parent) or
            roots['runtime_root']!=state['packageRoot'] or context['bundleDigest']!=state['bundleConfig']['bundleDigest'] or
            context['project']!=state['bundleConfig']['project'] or
            state['runtimeContextPath']!=str(Path(state['binding']['runFolder'])/'harness-runtime-context.json') or
            hashlib.sha256((json.dumps(context,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode()).hexdigest()!=state['runtimeContextDigest'] or
            roots['resource_roots']!=[str(Path(state['bundleConfig']['bundleRoot'])/'resources')]):
        raise ValueError('Frozen runtime context no longer matches Collector')


def poll_native(collector):
    """Use the existing phase/observed protocol and transactional outbox.

    No new schema/capability, authority receipt, state mutation or scheduler.
    Native queries run only from verified bundles and frozen launch contexts.
    """
    state=collector.meta('harness_observer_runtime')
    if not state or not state.get('nativeDomain'):
        return 'disabled'
    if collector.row()['finalized']:
        return 'finalized'
    if collector.row()['collection_paused'] or collector.meta('harness_observer_suspended',False):
        with collector.db:collector.setmeta('harness_observer_suspended',True)
        return 'suspended'
    if collector.db.in_transaction:
        raise ValueError('Native observation requires its own transaction')
    try:
        # Serialize competing scans before sampling so a delayed old sample
        # cannot overwrite a newer cursor from another Collector process.
        collector.db.execute('BEGIN IMMEDIATE')
        row=collector.row()
        if row['collection_paused']:
            collector.setmeta('harness_observer_suspended',True)
            collector.db.commit();return 'suspended'
        if row['finalized'] or collector.meta('harness_observer_suspended',False):
            collector.db.rollback();return 'paused'
        binding=state['binding']
        expected={'runId':collector.run_id,'companyId':collector.cfg['company_id'],
                  'taskId':row['task_id'],'seatAgentId':collector.cfg['agent_id'],
                  'machineId':collector.cfg['seat']['machine_id']}
        if state.get('runtimeContext'):
            assert_current_context(collector,state)
        native=state['nativeDomain']
        if (any(binding.get(k)!=v for k,v in expected.items()) or
                native['root']!=collector.info['cwd'] or native['statePath']!=collector.info['state_path']):
            raise ValueError('Native observer current run scope changed')
        from harness_bundle import validate
        bundle=validate(state['bundleConfig'])
        if (bundle['sourceDigest']!=state['binding']['sourceDigest'] or
                bundle['resourceDigest']!=state['binding']['resourceDigest'] or
                bundle['runtimeRoot']!=state['packageRoot']):
            raise ValueError('Native observer bundle changed')
        args=[sys.executable,'-I',str(Path(bundle['runtimeRoot'])/'src/native-state-query.py'),
              '--root',native['root'],'--state',native['statePath'],
              '--ticket',native['ticket'],'--workflow',native['workflow']]
        if state.get('runtimeContext'):
            args+=['--context',state['runtimeContextPath'],'--context-digest',state['runtimeContextDigest']]
        if native['parent'] is not None:args+=['--parent',native['parent']]
        output=subprocess.run(args,capture_output=True,text=True,timeout=5,check=True)
        if len(output.stdout)>4096:raise ValueError('Native observation too large')
        value=json.loads(output.stdout)
        # The pinned reader owns projection validation; these checks prevent
        # accidental upgrades from observation into gate or delivery authority.
        if (value.get('schema')!='harness.native-state-observation/1' or
                value.get('ticket')!=native['ticket'] or value.get('workflow')!=native['workflow'] or
                any(value.get(k) is not False for k in ('identityConfirmed','gateConfirmed','reportingAcknowledged','platformAccepted')) or
                value.get('stateRevision') is not None or value.get('durationMinutes') is not None or
                not re.fullmatch('[a-f0-9]{64}',value.get('stateDigest',''))):
            raise ValueError('Invalid native observation claims')
        previous=collector.meta('harness-native-state')
        signature=[value['phase'],value['stateStatus']]
        if previous and previous['signature']==signature:
            collector.db.rollback();return 'duplicate'
        if value['phase'] is None:
            collector.setmeta('harness_native_status','phase-unavailable')
            collector.db.commit();return 'pending'
        collector.queued_bytes=collector.queue_size()
        # Metadata stays in the existing private run log. Status is always
        # observed, even when the native ledger says completed.
        collector.event('harness-native','phase',dict(phase=value['phase'],status='observed',
            source='Harness native state /1',evidence='sha256:'+value['stateDigest'],
            note='nativeStatus='+str(value['stateStatus'] or 'unknown')+
                 '; revision=unknown; identity/gate/reporting/run-causality not verified'),
            generation='harness.native-state/1')
        collector.setmeta('harness-native-state',dict(signature=signature,stateDigest=value['stateDigest']))
        collector.setmeta('harness_native_status','queued')
        collector.db.commit();return 'queued'
    except Exception:
        collector.db.rollback()
        with collector.db:collector.setmeta('harness_native_status','unavailable')
        return 'unavailable'
    finally:
        collector.queued_bytes=collector.queue_size()


def poll(collector):
    """Failure is metadata-only; never changes permits or legacy collection."""
    state = collector.meta('harness_observer_runtime')
    if not state or collector.row()['finalized']:
        return 'disabled'
    if collector.row()['collection_paused']:
        # Bounded snapshots cannot exclude the paused interval. Never backfill it.
        with collector.db: collector.setmeta('harness_observer_suspended', True)
        return 'paused'
    if collector.meta('harness_observer_suspended', False):
        return 'suspended'
    try:
        root = Path(state['packageRoot'])
        if state.get('bundleConfig'):
            from harness_bundle import validate
            bundle=validate(state['bundleConfig'])
            if state.get('runtimeContext'):
                assert_current_context(collector,state)
                subprocess.run([sys.executable,'-I',str(root/'src/harness_context.py'),
                    '--context',state['runtimeContextPath'],'--expected-digest',state['runtimeContextDigest']],
                    capture_output=True,timeout=5,check=True)
            if bundle['sourceDigest']!=state['binding']['sourceDigest'] or bundle['resourceDigest']!=state['binding']['resourceDigest']:
                raise ValueError('Bundle binding changed')
        elif package_digest(root) != state['packageDigest']:
            raise ValueError('Observer package changed')
        binding = state['binding']
        path = Path(binding['runFolder']) / 'harness-v2-binding.json'
        if path.resolve() != path or path.stat().st_size > 8192 or json.loads(path.read_text()) != binding:
            raise ValueError('Observer binding changed')
        snapshot = path.parent / 'harness-v2-observations.json'
        if not snapshot.exists():
            return 'pending'
        output = subprocess.run(['node', str(root / 'src/observation-query.mjs'), str(path), '--transport'],
            capture_output=True, text=True, timeout=5, check=True)
        if len(output.stdout) > 16384:
            raise ValueError('Observer summary too large')
        from harness_observation import enqueue_summary
        result = enqueue_summary(collector, json.loads(output.stdout))
        with collector.db: collector.setmeta('harness_observer_status', result)
        return result
    except Exception:
        with collector.db: collector.setmeta('harness_observer_status', 'unavailable')
        return 'unavailable'
