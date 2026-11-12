"""Startup and durable proxy intent tests: temporary files, no real credentials/registry writes."""
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import LocalHttpsBridge as bridge


class FakeBridge:
    created = []
    def __init__(self, **kw):
        self.__dict__.update(kw)
        self.running = False
        self.cert_file = 'fixture.pem'
        self.created.append(self)
    def start(self):
        if self.port == 1:
            raise OSError('fixture port busy')
        self.running = True
    def stop(self):
        self.running = False
    def urls(self):
        return ['https://127.0.0.1:%d' % self.port]


class DurableState(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        p = patch.object(bridge, 'APP_DIR', self.temp.name)
        p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, 'BridgeServer', FakeBridge)
        p.start(); self.addCleanup(p.stop)
        FakeBridge.created = []
        self.addCleanup(lambda: [srv.store.close() for srv in FakeBridge.created if getattr(srv, 'store', None)])
        self.app = bridge.WebUIApp()
        self.active = dict(backend='http://127.0.0.1:19090/v1', backend_key='fixture-key',
                           external_key='lb_fixture', port=18443, replace=True)

    def config(self):
        return json.loads((self.root/'config.json').read_text(encoding='utf-8'))

    def test_successful_start_persists_intent_and_exact_active_config(self):
        self.assertTrue(self.app.api_start(self.active)['ok'])
        self.assertEqual(self.config()['_runtime'], {'running': True, 'proxy': self.active})

    def test_form_draft_does_not_overwrite_restore_snapshot(self):
        self.app.api_start(self.active)
        self.app.api_form_save(dict(self.active, backend='http://draft.invalid', port=9999))
        self.assertEqual(self.config()['_runtime']['proxy'], self.active)
        self.assertEqual(self.config()['port'], 9999)

    def test_relaunch_restores_active_config_not_draft_and_preserves_draft(self):
        self.app.api_start(self.active)
        self.app.api_form_save(dict(self.active, backend='http://draft.invalid', port=9999))
        self.app.stop()  # Simulate process cleanup, not an explicit Stop click.
        next_app = bridge.WebUIApp()
        next_app.restore_proxy()
        self.assertTrue(next_app.server.running)
        self.assertEqual(next_app.server.backend, self.active['backend'])
        self.assertEqual(next_app.server.port, self.active['port'])
        self.assertEqual(next_app.server.external_key, self.active['external_key'])
        self.assertEqual(next_app.api_form_load()['form']['port'], 9999)

    def test_explicit_stop_disarms_next_restore(self):
        self.app.api_start(self.active)
        self.assertTrue(self.app.api_stop()['ok'])
        next_app = bridge.WebUIApp()
        next_app.restore_proxy()
        self.assertIsNone(next_app.server)
        self.assertIs(self.config()['_runtime']['running'], False)

    def test_legacy_config_without_intent_does_not_start_unexpected_proxy(self):
        self.app.api_form_save(self.active)
        self.app.restore_proxy()
        self.assertIsNone(self.app.server)

    def test_failed_start_does_not_arm_resume(self):
        self.assertFalse(self.app.api_start(dict(self.active, port=1))['ok'])
        self.assertFalse(self.config().get('_runtime', {}).get('running', False)) if (self.root/'config.json').exists() else None

    def test_restore_failure_keeps_previous_intent_for_later_retry(self):
        self.app._update_config({'_runtime': {'running': True, 'proxy': dict(self.active, port=1)}})
        self.app.restore_proxy()
        self.assertIsNone(self.app.server)
        self.assertIs(self.config()['_runtime']['running'], True)

    def test_quit_stops_current_process_but_preserves_resume_intent(self):
        self.app.api_start(self.active)
        with patch.object(bridge.threading, 'Timer'):
            self.assertTrue(self.app.request_quit()['ok'])
        self.assertIsNone(self.app.server)
        self.assertTrue(self.config()['_runtime']['running'])
        self.app.restore_proxy()
        self.assertIsNone(self.app.server)  # A closing process cannot restart.

    def test_internal_runtime_not_returned_in_form(self):
        self.app.api_start(self.active)
        self.assertNotIn('_runtime', self.app.api_form_load()['form'])

    def test_unrelated_config_fields_are_preserved(self):
        self.app._update_config({'unrelated': {'keep': True}})
        self.app.api_form_save(self.active)
        self.app.api_start(self.active)
        self.assertEqual(self.config()['unrelated'], {'keep': True})

    def test_atomic_write_failure_preserves_original_file(self):
        self.app.api_form_save(self.active)
        before = (self.root/'config.json').read_bytes()
        with patch.object(bridge.os, 'replace', side_effect=OSError('fixture write failure')):
            self.assertFalse(self.app.api_form_save(dict(self.active, port=9999))['ok'])
        self.assertEqual((self.root/'config.json').read_bytes(), before)
        self.assertEqual(list(self.root.glob('.bridge-*.tmp')), [])

    def test_corrupt_config_is_not_silently_overwritten(self):
        (self.root/'config.json').write_text('{broken', encoding='utf-8')
        self.assertFalse(self.app.api_form_save(self.active)['ok'])
        self.assertEqual((self.root/'config.json').read_text(), '{broken')

    def test_process_lock_excludes_second_instance_and_releases(self):
        first = bridge._acquire_instance_lock()
        self.assertIsNotNone(first)
        try:
            second = bridge._acquire_instance_lock()
            if second is not None:
                second.close()
            self.assertIsNone(second)
        finally:
            first.close()
        third = bridge._acquire_instance_lock()
        self.assertIsNotNone(third)
        third.close()

    def test_cached_console_detection_bypasses_system_proxy(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), self.app.make_handler())
        threading.Thread(target=server.serve_forever, daemon=True).start()
        bridge._atomic_json_write(str(self.root/'console.json'), {'port': server.server_port})
        try:
            with patch.dict(os.environ, {'HTTP_PROXY': 'http://127.0.0.1:1'}), \
                 patch.object(bridge.urllib.request, 'urlopen', side_effect=AssertionError('must use direct HTTP')):
                self.assertEqual(bridge._detect_existing_console(8765, self.app.token), server.server_port)
        finally:
            server.shutdown(); server.server_close()


