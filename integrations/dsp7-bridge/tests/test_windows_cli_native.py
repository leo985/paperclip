"""Opt-in Windows VM integration: native CMD AutoRun must not break enrollment.

Run serially in an isolated Windows VM with PAPERCLIP_WINDOWS_CLI_NATIVE_TEST=1.
The test restores user PATH and CMD AutoRun in finally; no seat/network is used.
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import quick_install
import platform_support


@unittest.skipUnless(sys.platform == 'win32' and os.environ.get('PAPERCLIP_WINDOWS_CLI_NATIVE_TEST') == '1',
                     'requires explicit opt-in on an isolated Windows VM')
class NativeWindowsCliTests(unittest.TestCase):
    def test_cmd_autorun_banner_is_excluded_but_probe_failure_is_rejected(self):
        import winreg
        with tempfile.TemporaryDirectory(prefix='seat-native-') as temporary:
            home=Path(temporary)/'光贝 路径%测试&目录'
            bridge=home/'接入 桥';bridge.mkdir(parents=True)
            script=bridge/'harness_entry.py'
            script.write_bytes(Path(quick_install.__file__).with_name('harness_entry.py').read_bytes())
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER,'Environment') as envkey, \
                 winreg.CreateKey(winreg.HKEY_CURRENT_USER,r'Software\Microsoft\Command Processor') as cmdkey:
                def snapshot(key,name):
                    try:return winreg.QueryValueEx(key,name)
                    except FileNotFoundError:return None
                def restore(key,name,saved):
                    if saved is not None:winreg.SetValueEx(key,name,0,saved[1],saved[0])
                    else:
                        try:winreg.DeleteValue(key,name)
                        except FileNotFoundError:pass
                original_path=snapshot(envkey,'Path');original_auto=snapshot(cmdkey,'AutoRun')
                try:
                    winreg.SetValueEx(cmdkey,'AutoRun',0,winreg.REG_SZ,'@chcp 65001')
                    with patch.object(Path,'home',return_value=home),patch.dict(os.environ,LOCALAPPDATA=str(home/'AppData/Local')):
                        os.environ.pop('DSP7_BRIDGE_CONFIG',None)
                        quick_install.install_cli(home,bridge)
                        entry=home/'AppData/Local/ZhiyanSeat/bin/harness.cmd'
                        # The implicit invocation reproduces the customer's two
                        # lines; install_cli must verify through cmd /d instead.
                        output=platform_support.powershell('& $env:TEST_ENTRY --verify-seat-launcher;exit $LASTEXITCODE',
                            env={**os.environ,'TEST_ENTRY':str(entry)}).stdout.splitlines()
                        self.assertEqual(len(output),2)
                        self.assertEqual(output[-1],'PAPERCLIP_SEAT_LAUNCHER_OK')
                        self.assertEqual(snapshot(cmdkey,'AutoRun'),('@chcp 65001',winreg.REG_SZ))
                        script.write_text("print('PAPERCLIP_SEAT_LAUNCHER_OK')\nraise SystemExit(1)\n",encoding='utf-8')
                        with self.assertRaisesRegex(RuntimeError,'EXECUTION'):
                            quick_install.install_cli(home,bridge)
                        script.write_text("print('unrelated output')\n",encoding='utf-8')
                        with self.assertRaisesRegex(RuntimeError,'EXECUTION'):
                            quick_install.install_cli(home,bridge)
                finally:
                    restore(envkey,'Path',original_path);restore(cmdkey,'AutoRun',original_auto)


if __name__ == '__main__':
    unittest.main()
