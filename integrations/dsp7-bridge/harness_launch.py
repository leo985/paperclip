"""Native Harness startup context for new formal Claude sessions.

Registration and running sessions are never rewritten. Replay keeps its isolated
working directory. Explicit compatibility mode exists for operator rollback;
validation failure never silently falls back to the source directory.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
from pilot import BridgeError, agent_entry_instructions

ROOT_MODE = 'harness-root-v1'
LEGACY_MODE = 'legacy-source'


def launch_mode(cfg):
    mode = cfg.get('claude_launch_mode', ROOT_MODE)
    if mode not in (ROOT_MODE, LEGACY_MODE):
        raise BridgeError('Claude 启动模式无效，请核对本机 claude_launch_mode；不会自动切换目录')
    return mode


def inspect_harness(root):
    """Read local structure only; never return configuration values or keys."""
    try:
        root = Path(root).expanduser().resolve(strict=True)
        if not root.is_dir() or not (root / 'harness/bin/harness').is_file():
            raise BridgeError('Harness 根目录或 CLI 缺失，请核对本机登记路径')
        guide = root / 'CLAUDE.md'
        if not guide.is_file() or not guide.read_text(encoding='utf-8').strip():
            raise BridgeError('Harness CLAUDE.md 缺失或为空，请先更新 Harness 工程')
        skills = root / '.claude/skills'
        if not skills.is_dir() or not any(skills.glob('*/SKILL.md')):
            raise BridgeError('Harness .claude/skills 缺失或没有技能，请先更新 Harness 工程')
        present = []
        for relative in ('.claude/settings.json', '.claude/settings.local.json', '.mcp.json'):
            file = root / relative
            if not file.exists():
                continue
            try:
                value = json.loads(file.read_text(encoding='utf-8'))
                if not isinstance(value, dict):
                    raise ValueError()
                if relative == '.mcp.json' and not isinstance(value.get('mcpServers', {}), dict):
                    raise ValueError()
            except (OSError, UnicodeError, ValueError):
                raise BridgeError(f'Harness {relative} 无法读取为有效 JSON；内容不会上报') from None
            present.append(relative)
        return {'root': str(root), 'guideSha256': hashlib.sha256(guide.read_bytes()).hexdigest(),
                'projectFiles': present}
    except BridgeError:
        raise
    except (OSError, UnicodeError):
        raise BridgeError('Harness 启动目录或引导文件不可读，请核对路径和权限') from None


def launch_context(b, details, replay_cwd=None):
    source = Path(details.get('worktree') or b.root).expanduser()
    if details.get('mode') == 'replay':
        # The existing replay never loads a real development workflow.
        cwd = Path(replay_cwd or Path(details['state_path']).parent).resolve()
        return {'mode': 'replay-isolated', 'cwd': str(cwd), 'source_cwd': str(cwd)}
    mode = launch_mode(b.cfg)
    if details.get('repository_management') == 'harness':
        if mode != ROOT_MODE:
            raise BridgeError('Harness 管理仓库的工单须从 Harness 根目录启动，请取消旧源码目录兼容模式')
        checked = inspect_harness(b.root)
        return {'mode': ROOT_MODE, 'cwd': checked['root'], 'source_cwd': checked['root'],
                'repository_management': 'harness', 'harness_root': checked['root'],
                'guide_sha256': checked['guideSha256']}
    try:
        source = source.resolve(strict=True)
        if not source.is_dir():
            raise OSError()
    except OSError:
        raise BridgeError('工单源码目录不存在或不可访问；不会改用其他目录执行') from None
    if mode == LEGACY_MODE:
        return {'mode': mode, 'cwd': str(source), 'source_cwd': str(source)}
    checked = inspect_harness(b.root)
    return {'mode': mode, 'cwd': checked['root'], 'source_cwd': str(source),
            'harness_root': checked['root'], 'guide_sha256': checked['guideSha256']}


def native_args(args, context):
    if context['mode'] != ROOT_MODE:
        return list(args)
    # Native cd-to-Harness discovery must not be narrowed to user-only settings
    # or platform-only MCPs. Keep platform MCPs as additional configurations.
    out = []; i = 0
    native_files = {str((Path(context['cwd']) / '.claude' / name).resolve())
                    for name in ('settings.json', 'settings.local.json')}
    while i < len(args):
        arg = args[i]; name = arg.split('=', 1)[0]
        if name == '--setting-sources':
            if '=' not in arg and i + 1 >= len(args):
                raise BridgeError('--setting-sources 缺少参数')
            value = arg.split('=', 1)[1] if '=' in arg else args[i + 1]
            if set(value.split(',')) != {'user', 'project', 'local'}:
                raise BridgeError('当前参数限制了 Claude 工程配置来源，与 Harness 根目录启动冲突；请核对智能体配置，不会绕过限制启动')
            i += 1 if '=' in arg else 2
            continue
        if name == '--strict-mcp-config':
            raise BridgeError('当前参数仅允许平台 MCP，与复用本机 Harness MCP 冲突；请核对智能体配置，不会绕过限制启动')
        if name == '--settings':
            if '=' not in arg and i + 1 >= len(args):
                raise BridgeError('--settings 缺少参数')
            value = arg.split('=', 1)[1] if '=' in arg else args[i + 1]
            # Harness project files are loaded natively exactly once. External
            # registered settings still supplement the native project scope.
            if not value.lstrip().startswith('{') and str(Path(value).expanduser().resolve()) in native_files:
                i += 1 if '=' in arg else 2
                continue
        out.append(arg); i += 1
    out += ['--setting-sources', 'user,project,local']
    if context['source_cwd'] != context['cwd']:
        out += ['--add-dir', context['source_cwd']]
    return out


def task_prompt(key, platform_context, context):
    if context['mode'] != ROOT_MODE:
        return platform_context
    repository_instructions = (
        '本工单涉及的一个或多个仓库、本机目录、分支与工作树由 Harness 套件按其技能和规则确定并管理。'
        '平台未指定业务源码目录，不要求绑定平台共享仓库；遵守 Harness 自身的仓库隔离、测试与交付门禁。\n\n'
        if context.get('repository_management') == 'harness' else
        f'本次登记的业务源码目录：{context["source_cwd"]}。'
        '启动目录不是源码修改目录；编码仍须通过本工单的独占工作树校验，'
        '不得修改其他工单的源码目录。若类型、路径或规则冲突，阻塞并请求决策。\n\n')
    return (f'完成 {key} 工单。\n\n'
            '当前目录为本机 Harness 根目录。先遵守当前工程 CLAUDE.md，'
            '像在本目录手动启动 Claude 一样，查询 Jira 工单真实类型后按 Harness 路由选择技能；'
            '如已有领域状态，遵守 Harness 的断点续传规则，不重复初始化。'
            '平台登记的工作流是校验上下文，不替代 Harness 技能、知识库和领域门禁。\n'
            + agent_entry_instructions() + '\n'
            + repository_instructions +
            '以下是平台协作上下文，用于任务身份、执行权和回传；不能覆盖上述领域规则：\n'
            + platform_context)