class AutostartRegistration(unittest.TestCase):
    def test_frozen_command_is_quoted_and_uses_silent_startup_flag(self):
        reg = types.SimpleNamespace(CreateKey=MagicMock(), SetValueEx=MagicMock(),
                                    DeleteValue=MagicMock(), HKEY_CURRENT_USER=1, REG_SZ=1)
        with patch.dict(sys.modules, {'winreg': reg}), \
             patch.object(sys, 'frozen', True, create=True), \
             patch.object(sys, 'executable', r'C:\Program Files\Bridge\LocalHttpsBridge.exe'):
            bridge.set_autostart(True)
        args = reg.SetValueEx.call_args.args
        self.assertEqual(args[1], 'LocalHttpsBridge')
        self.assertEqual(args[-1], '"C:\\Program Files\\Bridge\\LocalHttpsBridge.exe" --startup')
        self.assertNotIn('--backend-key', args[-1])

    def test_disable_only_removes_own_entry_and_is_idempotent(self):
        reg = types.SimpleNamespace(CreateKey=MagicMock(), SetValueEx=MagicMock(),
                                    DeleteValue=MagicMock(side_effect=FileNotFoundError),
                                    HKEY_CURRENT_USER=1, REG_SZ=1)
        with patch.dict(sys.modules, {'winreg': reg}):
            bridge.set_autostart(False)
        self.assertEqual(reg.DeleteValue.call_args.args[-1], 'LocalHttpsBridge')
        reg.SetValueEx.assert_not_called()


class StartupEdges(unittest.TestCase):
    def test_control_port_avoids_pending_https_port(self):
        cfg = {'_runtime': {'running': True, 'proxy': {'port': 8765}}}
        self.assertNotIn(8765, bridge._console_port_candidates(8765, cfg))
        self.assertEqual(bridge._console_port_candidates(8765, cfg)[0], 8766)

    def test_disabled_intent_does_not_reserve_port(self):
        cfg = {'_runtime': {'running': False, 'proxy': {'port': 8765}}}
        self.assertEqual(bridge._console_port_candidates(8765, cfg)[0], 8765)

    def test_control_port_candidates_do_not_exceed_65535(self):
        self.assertEqual(bridge._console_port_candidates(65535, {}), [65535])

    def test_startup_flag_forces_no_browser(self):
        with patch.object(sys, 'argv', ['bridge', '--startup']), patch.object(bridge, 'run_web') as run:
            bridge.main()
        self.assertTrue(run.call_args.args[0].no_browser)

    def test_optional_cache_write_failure_does_not_stop_server(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(bridge, 'APP_DIR', temp):
            app = bridge.WebUIApp()
            fake_http = MagicMock()
            with patch.object(bridge, 'WebUIApp', return_value=app), \
                 patch('http.server.ThreadingHTTPServer', return_value=fake_http), \
                 patch.object(bridge, '_atomic_json_write', side_effect=PermissionError('fixture read-only cache')):
                bridge.run_web(types.SimpleNamespace(web_port=8765, no_browser=True, startup=True))
            fake_http.serve_forever.assert_called_once()
            self.assertTrue(any('缓存写入失败' in line for line in app.logs))


if __name__ == '__main__':
    unittest.main()
