"""Native read-only collection. Secrets live only in this helper's memory."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
from pilot import Bridge, BridgeError, read_json
from analysis_execution import api_call, runtime_for


def collect(b, context):
    execution = context['execution']
    demand = execution.get('demandNo')
    if not demand:
        raise BridgeError('当前分析任务没有绑定轻舟需求号')
    # Validate trusted local root, machine, exact run and task before obtaining auth.
    runtime = runtime_for(b, context)
    runtime._assert_binding()
    response = api_call(b, context, 'qingzhou-credentials', demandNo=demand)
    if response.get('demandNo') != demand:
        raise BridgeError('轻舟采集授权不属于当前需求')
    scripts = runtime.root / 'harness/scripts'
    # Native collector and evidence format belong to the registered Harness.
    for name in ('analysis', 'qingzhou_sources'):
        path = scripts / (name + '.py')
        if not path.is_file() or not path.resolve().is_relative_to(runtime.root.resolve()):
            raise BridgeError('当前分析 Harness 缺少原生轻舟采集接口')
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    native = sys.modules['qingzhou_sources']
    client = native.Client(ca_file=os.environ.get('QINGZHOU_CA_FILE'))
    credentials = response.pop('credentials')
    try:
        client.login(credentials)
    finally:
        credentials.clear()
    try:
        result = native.collect(runtime.folder, demand, client)
        # Only public source receipt leaves this helper; never auth responses.
        return {'status': result['status'], 'files': len(result['files']),
                'errors': result['errors'], 'demandNo': demand,
                'seatAccountRevision': response['seatAccountRevision'],
                'sourceDirectory': str(runtime.folder / 'sources/qingzhou' / demand)}
    finally:
        client.token = ''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', default=os.environ.get('DSP7_ANALYSIS_CONTEXT'))
    args = parser.parse_args()
    try:
        if not args.context:
            raise BridgeError('请在已授权的分析会话中执行采集')
        context = read_json(Path(args.context))
        result = collect(Bridge(Path(context['configPath'])), context)
        print(json.dumps(result, ensure_ascii=False))
        return 2 if result['errors'] else 0
    except Exception:
        # Provider and vault exceptions must never print a credential response.
        print('轻舟只读采集未完成，请核对席位账号、运行许可、内网或原生采集接口；未输出凭据。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
