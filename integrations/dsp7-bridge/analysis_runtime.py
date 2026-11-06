"""Native analysis lifecycle adapter. No Jira identity or business authorization
is fabricated here; preparation never starts Claude or advances native gates.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid
from harness_capabilities import inspect
from pilot import BridgeError, atomic_json

PHASES = ['P0', 'P1', 'P2', 'P3', 'P4']
ARTIFACTS = ['intake.md', 'evidence.json', 'requirements.json', 'analysis.md', 'review.json', 'handoff.md', 'state.json']


class AnalysisRuntime:
    def __init__(self, capability, tasks_root, company_id, task_id, revision):
        for value in (company_id, task_id):
            try:
                if str(uuid.UUID(value)) != value: raise ValueError()
            except (ValueError, TypeError, AttributeError):
                raise BridgeError('分析任务平台身份无效')
        if type(revision) is not int or revision < 1:
            raise BridgeError('分析任务修订无效')
        if capability.get('kind') != 'analysis' or 'requirements-analysis' not in capability.get('roles', []):
            raise BridgeError('该能力不是需求分析 Harness')
        current = inspect(capability['root'], 'analysis', capability['profile'])
        if any(current[key] != capability.get(key) for key in current):
            raise BridgeError('分析 Harness 文件或版本已变化，请重新登记能力')
        self.root = Path(current['root'])
        self.tasks_root = Path(tasks_root).expanduser().resolve()
        self.native_id = 'pc-' + task_id + '-r' + str(revision)
        self.folder = self.tasks_root / ('analysis-' + self.native_id)
        self.binding = {'protocolVersion': 1, 'companyId': company_id, 'taskId': task_id,
                        'revision': revision, 'nativeId': self.native_id, 'profile': current['profile'],
                        'repository': current['repository']}
        self.profile = current['profile']
        self.binding_file = self.tasks_root / '.platform-bindings' / (self.native_id + '.json')

    def _call(self, command, *args):
        try:
            result = subprocess.run([sys.executable, str(self.root / 'harness/scripts/analysis.py'),
                                     '--tasks-root', str(self.tasks_root), command, *args],
                                    cwd=self.root, capture_output=True, text=True, timeout=30)
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise BridgeError('分析 Harness 原生接口不可用') from exc
        if result.returncode:
            # Domain stderr may contain local input. Keep it local, not in a
            # server-bound receipt, and do not treat an unavailable task as done.
            raise BridgeError('分析 Harness ' + command + ' 失败，请检查本机原生状态')
        if len(result.stdout) > 1024 * 1024:
            raise BridgeError('分析 Harness 响应超过大小限制')
        return result.stdout.strip()

    def _assert_binding(self):
        if self.folder.is_symlink() or not self.folder.is_dir() or self.folder.resolve().parent != self.tasks_root:
            raise BridgeError('分析任务目录不存在或越界')
        if not self.binding_file.is_file() or self.binding_file.is_symlink() or self.binding_file.parent.is_symlink():
            raise BridgeError('已有分析任务缺少可信平台绑定，不能覆盖或自动接管')
        if json.loads(self.binding_file.read_text(encoding='utf-8')) != self.binding:
            raise BridgeError('分析任务绑定属于其他组织、任务或修订')
        for name in ARTIFACTS:
            path = self.folder / name
            if not path.is_file() or path.is_symlink():
                raise BridgeError('分析产物缺失或越界：' + name)

    def prepare(self, title):
        if not isinstance(title, str) or not title.strip() or len(title) > 300:
            raise BridgeError('分析任务标题无效')
        if self.binding_file.parent.is_symlink() or self.binding_file.is_symlink():
            raise BridgeError('分析平台绑定目录越界')
        existed = self.folder.exists() or self.folder.is_symlink()
        if not existed and self.binding_file.exists():
            raise BridgeError('已有平台绑定但分析目录丢失，请核实后恢复，不能重新初始化')
        if not existed:
            self._call('init', self.native_id, '--title', title, '--profile', self.profile)
            self.binding_file.parent.mkdir(parents=True, exist_ok=True)
            if self.binding_file.parent.is_symlink():
                raise BridgeError('分析平台绑定目录越界')
            atomic_json(self.binding_file, self.binding)
        self._assert_binding()
        snapshot = self.status()
        return {'binding': self.binding, 'cwd': str(self.root), 'taskDirectory': str(self.folder),
                'skill': 'analysis-resume' if existed else ('dsp-requirements-analysis' if self.profile == 'dsp' else 'requirements-analysis'),
                'snapshot': snapshot, 'executionGranted': False}

    def status(self):
        self._assert_binding()
        try:
            response = json.loads(self._call('status', self.native_id))
            state, errors = response['state'], response['gate_errors']
            phase = state['phase']
            if (state['schema_version'] != 1 or state['id'] != self.native_id or state['profile'] != self.profile
                    or phase not in PHASES or state['status'] not in ('in-progress', 'completed')
                    or type(errors) is not list or any(type(e) is not str for e in errors)):
                raise ValueError()
            expected = PHASES if state['status'] == 'completed' else PHASES[:PHASES.index(phase)]
            if state['completed_phases'] != expected or state['status'] == 'completed' and phase != 'P4':
                raise ValueError()
        except (ValueError, KeyError, TypeError) as exc:
            raise BridgeError('分析 Harness 原生状态合同不匹配') from exc
        return {'protocolVersion': 1, 'binding': self.binding, 'phase': phase,
                'nativeStatus': state['status'], 'completedPhases': state['completed_phases'],
                'gateErrors': errors, 'localCompleted': state['status'] == 'completed' and not errors,
                'formalPublication': 'unverified'}

    def delivery(self):
        snapshot = self.status()
        if not snapshot['localCompleted']:
            raise BridgeError('分析原生阶段或门禁未通过，不能登记本地交付')
        fingerprint = self._call('fingerprint', self.native_id)
        if not re.fullmatch(r'[a-f0-9]{64}', fingerprint):
            raise BridgeError('分析输入指纹无效')
        artifacts = [{'path': name, 'sha256': hashlib.sha256((self.folder / name).read_bytes()).hexdigest()}
                     for name in ARTIFACTS]
        # Revalidate after reading the manifest: an edit during collection must
        # not turn an obsolete approval into a delivery receipt.
        after = self.status()
        if (not after['localCompleted'] or self._call('fingerprint', self.native_id) != fingerprint
                or any(hashlib.sha256((self.folder / item['path']).read_bytes()).hexdigest() != item['sha256'] for item in artifacts)):
            raise BridgeError('分析交付采集时材料已变化，请重新核验')
        # Native input fingerprint excludes the handoff; index it independently.
        return {**snapshot, 'inputDigest': fingerprint, 'artifacts': artifacts,
                'handoffDigest': next(item['sha256'] for item in artifacts if item['path'] == 'handoff.md')}
