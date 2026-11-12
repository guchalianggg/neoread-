"""HTTPS / streaming compatibility regressions. No user config or keys are read.
Run: python -B -m unittest discover -s LocalHttpsBridge/tests -v
"""
import http.client
import ssl
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import LocalHttpsBridge as bridge


class Certificates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ips = patch.object(bridge, 'local_ipv4s', return_value=['127.0.0.1'])
        self.ips.start()
        self.addCleanup(self.ips.stop)

    def test_repeated_start_preserves_certificate_and_key(self):
        cert, key, _ = bridge.ensure_certificate(self.temp.name)
        before = Path(cert).read_bytes(), Path(key).read_bytes()
        bridge.ensure_certificate(self.temp.name)
        self.assertEqual(before, (Path(cert).read_bytes(), Path(key).read_bytes()))

    def test_previously_trusted_certificate_still_valid_after_restart(self):
        cert, _, _ = bridge.ensure_certificate(self.temp.name)
        trusted = ssl.create_default_context(cafile=cert)
        proxy = bridge.BridgeServer('http://127.0.0.1:1', 0,
                                    cert_dir=self.temp.name, log_fn=lambda _: None).start()
        self.addCleanup(proxy.stop)
        conn = http.client.HTTPSConnection('127.0.0.1', proxy.httpd.server_port,
                                           context=trusted, timeout=3)
        self.addCleanup(conn.close)
        conn.connect()  # Strict CA + hostname verification, not verify=False.

    def test_corrupt_root_is_not_silently_replaced(self):
        cert, key, _ = bridge.ensure_certificate(self.temp.name)
        old_key = Path(key).read_bytes()
        Path(cert).write_bytes(b'broken certificate')
        with self.assertRaisesRegex(RuntimeError, 'certs'):
            bridge.ensure_certificate(self.temp.name)
        self.assertEqual(Path(cert).read_bytes(), b'broken certificate')
        self.assertEqual(Path(key).read_bytes(), old_key)

    def test_new_ip_rotates_leaf_but_both_clients_keep_trust(self):
        from concurrent.futures import ThreadPoolExecutor
        import socket
        cert, key, _ = bridge.ensure_certificate(self.temp.name)
        before = Path(cert).read_bytes(), Path(key).read_bytes()
        clients = [ssl.create_default_context(cafile=cert) for _ in range(2)]
        leaf, _, = bridge.ensure_server_certificate(self.temp.name, cert, key, ['127.0.0.1'])
        old_leaf = Path(leaf).read_bytes()
        with patch.object(bridge, 'local_ipv4s', return_value=['127.0.0.1', '192.0.2.10']):
            proxy = bridge.BridgeServer('http://127.0.0.1:1', 0,
                                        cert_dir=self.temp.name, log_fn=lambda _: None).start()
        self.addCleanup(proxy.stop)
        self.assertEqual(before, (Path(cert).read_bytes(), Path(key).read_bytes()))
        self.assertNotEqual(old_leaf, Path(leaf).read_bytes())
        self.assertIn(('IP Address', '192.0.2.10'), ssl._ssl._test_decode_cert(leaf)['subjectAltName'])
        def verify(ctx):
            with socket.create_connection(('127.0.0.1', proxy.httpd.server_port), timeout=3) as raw:
                with ctx.wrap_socket(raw, server_hostname='192.0.2.10') as tls:
                    return tls.getpeercert()['subject']
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(len(list(pool.map(verify, clients))), 2)

    def test_repeated_start_preserves_leaf(self):
        cert, key, ips = bridge.ensure_certificate(self.temp.name)
        leaf, leaf_key = bridge.ensure_server_certificate(self.temp.name, cert, key, ips)
        before = Path(leaf).read_bytes(), Path(leaf_key).read_bytes()
        bridge.ensure_server_certificate(self.temp.name, cert, key, ips)
        self.assertEqual(before, (Path(leaf).read_bytes(), Path(leaf_key).read_bytes()))

    def test_wrong_issuer_leaf_is_reissued_without_changing_root(self):
        import shutil
        cert, key, ips = bridge.ensure_certificate(self.temp.name)
        root_before = Path(cert).read_bytes()
        with tempfile.TemporaryDirectory() as other:
            other_ca, other_key, _ = bridge.ensure_certificate(other)
            leaf, leaf_key = bridge.ensure_server_certificate(other, other_ca, other_key, ips)
            shutil.copy(leaf, self.temp.name)
            shutil.copy(leaf_key, self.temp.name)
        leaf, _ = bridge.ensure_server_certificate(self.temp.name, cert, key, ips)
        self.assertEqual(root_before, Path(cert).read_bytes())
        proxy = bridge.BridgeServer('http://127.0.0.1:1', 0,
                                    cert_dir=self.temp.name, log_fn=lambda _: None).start()
        self.addCleanup(proxy.stop)
        conn = http.client.HTTPSConnection('127.0.0.1', proxy.httpd.server_port,
                                           context=ssl.create_default_context(cafile=cert), timeout=3)
        self.addCleanup(conn.close)
        conn.connect()

    def test_missing_root_key_does_not_replace_root(self):
        cert, key, _ = bridge.ensure_certificate(self.temp.name)
        before = Path(cert).read_bytes()
        Path(key).unlink()
        with self.assertRaises(RuntimeError):
            bridge.ensure_certificate(self.temp.name)
        self.assertEqual(before, Path(cert).read_bytes())

    def test_expired_root_does_not_silently_rotate(self):
        cert, key, _ = bridge.ensure_certificate(self.temp.name)
        before = Path(cert).read_bytes(), Path(key).read_bytes()
        with patch.object(bridge.time, 'time', return_value=time.time() + 3651 * 86400):
            with self.assertRaises(RuntimeError):
                bridge.ensure_certificate(self.temp.name)
        self.assertEqual(before, (Path(cert).read_bytes(), Path(key).read_bytes()))

    def test_legacy_root_without_key_usage_is_preserved(self):
        import datetime
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        cert, key, _ = bridge.ensure_certificate(self.temp.name)
        ca = x509.load_pem_x509_certificate(Path(cert).read_bytes())
        private = serialization.load_pem_private_key(Path(key).read_bytes(), password=None)
        now = datetime.datetime.now(datetime.timezone.utc)
        legacy = (x509.CertificateBuilder().subject_name(ca.subject).issuer_name(ca.subject)
                  .public_key(private.public_key()).serial_number(x509.random_serial_number())
                  .not_valid_before(now - datetime.timedelta(days=1))
                  .not_valid_after(now + datetime.timedelta(days=30))
                  .add_extension(x509.BasicConstraints(ca=True, path_length=None), True)
                  .sign(private, hashes.SHA256()))
        Path(cert).write_bytes(legacy.public_bytes(serialization.Encoding.PEM))
        before = Path(cert).read_bytes(), Path(key).read_bytes()
        proxy = bridge.BridgeServer('http://127.0.0.1:1', 0,
                                    cert_dir=self.temp.name, log_fn=lambda _: None).start()
        self.addCleanup(proxy.stop)
        # Chain and hostname still verified; omit Python 3.13's optional
        # VERIFY_X509_STRICT extension policy for the legacy CA fixture.
        trusted = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        trusted.load_verify_locations(cafile=cert)
        conn = http.client.HTTPSConnection('127.0.0.1', proxy.httpd.server_port,
                                           context=trusted, timeout=3)
        self.addCleanup(conn.close)
        conn.connect()
        self.assertEqual(before, (Path(cert).read_bytes(), Path(key).read_bytes()))

    def test_openssl_fallback_signs_leaf_trusted_by_existing_root(self):
        import builtins
        exe = bridge._find_openssl()
        if not exe:
            self.skipTest('openssl not available')
        cert, key, ips = bridge.ensure_certificate(self.temp.name)
        importer = builtins.__import__
        def without_crypto(name, *args, **kwargs):
            if name.startswith('cryptography'):
                raise ImportError('exercise openssl fallback')
            return importer(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=without_crypto):
            leaf, leaf_key = bridge.ensure_server_certificate(self.temp.name, cert, key, ips)
            before = Path(leaf).read_bytes(), Path(leaf_key).read_bytes()
            proxy = bridge.BridgeServer('http://127.0.0.1:1', 0,
                                        cert_dir=self.temp.name, log_fn=lambda _: None).start()
        self.assertEqual(before, (Path(leaf).read_bytes(), Path(leaf_key).read_bytes()))
        self.addCleanup(proxy.stop)
        conn = http.client.HTTPSConnection('127.0.0.1', proxy.httpd.server_port,
                                           context=ssl.create_default_context(cafile=cert), timeout=3)
        self.addCleanup(conn.close)
        conn.connect()


