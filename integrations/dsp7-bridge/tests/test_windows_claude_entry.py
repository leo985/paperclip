"""Resolve both native and JS npm Claude versions without invoking cmd.exe."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_support as platform


class WindowsClaudeEntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='claude npm ')
        self.addCleanup(self.temp.cleanup)
        self.prefix = Path(self.temp.name).resolve()
        self.shim = self.prefix / 'claude.CMD'
        self.shim.write_text('@echo off\n')
        self.package = self.prefix / 'node_modules/@anthropic-ai/claude-code'
        self.package.mkdir(parents=True)
        windows = patch.object(platform, 'WINDOWS', True)
        windows.start()
        self.addCleanup(windows.stop)

    def metadata(self, target, version='2.1.251'):
        (self.package / 'package.json').write_text(json.dumps({
            'name': '@anthropic-ai/claude-code', 'version': version, 'bin': {'claude': target},
        }))
        entry = self.package / target
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text('fixture')
        return entry.resolve()

    def test_current_native_npm_package_uses_declared_exe_without_node(self):
        entry = self.metadata('bin/claude.exe')
        args = ['--version']
        with patch.object(platform, '_windows_node', side_effect=AssertionError('Native CLI must not require Node')):
            self.assertEqual(platform.claude_argv(self.shim, args), [str(entry), *args])

    def test_legacy_cli_js_and_sibling_node(self):
        entry = self.metadata('cli.js', '1.0.0')
        node = self.prefix / 'node.exe'
        node.touch()
        self.assertEqual(platform.claude_argv(self.shim, ['--version']), [str(node), str(entry), '--version'])

    def test_metadata_string_bin_and_nonstandard_js_location(self):
        entry = self.metadata('dist/start.cjs')
        data = json.loads((self.package / 'package.json').read_text())
        data['bin'] = 'dist/start.cjs'
        (self.package / 'package.json').write_text(json.dumps(data))
        node = self.prefix / 'node.exe'
        node.touch()
        self.assertEqual(platform.claude_argv(self.shim), [str(node), str(entry)])

    def test_node_standard_install_is_found_with_stale_path(self):
        entry = self.metadata('cli.js')
        node = self.prefix / 'program files/nodejs/node.exe'
        node.parent.mkdir(parents=True)
        node.touch()
        with patch.dict(os.environ, {'ProgramFiles': str(node.parents[1])}, clear=True), patch.object(platform.shutil, 'which', return_value=None):
            self.assertEqual(platform.claude_argv(self.shim), [str(node), str(entry)])

    def test_missing_node_reports_node_rather_than_missing_claude(self):
        self.metadata('cli.js')
        with patch.dict(os.environ, {}, clear=True), patch.object(platform.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'Node.js'):
                platform.claude_argv(self.shim)

    def test_missing_entry_has_actionable_diagnostic(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'npm root -g'):
                platform.claude_argv(self.shim)

    def test_metadata_cannot_escape_package_directory(self):
        (self.prefix / 'foreign.exe').touch()
        (self.package / 'package.json').write_text(json.dumps({
            'name': '@anthropic-ai/claude-code', 'bin': {'claude': '../../../foreign.exe'},
        }))
        with self.assertRaisesRegex(RuntimeError, '超出安装包目录'):
            platform.claude_argv(self.shim)

    def test_native_registration_path_is_preserved(self):
        exe = str(self.prefix / 'standalone claude.exe')
        self.assertEqual(platform.claude_argv(exe, ['hello']), [exe, 'hello'])

    def test_non_windows_entry_is_unchanged(self):
        with patch.object(platform, 'WINDOWS', False):
            self.assertEqual(platform.claude_argv('/bin/claude', ['hello']), ['/bin/claude', 'hello'])

    def test_real_node_process_preserves_prompt_text_without_shell(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node is not installed')
        entry = self.metadata('cli.js')
        entry.write_text('console.log(JSON.stringify(process.argv.slice(2)));')
        prompt = 'hello "quoted" & echo unsafe\n$(touch unexpected) %PATH% 中文'
        with patch.object(platform, '_windows_node', return_value=node):
            args = platform.claude_argv(self.shim, [prompt])
        result = subprocess.run(args, cwd=self.prefix, capture_output=True, text=True, encoding='utf-8', check=True)
        self.assertEqual(json.loads(result.stdout), [prompt])
        self.assertFalse((self.prefix / 'unexpected').exists())


if __name__ == '__main__':
    unittest.main()
