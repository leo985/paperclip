"""Load an operator-selected composition only through the original native route.
No package discovery, project copying, task authorization or new ledger occurs.
"""
import json
from pathlib import Path
import subprocess
import sys
from harness_bundle import validate
from pilot import BridgeError
from seats import seat_api

SKILLS = {'feature': 'jira-feature-dev', 'bugfix': 'jira-bug-fix', 'design-doc': 'jira-design-doc',
          'code-review': 'jira-code-review', 'design-review': 'jira-design-review'}
ROLES = {'jira-feature-dev': 'coding', 'jira-bug-fix': 'bug-fix', 'jira-design-doc': 'system-design',
         'jira-code-review': 'code-review', 'jira-design-review': 'design-review'}


def composition(b, route):
    value = route.get('composition')
    if route.get('protocolVersion') != 2 or not isinstance(value, dict) or set(value) != {
        'schema', 'selectionRevision', 'bundleRegistryRevision', 'bundle', 'nativeSkill', 'entryId'
    } or value.get('schema') != 'harness.execution-composition/1':
        raise BridgeError('正式组合协议无效，不允许回退原入口')
    if (type(value['selectionRevision']) is not int or value['selectionRevision'] < 1 or
            type(value['bundleRegistryRevision']) is not int or value['bundleRegistryRevision'] < 0 or
            value['nativeSkill'] not in ROLES or route['capability'].get('kind') != 'development' or
            ROLES[value['nativeSkill']] not in route['capability'].get('roles', [])):
        raise BridgeError('正式组合版本或领域方法不匹配')
    bundle = value['bundle']
    if not isinstance(bundle, dict) or not isinstance(bundle.get('bundleDigest'), str):
        raise BridgeError('正式组合缺少冻结摘要')
    registry = seat_api(b).request('GET', '/agents/' + b.cfg['agent_id'] + '/dsp7-harness-bundles')
    matches = [r for r in registry.get('items', []) if r.get('bundleDigest') == bundle['bundleDigest']]
    if registry.get('version') != 1 or registry.get('revision') != value['bundleRegistryRevision'] or len(matches) != 1:
        raise BridgeError('正式组合登记版本已变化')
    if any(matches[0].get(k) != v for k, v in bundle.items()):
        raise BridgeError('正式组合登记描述已变化')
    # Only an installed local receipt supplies filesystem roots; the platform
    # descriptor and task prompt cannot introduce arbitrary host directories.
    installed = b.cfg.get('harness_v2_execution', {})
    local = installed.get('versions', {}).get(bundle['bundleDigest']) if installed.get('enabled') is True else None
    if not isinstance(local, dict) or set(local) != {'bundleRoot', 'bundleDigest', 'project', 'enabled'}:
        raise BridgeError('本机未安装指定正式组合')
    if local['bundleDigest'] != bundle['bundleDigest'] or local['project'] != bundle.get('project'):
        raise BridgeError('本机正式组合安装回执不匹配')
    checked = validate(local, (route['capability']['root'],))
    descriptors = [dict(id=p['id'], version=p['version'], layer=p['layer'], skills=sorted(p['skills']),
        manifestDigest=checked['sourceDigest'] if p['layer'] == 'L3' else checked['resourceDigest'])
        for p in checked['catalog']['packages']]
    normalized = lambda rows: sorted([dict(r, skills=sorted(r['skills'])) for r in rows], key=lambda r: r['layer'])
    if normalized(descriptors) != normalized(bundle.get('packages', [])) or bundle.get('mode') != 'candidate' or bundle.get('protocolVersion') != 1:
        raise BridgeError('本机组合与平台冻结描述不匹配')
    result = subprocess.run([sys.executable, '-I', '-B', str(Path(checked['runtimeRoot'])/'tools/packages.py'),
        'methods', checked['root'], '--project', local['project'], '--expected-digest', bundle['bundleDigest'],
        '--skill', value['nativeSkill']], capture_output=True, timeout=10, check=True)
    method = json.loads(result.stdout)['methods']
    if len(method) != 1 or method[0]['entryId'] != value['entryId']:
        raise BridgeError('冻结原生方法与本机包索引不匹配')
    return checked, method[0]


