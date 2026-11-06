"""Enrollment diagnostics distinguish HTTP rejection from transport failures."""
import io
from pathlib import Path
import socket
import ssl
import sys
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import quick_install


class InstallerNetworkErrorsTests(unittest.TestCase):
    def test_invalid_or_expired_invitation_has_actionable_message(self):
        for status in (403,410):
            with self.subTest(status=status):
                error = urllib.error.HTTPError(
                    'http://seat.test/api/dsp7-quick-enroll/inspect?token=secret',
                    status, 'secret reason', {}, io.BytesIO(b'secret body'))
                with self.assertRaises(RuntimeError) as raised:
                    with quick_install.setup_step('检查接入码 /api/dsp7-quick-enroll/inspect'):
                        raise error
                message = quick_install.installation_error(raised.exception)
                self.assertIn('接入码无效或已过期', message)
                self.assertIn('重新生成接入命令', message)
                self.assertIn('15 分钟', message)
                self.assertIn('HTTP '+str(status), message)
                self.assertIn('已有配置和席位保留', message)
                self.assertNotIn('网络', message)
                self.assertNotIn('secret', message)

    def test_other_forbidden_endpoints_do_not_claim_expired_invitation(self):
        for path in ('/dsp7-bridge.zip', '/api/agents/seat',
                     '/api/dsp7-quick-enroll/inspect-other'):
            with self.subTest(path=path):
                error = urllib.error.HTTPError('http://seat.test'+path,403,'',{},None)
                message = quick_install.installation_error(error)
                self.assertIn('HTTP 403', message)
                self.assertNotIn('接入码无效或已过期', message)

    def test_http_status_is_not_reported_as_connectivity_failure(self):
        error = urllib.error.HTTPError('http://seat.test/private?token=secret', 403,
                                       'secret reason', {}, io.BytesIO(b'secret body'))
        message = quick_install.installation_error(error)
        self.assertIn('HTTP 403', message)
        self.assertNotIn('网络连接失败', message)
        self.assertNotIn('secret', message)

    def test_transport_categories_and_proxy_credentials_are_safe(self):
        reasons = [
            (socket.gaierror(-2, 'secret'), '地址解析失败'),
            (ConnectionRefusedError(111, 'secret'), '连接被拒绝'),
            (TimeoutError('secret'), '超时'),
            (ssl.SSLCertVerificationError(1, 'secret'), '证书校验失败'),
            (ConnectionResetError(104, 'secret'), '连接被重置'),
            ('secret proxy response', '网络连接失败'),
        ]
        with patch.object(quick_install.urllib.request, 'getproxies',
                          return_value={'http': 'http://user:secret@proxy.test'}):
            for reason, expected in reasons:
                with self.subTest(reason=type(reason).__name__):
                    message = quick_install.installation_error(urllib.error.URLError(reason))
                    self.assertIn(expected, message)
                    self.assertIn('代理绕过规则', message)
                    self.assertNotIn('secret', message)
                    self.assertNotIn('proxy.test', message)

    def test_no_proxy_does_not_claim_proxy_configuration(self):
        with patch.object(quick_install.urllib.request, 'getproxies', return_value={}):
            message = quick_install.installation_error(TimeoutError())
        self.assertIn('超时', message)
        self.assertNotIn('检测到', message)

    def test_download_failure_identifies_file_without_exposing_query(self):
        with patch.object(quick_install.urllib.request, 'urlopen',
                          side_effect=urllib.error.URLError(TimeoutError('secret'))), \
             patch.object(quick_install.urllib.request, 'getproxies', return_value={}):
            with self.assertRaises(RuntimeError) as raised:
                quick_install.download('http://seat.test/dsp7-bridge.zip?token=secret', 1024)
        message = quick_install.installation_error(raised.exception)
        self.assertIn('/dsp7-bridge.zip', message)
        self.assertIn('超时', message)
        self.assertNotIn('secret', message)

    def test_inspect_failure_keeps_http_status_and_stage(self):
        error = urllib.error.HTTPError('http://seat.test', 410, 'secret', {}, None)
        with self.assertRaises(RuntimeError) as raised:
            with quick_install.setup_step('检查接入码 /api/dsp7-quick-enroll/inspect'):
                raise error
        message = quick_install.installation_error(raised.exception)
        self.assertIn('/api/dsp7-quick-enroll/inspect', message)
        self.assertIn('HTTP 410', message)
        self.assertNotIn('secret', message)


if __name__ == '__main__':
    unittest.main()