class Streaming(unittest.TestCase):
    def test_first_sse_event_arrives_before_upstream_finishes(self):
        release = threading.Event()
        class Backend(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', '0')))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(b'data: first\n\n')
                self.wfile.flush()
                release.wait(3)
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
                self.close_connection = True

        with tempfile.TemporaryDirectory() as temp:
            upstream = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
            threading.Thread(target=upstream.serve_forever, daemon=True).start()
            proxy = bridge.BridgeServer('http://127.0.0.1:%d' % upstream.server_port, 0,
                                        cert_dir=temp, log_fn=lambda _: None).start()
            trusted = ssl.create_default_context(cafile=proxy.cert_file)
            conn = http.client.HTTPSConnection('127.0.0.1', proxy.httpd.server_port,
                                               context=trusted, timeout=2)
            try:
                start = time.monotonic()
                conn.request('POST', '/v1/chat/completions', b'{}')
                resp = conn.getresponse()
                self.assertEqual(resp.readline(), b'data: first\n')
                self.assertLess(time.monotonic() - start, 1.5)
                release.set()
                self.assertIn(b'[DONE]', resp.read())
            finally:
                release.set()
                conn.close()
                proxy.stop()
                upstream.shutdown()
                upstream.server_close()



class CertDistribution(unittest.TestCase):
    """Public /cert distributes only the stable trust root, never either key."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patcher = patch.object(bridge, 'local_ipv4s', return_value=['127.0.0.1'])
        patcher.start()
        self.addCleanup(patcher.stop)
        self.hits = []
        hits = self.hits  # 闭包捕获:do_GET 里的 self 是 Handler 实例,不能直接用

        class Backend(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_GET(self):
                hits.append(self.path)
                body = b'{"data":[]}'
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.backend = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        threading.Thread(target=self.backend.serve_forever, daemon=True).start()
        self.addCleanup(self.backend.server_close)
        self.addCleanup(self.backend.shutdown)
        self.proxy = bridge.BridgeServer(
            'http://127.0.0.1:%d' % self.backend.server_address[1], 0,
            cert_dir=self.temp.name, log_fn=lambda _: None).start()
        self.addCleanup(self.proxy.stop)
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        self.ctx.check_hostname = False
        self.ctx.verify_mode = ssl.CERT_NONE

    def test_cert_endpoint_serves_stable_root_not_rotating_leaf(self):
        port = self.proxy.httpd.server_port
        handed = ssl.get_server_certificate(('127.0.0.1', port))
        conn = http.client.HTTPSConnection('127.0.0.1', port, context=self.ctx, timeout=5)
        self.addCleanup(conn.close)
        conn.request('GET', '/cert')
        resp = conn.getresponse()
        body = resp.read().decode()
        self.assertEqual(resp.status, 200)
        self.assertEqual(body, Path(self.proxy.cert_file).read_text())
        self.assertNotEqual(body, handed)
        trusted = ssl.create_default_context(cadata=body)
        peer = http.client.HTTPSConnection('127.0.0.1', port, context=trusted, timeout=5)
        self.addCleanup(peer.close)
        peer.connect()  # Downloaded root validates the live leaf and hostname.

    def test_cert_endpoint_public_and_backend_untouched(self):
        conn = http.client.HTTPSConnection('127.0.0.1', self.proxy.httpd.server_port,
                                           context=self.ctx, timeout=5)
        self.addCleanup(conn.close)
        conn.request('GET', '/bridge_cert.pem')  # 不带任何 token 头
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        resp.read()  # 读完响应体,keep-alive 连接才能承载下一个请求
        self.assertFalse(self.hits)  # 证书下发不应触碰上游后端
        conn.request('GET', '/v1/models')
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.read(), b'{"data":[]}')
        self.assertEqual(self.hits, ['/v1/models'])

    def test_cert_download_strips_appended_keys_and_other_certificates(self):
        root = Path(self.proxy.cert_file)
        original = root.read_bytes()
        fingerprint = bridge.cert_fingerprint(str(root))
        root.write_bytes(original + (Path(self.temp.name) / 'bridge_key.pem').read_bytes()
                         + Path(self.proxy.server_cert_file).read_bytes())
        conn = http.client.HTTPSConnection('127.0.0.1', self.proxy.httpd.server_port,
                                           context=self.ctx, timeout=5)
        self.addCleanup(conn.close)
        conn.request('GET', '/cert')
        resp = conn.getresponse()
        body = resp.read()
        self.assertEqual(resp.status, 200)
        self.assertTrue(body == original)
        self.assertEqual(body.count(b'BEGIN CERTIFICATE'), 1)
        self.assertNotIn(b'PRIVATE KEY', body)
        self.assertEqual(bridge.cert_fingerprint(str(root)), fingerprint)

    def test_fingerprint_helper_matches_manual_sha256(self):
        import hashlib
        cert, _, _ = bridge.ensure_certificate(self.temp.name)
        fp = bridge.cert_fingerprint(cert)
        self.assertEqual(len(fp), 64)
        expected = hashlib.sha256(
            ssl.PEM_cert_to_DER_cert(Path(cert).read_text())).hexdigest().upper()
        self.assertEqual(fp, expected)
        self.assertEqual(bridge.cert_fingerprint(
            str(Path(cert).with_name('missing.pem'))), '')
if __name__ == '__main__':
    unittest.main()
