"""Unified portal/admin lifecycle: temporary state, real TLS, fixture upstream only."""
import concurrent.futures
import hashlib
import http.client
import json
import socket
import ssl
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import LocalHttpsBridge as bridge
from test_portal_integration import FakeUpstream


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class RemoteConsole(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        p = patch.object(bridge, 'APP_DIR', self.temp.name)
        p.start(); self.addCleanup(p.stop)
        self.up = ThreadingHTTPServer(('127.0.0.1', 0), FakeUpstream)
        self.up.hits, self.up.active = [], 0
        self.up.lock = threading.Lock()
        self.up.two_active = threading.Event()
        self.up.release_abort = threading.Event()
        self.up.headers_waiting = threading.Event()
        threading.Thread(target=self.up.serve_forever, daemon=True).start()
        self.addCleanup(self.up.server_close)
        self.addCleanup(self.up.shutdown)
        self.app = bridge.WebUIApp()
        self.addCleanup(self.cleanup_app)
        self.config = dict(backend='http://127.0.0.1:%d/v1' % self.up.server_port,
                           backend_key='fixture-upstream-secret', external_key='lb_fixture_remote',
                           replace=True, port=free_port())
        self.assertTrue(self.app.api_start(self.config)['ok'])
        self.port = self.app.server.port
        self.context = ssl.create_default_context(cafile=self.app.server.cert_file)
        self.baseline = [(self.root/'certs'/f).read_bytes() for f in ('bridge_cert.pem', 'bridge_key.pem')]

    def cleanup_app(self):
        self.up.release_abort.set()
        self.app.stop()
        if self.app.usage:
            self.app.usage.close()

    def request(self, path, body=None, headers=None, method=None, portal=True, port=None):
        c = http.client.HTTPSConnection('127.0.0.1', port or self.port, context=self.context, timeout=10)
        h = {'Content-Type': 'application/json'}
        if portal:
            h['X-Bridge-Portal'] = '1'
        h.update(headers or {})
        try:
            c.request(method or ('POST' if body is not None else 'GET'), path,
                      json.dumps(body).encode() if body is not None else None, h)
            r = c.getresponse(); raw = r.read()
            try:
                data = json.loads(raw)
            except ValueError:
                data = raw
            return r.status, data, raw
        finally:
            c.close()

    def test_pages_and_remote_form_are_migrated_without_secrets(self):
        for path in ('/', '/portal/devices', '/portal/keys', '/portal/requests', '/console'):
            status, data, raw = self.request(path)
            self.assertEqual(status, 200, path)
            self.assertNotIn(self.app.token.encode(), raw)
            self.assertNotIn(self.config['backend_key'].encode(), raw)
        _, result, raw = self.request('/api/form')
        self.assertEqual(result['form']['backend_key'], '')
        self.assertTrue(result['form']['backend_key_configured'])
        self.assertNotIn(self.config['backend_key'].encode(), raw)
        self.assertIn(b'BRIDGE_REMOTE_ADMIN=true', self.request('/console')[2])
        self.app.log('fixture ' + self.config['backend_key'] + ' ' + self.app.token)
        self.assertNotIn(self.config['backend_key'].encode(), self.request('/api/logs')[2])
        self.assertNotIn(self.app.token.encode(), self.request('/api/logs')[2])

    def test_blank_remote_form_and_start_preserve_saved_upstream_key(self):
        payload = dict(self.config, backend_key='', preserve_backend_key=True)
        self.assertTrue(self.request('/api/form', payload)[1]['ok'])
        saved = json.loads((self.root/'config.json').read_text(encoding='utf-8'))
        self.assertEqual(saved['backend_key'], self.config['backend_key'])
        self.assertTrue(self.request('/api/start', payload)[1]['ok'])
        self.assertEqual(self.app.server.backend_key, self.config['backend_key'])
        payload['backend_key'] = 'fixture-replacement'
        self.request('/api/form', payload)
        self.assertEqual(self.app.api_form_load()['form']['backend_key'], 'fixture-replacement')

    def test_all_admin_routes_reject_cross_site_wrong_host_and_missing_header(self):
        for path in ('/api/state', '/api/logs', '/api/form', '/api/start', '/api/stop', '/api/test', '/api/cert', '/api/quit'):
            body = {} if path in ('/api/start', '/api/stop', '/api/test', '/api/cert', '/api/quit') else None
            self.assertEqual(self.request(path, body, portal=False)[0], 403, path)
            self.assertEqual(self.request(path, body, headers={'Origin':'https://other.invalid'})[0], 403)
            self.assertEqual(self.request(path, body, headers={'Host':'rebind.invalid:%d' % self.port})[0], 403)
        self.assertEqual(self.request('/console', headers={'Host':'other.invalid'})[0], 403)
        self.assertEqual(self.request('/api/state', headers={'Sec-Fetch-Site':'cross-site'})[0], 403)
        self.assertEqual(self.request('/api/form', [], method='POST')[0], 400)
        self.assertEqual(self.request('/api/state', method='DELETE')[0], 405)
        self.assertTrue(self.app.server.running)

    def test_pause_keeps_portal_and_remote_resume_uses_same_listener(self):
        listener = self.app.server.httpd
        self.assertTrue(self.request('/api/stop', {})[1]['ok'])
        self.assertIsNone(self.app.server)
        self.assertIs(self.app.portal_server.httpd, listener)
        self.assertFalse(self.request('/api/state')[1]['running'])
        self.assertEqual(self.request('/')[0], 200)
        before = len(self.up.hits)
        self.assertEqual(self.request('/v1/models')[0], 503)
        self.assertEqual(len(self.up.hits), before)
        payload = dict(self.config, backend_key='', preserve_backend_key=True)
        self.assertTrue(self.request('/api/start', payload)[1]['ok'])
        self.assertIs(self.app.server.httpd, listener)
        self.assertTrue(self.app.server.running)
        self.assertEqual(self.baseline, [(self.root/'certs'/f).read_bytes() for f in ('bridge_cert.pem','bridge_key.pem')])

    def test_pause_cancels_upstream_without_cancelling_admin_response(self):
        def stalled():
            try:
                return self.request('/v1/chat/completions', {'model':'stall-headers'},
                                    headers={'Authorization':'Bearer '+self.config['external_key']})
            except (OSError, http.client.HTTPException):
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(stalled)
            self.assertTrue(self.up.headers_waiting.wait(3))
            start = time.monotonic()
            self.assertTrue(self.request('/api/stop', {})[1]['ok'])
            self.assertLess(time.monotonic()-start, 2)
            pending.result(timeout=2)
        self.assertEqual(self.request('/console')[0], 200)
        self.assertFalse(self.app.portal_server.httpd._api_workers)

    def test_port_change_is_replied_before_deferred_restart(self):
        new_port = free_port()
        code, result, _ = self.request('/api/start', dict(self.config, port=new_port))
        self.assertEqual(code, 202)
        self.assertTrue(result['pending'])
        self.assertTrue(result['redirect_url'].endswith(':%d/console' % new_port))
        end = time.monotonic()+8
        while time.monotonic() < end:
            try:
                if self.request('/api/state', port=new_port)[1]['running']:
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(.05)
        else:
            self.fail('new HTTPS port did not become ready')
        self.assertEqual(self.app.server.port, new_port)

    def test_remote_test_preserves_key_and_certificate_does_not_install_server_trust(self):
        with patch.object(self.app, 'api_test', return_value={'ok':True}) as probe:
            result = self.request('/api/test', {'backend':self.config['backend'], 'key':'', 'preserve_backend_key':True})
            self.assertTrue(result[1]['ok'])
            self.assertEqual(probe.call_args.args[0]['key'], self.config['backend_key'])
        with patch.object(bridge, 'install_cert_windows') as install:
            self.assertEqual(self.request('/api/cert', {})[1]['download_url'], '/cert')
            install.assert_not_called()

    def test_remote_quit_returns_before_shutdown_and_preserves_intent(self):
        code, data, _ = self.request('/api/quit', {})
        self.assertEqual(code, 200)
        self.assertTrue(data['ok'])
        end = time.monotonic()+8
        while not self.app.closing and time.monotonic()<end:
            time.sleep(.05)
        with self.app.control_lock:
            self.assertTrue(self.app.closing)
            self.assertIsNone(self.app.portal_server)
        self.assertTrue(json.loads((self.root/'config.json').read_text())['_runtime']['running'])

    def test_stopped_bootstrap_keeps_intent_and_opens_portal_only(self):
        self.app.api_stop(); self.app.stop()
        before = (self.root/'config.json').read_bytes()
        self.app.bootstrap()
        self.assertTrue(self.app.portal_ready.is_set())
        self.assertIsNone(self.app.server)
        self.assertTrue(self.app.portal_server.listening)
        self.assertFalse(self.app.portal_server.running)
        self.assertEqual((self.root/'config.json').read_bytes(), before)
        self.assertEqual(self.request('/console')[0], 200)
        self.assertEqual(self.request('/v1/models')[0], 503)

    def test_exe_entry_prefers_https_without_token_and_local_fallback_is_available(self):
        local = ThreadingHTTPServer(('127.0.0.1',0), self.app.make_handler())
        threading.Thread(target=local.serve_forever, daemon=True).start()
        try:
            with patch.object(bridge.webbrowser, 'open') as opened:
                bridge._open_console(local.server_port, self.app.token, False)
                self.assertEqual(opened.call_args.args[0], self.app.public_url()+'/')
                self.assertNotIn(self.app.token, opened.call_args.args[0])
            self.app.stop(); self.app.portal_ready.set()
            with patch.object(bridge.webbrowser, 'open') as opened:
                bridge._open_console(local.server_port, self.app.token, False)
                self.assertTrue(opened.call_args.args[0].startswith('http://127.0.0.1:'))
                self.assertIn('?t=', opened.call_args.args[0])
            with patch.object(bridge.webbrowser, 'open') as opened:
                bridge._open_console(local.server_port, self.app.token, True)
                opened.assert_not_called()
        finally:
            local.shutdown(); local.server_close()

    def test_browser_favicon_is_not_forwarded_or_metered(self):
        before = self.app.usage.snapshot()['summary']
        hits = len(self.up.hits)
        self.assertEqual(self.request('/favicon.ico')[0], 204)
        self.assertEqual(self.request('/favicon.ico', method='HEAD')[0], 204)
        self.assertEqual(self.request('/favicon.ico', {})[0], 405)
        self.assertEqual(self.app.usage.snapshot()['summary'], before)
        self.assertEqual(len(self.up.hits), hits)

    def test_repeated_stop_is_idempotent_and_keeps_portal(self):
        listener = self.app.portal_server.httpd
        for _ in range(3):
            self.assertTrue(self.request('/api/stop', {})[1]['ok'])
        self.assertIs(self.app.portal_server.httpd, listener)
        self.assertEqual(self.request('/')[0], 200)
        self.assertEqual(self.request('/console')[0], 200)

    def test_failed_port_change_preserves_old_portal_and_running_intent(self):
        listener = self.app.portal_server.httpd
        with socket.socket() as occupied:
            occupied.bind(('0.0.0.0', 0)); occupied.listen(1)
            bad = dict(self.config, port=occupied.getsockname()[1])
            code, result, _ = self.request('/api/start', bad)
            self.assertEqual(code, 409)
            self.assertFalse(result['ok'])
            self.assertFalse(self.app.api_start(bad)['ok'])
        self.assertIs(self.app.portal_server.httpd, listener)
        self.assertTrue(self.request('/api/state')[1]['running'])
        self.assertEqual(self.request('/console')[0], 200)
        saved = json.loads((self.root/'config.json').read_text())
        self.assertEqual(saved['_runtime']['proxy']['port'], self.port)

    def test_stop_invalidates_deferred_start(self):
        new = dict(self.config, port=free_port())
        code, result, after_send = self.app.portal_api('POST', '/api/start', new)
        self.assertEqual(code, 202)
        self.assertTrue(callable(after_send))
        self.app.api_stop()
        after_send()
        self.assertIsNone(self.app.server)
        self.assertEqual(self.app.portal_server.port, self.port)
        self.assertFalse(json.loads((self.root/'config.json').read_text())['_runtime']['running'])
        self.assertEqual(self.request('/console')[0], 200)

    def test_slow_probe_does_not_block_management_polling_or_stop(self):
        started, release = threading.Event(), threading.Event()
        def probe(payload):
            started.set(); release.wait(5)
            return {'ok':True}
        with patch.object(self.app, 'api_test', side_effect=probe), concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.request, '/api/test', {'backend':self.config['backend']})
            try:
                self.assertTrue(started.wait(2))
                begin = time.monotonic()
                for route in ('/api/state', '/api/form', '/api/logs'):
                    self.assertEqual(self.request(route)[0], 200)
                self.assertTrue(self.request('/api/stop', {})[1]['ok'])
                self.assertLess(time.monotonic()-begin, 2)
            finally:
                release.set()
            self.assertTrue(pending.result(timeout=2)[1]['ok'])

    def test_whitespace_remote_key_preserves_saved_credential(self):
        payload = dict(self.config, backend_key='  \t ', preserve_backend_key=True)
        self.assertTrue(self.request('/api/form', payload)[1]['ok'])
        self.assertEqual(self.app.api_form_load()['form']['backend_key'], self.config['backend_key'])
        self.assertTrue(self.request('/api/start', payload)[1]['ok'])
        self.assertEqual(self.app.server.backend_key, self.config['backend_key'])


if __name__ == '__main__':
    unittest.main()