def prepare_launch(b, route, run_id, task_id, *, project_root, source_root, state_path, folder, cli_args, workflow=None, observer_env=None):
    """Called after native route/Jira admission and before the managed spawn."""
    if route is None or route.get('protocolVersion') == 1:
        if route and route.get('composition') is not None:
            raise BridgeError('旧路由不得携带正式组合')
        return list(cli_args), {}, ''
    from harness_routing import resolve_route
    resolve_route(b, route, run_id, task_id, 'development')
    checked, method = composition(b, route)
    if workflow is not None and SKILLS.get(workflow) != route['composition']['nativeSkill']:
        raise BridgeError('正式方法与原生工作流不匹配')
    state = Path(state_path)
    if state.is_file():
        original = json.loads(state.read_bytes())
        if original.get('技能') != route['composition']['nativeSkill']:
            raise BridgeError('旧工单技能与正式组合不匹配，不能改写账本迁移')
    if state.parent.resolve() != state.parent:
        raise BridgeError('原生工单目录不能使用链接或别名')
    state.parent.mkdir(parents=True, exist_ok=True)
    plugins = []
    for i, arg in enumerate(cli_args):
        if arg.startswith('--plugin-dir='):
            raise BridgeError('正式组合不能叠加未知插件入口')
        if arg == '--plugin-dir':
            if i+1 >= len(cli_args):raise BridgeError('正式组合插件路径缺失')
            plugins.append(cli_args[i+1])
    if plugins and (plugins != [checked['runtimeRoot'], checked['resourceRoot']] or not observer_env):
        raise BridgeError('正式组合不能叠加未知插件入口')
    import runpy
    api = runpy.run_path(str(Path(checked['runtimeRoot'])/'src/harness_context.py'))
    context = dict(schema='harness.runtime-context/1', project=route['composition']['bundle']['project'],
        bundleDigest=route['composition']['bundle']['bundleDigest'],
        roots=dict(runtime_root=checked['runtimeRoot'], resource_roots=[checked['resourceRoot']],
            project_root=str(Path(project_root)), state_root=str(state.parent), user_config_root=str(b.config_path.parent)),
        source_root=str(Path(source_root)), state_path=str(state),
        identity=dict(companyId=b.cfg['company_id'], seatId=b.cfg['agent_id'], machineId=route['machineId'],
            taskId=task_id, runId=run_id, projectId=None))
    if observer_env:
        if (not plugins or observer_env.get('HARNESS_BUNDLE_DIGEST') != context['bundleDigest'] or
                observer_env.get('HARNESS_RUNTIME_ROOT') != checked['runtimeRoot'] or
                observer_env.get('HARNESS_RESOURCE_ROOT') != checked['resourceRoot']):
            raise BridgeError('观察附件与正式组合不匹配')
        path = Path(observer_env['HARNESS_CONTEXT_FILE'])
        observed = api['read_context'](path, observer_env['HARNESS_CONTEXT_DIGEST'])
        context['identity']['projectId'] = observed['identity']['projectId']
        api['validate_context'](observed, expected=context)
    else:
        api['validate_context'](context)
        path = Path(folder)/'harness-execution-context.json'
        raw = api['encoded'](context)
        with path.open('xb') as handle:
            handle.write(raw)
        path.chmod(0o600)
    env = dict(HARNESS_CORE_CONTEXT='1', HARNESS_CONTEXT_FILE=str(path), HARNESS_CONTEXT_DIGEST=api['context_digest'](context),
        HARNESS_RUNTIME_ROOT=checked['runtimeRoot'], HARNESS_RESOURCE_ROOT=checked['resourceRoot'],
        HARNESS_BUNDLE_ROOT=checked['root'], HARNESS_BUNDLE_DIGEST=context['bundleDigest'], HARNESS_SESSION_ID=run_id)
    args = list(cli_args) if plugins else [*cli_args, '--plugin-dir', checked['runtimeRoot'], '--plugin-dir', checked['resourceRoot']]
    instruction = ('\n平台原执行许可冻结了方法 '+method['invocation']+'。加载该方法并保留原生身份、计时、确认和交付门禁。'
        '已有工单使用同一原生账本及计时来源恢复，禁止复制账本或重置计时。核心机制通过已冻结环境中的 '
        '"$HARNESS_RUNTIME_ROOT/src/core-entry.py" 调用；路径或许可失效时停止，不回退旧方法。\n')
    return args, env, instruction
