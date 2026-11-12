"""Bounded HTTP transport, VPN discovery, metadata-only metering and public portal.
No upstream credentials, prompts, images or response bodies are persisted here.
"""
import http.client
import hmac
import ipaddress
import json
import os
import socket
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 32 * 1024 * 1024
MAX_CAPTURE = 256 * 1024
KEY_HEADERS = {'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'x-auth-token'}
HOP_HEADERS = {'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
               'proxy-authenticate', 'proxy-authorization', 'te', 'upgrade', 'trailer'}
_vpn_cache = (0, [])
_vpn_lock = threading.Lock()


def radmin_ipv4s(refresh=False):
    """Discover by adapter identity, never assume all 26/8 addresses are Radmin."""
    global _vpn_cache
    with _vpn_lock:
        if not refresh and time.monotonic() < _vpn_cache[0]:
            return list(_vpn_cache[1])
        result = []
        if os.name == 'nt':
            script = ("$a=Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object "
                      "{$_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'Radmin' -or $_.Name -match 'Radmin')};"
                      "@($a | ForEach-Object {Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $_.ifIndex "
                      "-ErrorAction SilentlyContinue} | Select-Object -ExpandProperty IPAddress) | ConvertTo-Json -Compress")
            try:
                p = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
                                   capture_output=True, timeout=6, creationflags=0x08000000)
                value = json.loads(p.stdout.decode('utf-8-sig').strip() or '[]')
                for item in ([value] if isinstance(value, str) else value or []):
                    ip = ipaddress.ip_address(item)
                    if ip.version == 4 and not ip.is_loopback and not ip.is_link_local:
                        result.append(str(ip))
            except (OSError, ValueError, subprocess.TimeoutExpired, TypeError):
                pass
        _vpn_cache = time.monotonic() + 30, sorted(set(result))
        return list(_vpn_cache[1])


class BoundedHTTPServer(ThreadingHTTPServer):
    """TLS handshake is done in a worker, not the accept loop; connection cap 32."""
    daemon_threads = True
    block_on_close = False
    request_queue_size = 64
    allow_reuse_address = True

    def __init__(self, address, handler, tls_context=None, max_connections=32):
        self.tls_context = tls_context
        self._slots = threading.BoundedSemaphore(max_connections)
        self._workers = {}
        self._api_workers = set()
        self._workers_changed = threading.Condition()
        self.stopping = threading.Event()
        super().__init__(address, handler)

    @staticmethod
    def _cancel(sock):
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        sock.close()
        # makefile() retains Windows handles after close(); cancel blocked readers too.
        if sock.fileno() >= 0:
            socket.close(sock.detach())

    def track_socket(self, sock):
        with self._workers_changed:
            ident = threading.get_ident()
            paused_api = ident in self._api_workers and not getattr(self, 'proxy_cfg', {}).get('enabled', True)
            if not self.stopping.is_set() and not paused_api:
                sockets = self._workers.setdefault(ident, set())
                sockets.difference_update(s for s in list(sockets) if s.fileno() < 0)
                sockets.add(sock)
                return
        self._cancel(sock)
        raise ConnectionError('server_stopped')

    def begin_api(self, fallback):
        with self._workers_changed:
            current = getattr(self, 'proxy_cfg', fallback)
            if self.stopping.is_set() or not current.get('enabled', True):
                return None
            self._api_workers.add(threading.get_ident())
            return dict(current)

    def end_api(self):
        with self._workers_changed:
            self._api_workers.discard(threading.get_ident())
            self._workers_changed.notify_all()

    def configure(self, settings):
        # Publish disabled first, so no API can enter while old workers drain.
        with self._workers_changed:
            self.proxy_cfg = dict(settings, enabled=False)
            for ident in list(self._api_workers):
                for sock in list(self._workers.get(ident, ())):
                    self._cancel(sock)
            end = time.monotonic() + 6
            while self._api_workers and time.monotonic() < end:
                self._workers_changed.wait(max(0, end-time.monotonic()))
            if self._api_workers:
                raise RuntimeError('API workers did not stop')
            self.proxy_cfg = dict(settings)

    def open_upstream(self, request, timeout):
        server = self
        class Tracked:
            def connect(self):
                original = self.timeout
                self.timeout = min(original, 5)
                super().connect()
                self.timeout = original
                self.sock.settimeout(original)
                server.track_socket(self.sock)
        class HTTP(Tracked, http.client.HTTPConnection):
            pass
        class HTTPS(Tracked, http.client.HTTPSConnection):
            pass
        class HTTPHandler(urllib.request.HTTPHandler):
            def http_open(self, req):
                return self.do_open(HTTP, req)
        class HTTPSHandler(urllib.request.HTTPSHandler):
            def https_open(self, req):
                return self.do_open(HTTPS, req, context=self._context)
        return urllib.request.build_opener(HTTPHandler(), HTTPSHandler()).open(request, timeout=timeout)

    def process_request(self, request, address):
        request.settimeout(15)
        if self.stopping.is_set():
            self.shutdown_request(request)
            return
        if not self._slots.acquire(False):
            try:
                request.settimeout(0.5)
                if self.tls_context:
                    request = self.tls_context.wrap_socket(request, server_side=True)
                request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\nRetry-After: 1\r\n\r\n')
            except (OSError, ssl.SSLError):
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self._slots.release()
            self.shutdown_request(request)
            raise

    def process_request_thread(self, request, address):
        try:
            self.track_socket(request)
            if self.tls_context:
                raw = request
                request = self.tls_context.wrap_socket(request, server_side=True, do_handshake_on_connect=False)
                self.track_socket(request)
                with self._workers_changed:
                    self._workers[threading.get_ident()].discard(raw)
                request.do_handshake()
            super().process_request_thread(request, address)
        except (OSError, ssl.SSLError):
            self.shutdown_request(request)
        finally:
            with self._workers_changed:
                self._workers.pop(threading.get_ident(), None)
                self._workers_changed.notify_all()
            self._slots.release()

    def server_close(self):
        self.stopping.set()
        super().server_close()
        end = time.monotonic() + 6
        with self._workers_changed:
            for sockets in list(self._workers.values()):
                for sock in sockets:
                    self._cancel(sock)
            while self._workers and time.monotonic() < end:
                self._workers_changed.wait(max(0, end-time.monotonic()))

    def handle_error(self, request, client_address):
        # Client disconnects are routine; no raw exception/URL/credential dumps.
        pass


class UsageObserver:
    """Bounded, transient parser. Only normalized upstream usage survives."""
    def __init__(self, sse=False, enabled=True):
        self.sse, self.enabled = sse, enabled
        self.buffer = bytearray()
        self.overflow = False
        self.skip_line = False
        self.usage = None

    @staticmethod
    def tokens(data):
        if not isinstance(data, dict):
            return None
        usage = data.get('usage')
        if not isinstance(usage, dict):
            msg = data.get('message') or data.get('response')
            usage = msg.get('usage') if isinstance(msg, dict) else None
        if not isinstance(usage, dict):
            return None
        def number(*names):
            for name in names:
                v = usage.get(name)
                if isinstance(v, int) and not isinstance(v, bool) and v >= 0:
                    return v
            return None
        output = dict(input_tokens=number('input_tokens', 'prompt_tokens'),
                      output_tokens=number('output_tokens', 'completion_tokens'),
                      total_tokens=number('total_tokens'))
        return output if any(v is not None for v in output.values()) else None

    def _json(self, raw):
        try:
            found = self.tokens(json.loads(raw))
            if found:
                if self.usage is None:
                    self.usage = found
                else:
                    self.usage.update({k: v for k, v in found.items() if v is not None})
        except (ValueError, UnicodeError, RecursionError):
            pass

    def feed(self, chunk):
        if not self.enabled:
            return
        if not self.sse:
            if len(self.buffer) + len(chunk) <= MAX_CAPTURE:
                self.buffer.extend(chunk)
            else:
                self.buffer.clear()
                self.enabled = False
            return
        # Streaming lines bounded even for huge content deltas; never retain full output.
        for part in chunk.splitlines(keepends=True):
            ends = part.endswith(b'\n')
            if not self.skip_line and len(self.buffer) + len(part) <= MAX_CAPTURE:
                self.buffer.extend(part)
            else:
                self.buffer.clear()
                self.skip_line = True
            if ends:
                if not self.skip_line and self.buffer.startswith(b'data:'):
                    self._json(bytes(self.buffer[5:]).strip())
                self.buffer.clear()
                self.skip_line = False

    def finish(self):
        if self.enabled and not self.sse:
            self._json(bytes(self.buffer))
        self.buffer.clear()
        return self.usage


class BodyError(Exception):
    def __init__(self, status):
        self.status = status


def make_proxy_handler(cfg, log_fn, join_upstream, chat_chunks):
    store = cfg.get('store')
    gate = cfg.setdefault('api_gate', threading.BoundedSemaphore(cfg.get('capacity', 8)))
    vpn_ips = set(cfg.get('vpn_ips', []))
    cfg_defaults = cfg

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def _send(self, code, data, ctype='application/json; charset=utf-8'):
            raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Frame-Options', 'DENY')
            if self.close_connection:
                self.send_header('Connection', 'close')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(raw)
                return len(raw)
            return 0

        def _body(self, cap=MAX_BODY):
            te = self.headers.get('Transfer-Encoding', '').lower()
            if te:
                if te != 'chunked' or self.headers.get('Content-Length') is not None:
                    raise BodyError(400)
                parts, total = [], 0
                while True:
                    line = self.rfile.readline(128)
                    if not line.endswith(b'\r\n'):
                        raise BodyError(400)
                    try:
                        size = int(line.strip().split(b';')[0], 16)
                    except ValueError:
                        raise BodyError(400)
                    if size < 0 or total + size > cap:
                        raise BodyError(413)
                    if not size:
                        for _ in range(32):
                            trailer = self.rfile.readline(8192)
                            if trailer == b'\r\n':
                                return b''.join(parts)
                            if not trailer or not trailer.endswith(b'\r\n'):
                                raise BodyError(400)
                        raise BodyError(400)
                    data = self.rfile.read(size)
                    if len(data) != size or self.rfile.read(2) != b'\r\n':
                        raise BodyError(400)
                    parts.append(data)
                    total += size
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                raise BodyError(400)
            if size < 0 or size > cap:
                raise BodyError(413)
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise BodyError(400)
            return raw

        def _portal_allowed(self):
            local = self.connection.getsockname()[0]
            return local in vpn_ips or ipaddress.ip_address(local).is_loopback

        def _current(self):
            return getattr(self.server, 'proxy_cfg', cfg)

        def _same_origin(self):
            hosts = self.headers.get_all('Host', [])
            if len(hosts) != 1:
                return False
            try:
                host = urllib.parse.urlsplit('https://' + hosts[0])
                allowed = vpn_ips | {'127.0.0.1', 'localhost', '::1', self.connection.getsockname()[0]}
                if (host.hostname not in allowed or host.username or host.password or host.path or
                        host.query or host.fragment or (host.port or 443) != self.server.server_port):
                    return False
            except ValueError:
                return False
            origin = self.headers.get('Origin')
            return (not origin or origin == 'https://' + hosts[0]) and self.headers.get('Sec-Fetch-Site') != 'cross-site'

        def _admin(self, path):
            current = self._current()
            callback = current.get('admin')
            if not self._portal_allowed() or not callback or store is None:
                self.close_connection = True
                return self._send(403, {'ok': False, 'error': 'management_unavailable'})
            if not self._same_origin():
                self.close_connection = True
                return self._send(403, {'ok': False, 'error': 'same_origin_required'})
            if path == '/console' and self.command in ('GET', 'HEAD'):
                return self._send(200, current['console_html']().encode('utf-8'), 'text/html; charset=utf-8')
            if self.headers.get('X-Bridge-Portal') != '1':
                self.close_connection = True
                return self._send(403, {'ok': False, 'error': 'portal_header_required'})
            if self.command not in ('GET', 'POST'):
                self.close_connection = True
                return self._send(405, {'ok': False, 'error': 'method_not_allowed'})
            try:
                data = json.loads(self._body(16384) or b'{}') if self.command == 'POST' else {}
                if not isinstance(data, dict):
                    raise ValueError('bad_json')
                code, result, after_send = callback(self.command, path, data)
                self._send(code, result)
                self.wfile.flush()
                if after_send:
                    timer = threading.Timer(0.2, after_send)
                    timer.daemon = True
                    timer.start()
            except BodyError as e:
                self.close_connection = True
                self._send(e.status, {'ok': False, 'msg': '请求体无效'})
            except (ValueError, TypeError):
                self.close_connection = True
                self._send(400, {'ok': False, 'msg': '请求格式无效'})
            except Exception as e:
                log_fn('[管理] 操作失败:' + type(e).__name__)
                self.close_connection = True
                self._send(500, {'ok': False, 'msg': '操作失败,请查看运行日志'})

        def _portal(self, path, query):
            if not self._portal_allowed() or store is None:
                self.close_connection = True
                self._send(404, {'ok': False, 'error': 'portal_unavailable_on_this_interface'})
                return
            try:
                if self.command in ('GET', 'HEAD'):
                    if path in ('/', '/portal/devices', '/portal/keys', '/portal/requests'):
                        from portal_ui import PORTAL_HTML
                        self._send(200, PORTAL_HTML.encode('utf-8'), 'text/html; charset=utf-8')
                    elif path == '/portal/api/info':
                        current = self._current()
                        preferred = next(iter(current.get('vpn_ips', [])), '127.0.0.1')
                        self._send(200, dict(ok=True, api_url='https://%s:%s/v1' % (preferred, self.server.server_port),
                                             vpn_ip=next(iter(current.get('vpn_ips', [])), ''), vpn_available=bool(vpn_ips),
                                             cert_fp=current.get('cert_fp', ''), retention_days=30,
                                             notice='仅记录应用层请求/响应体流量;在线为最近5分钟活动,非VPN成员扫描',
                                             running=current.get('enabled', True), admin_enabled=bool(current.get('admin')),
                                             capacity=current.get('capacity', 8)))
                    elif path == '/portal/api/stats':
                        def stamp(name):
                            raw = query.get(name, [''])[0]
                            if not raw:
                                return None
                            v = float(raw)
                            if not 0 <= v <= 4102444800:
                                raise ValueError('invalid_time')
                            return v
                        self._send(200, store.snapshot(since=stamp('since'), until=stamp('until'), limit=100))
                    elif path == '/portal/api/devices':
                        self._send(200, {'devices': store.devices()})
                    elif path == '/portal/api/keys':
                        self._send(200, {'keys': store.list_keys()})
                    else:
                        self._send(404, {'ok': False, 'error': 'not_found'})
                    return
                if self.command != 'POST':
                    self.close_connection = True
                    return self._send(405, {'ok': False, 'error': 'method_not_allowed'})
                if self.headers.get('X-Bridge-Portal') != '1' or not self._same_origin():
                    self.close_connection = True
                    return self._send(403, {'ok': False, 'error': 'same_origin_required'})
                data = json.loads(self._body(4096) or b'{}')
                if not isinstance(data, dict):
                    raise ValueError('bad_json')
                if path == '/portal/api/keys':
                    if not self._current().get('backend_key'):
                        return self._send(409, {'ok': False, 'error': 'upstream_key_not_configured_locally'})
                    self._send(201, store.issue_key(str(data.get('label') or ''), self.client_address[0]))
                elif path == '/portal/api/revoke':
                    ok = store.revoke_key(data.get('id'))
                    self._send(200 if ok else 404, {'ok': ok})
                elif path == '/portal/api/heartbeat':
                    store.touch(self.client_address[0])
                    self._send(200, {'ok': True})
                else:
                    self._send(404, {'ok': False, 'error': 'not_found'})
            except BodyError as e:
                self.close_connection = True
                self._send(e.status, {'ok': False, 'error': 'invalid_body'})
            except (ValueError, TypeError):
                self._send(400, {'ok': False, 'error': 'invalid_request_or_capacity'})

        def _auth(self, settings):
            values = []
            for name in KEY_HEADERS:
                raw = self.headers.get(name)
                if raw:
                    value = raw[7:].strip() if raw.lower().startswith('bearer ') else raw.strip()
                    values.append(value)
            if store is None:
                return 'legacy', False
            # Managed namespace always validates, including after restart/revocation.
            managed = [v for v in values if v.startswith('lbp_')]
            if managed:
                if any(v != managed[0] for v in values):
                    return None, False
                found = store.resolve_key(managed[0])
                return (found['id'], True) if found and settings.get('backend_key') else (None, False)
            expected = settings.get('external_key') if settings.get('replace_key') else settings.get('backend_key')
            if expected:
                return ('legacy', False) if values and all(hmac.compare_digest(v, expected) for v in values) else (None, False)
            # Preserve pre-existing keyless/unknown-key passthrough installations.
            return 'legacy', False

        def _meter(self, *args, **kwargs):
            if not store:
                return None
            try:
                return getattr(store, args[0])(*args[1:], **kwargs)
            except Exception as e:
                log_fn('[统计] 写入失败:' + type(e).__name__)
                return None

        def _proxy(self, path):
            cfg = self.server.begin_api(cfg_defaults)
            if cfg is None:
                self.close_connection = True
                return self._send(503, {'error': 'bridge_stopped'})
            started = time.monotonic()
            status, received, sent, rid, outcome = 500, 0, 0, None, 'error'
            admitted = False
            observer = UsageObserver(enabled=False)
            response = None
            try:
                key_id, managed = self._auth(cfg)
                if key_id is None:
                    rid = self._meter('begin', self.client_address[0], 'invalid', '', path, self.command)
                    status = 401
                    self.close_connection = True
                    sent = self._send(status, {'error': 'invalid_or_revoked_key'})
                    return
                if not gate.acquire(False):
                    rid = self._meter('begin', self.client_address[0], key_id, '', path, self.command)
                    status = 503
                    self.close_connection = True
                    sent = self._send(status, {'error': 'bridge_busy', 'retry_after': 1})
                    return
                admitted = True
                body = self._body()
                received = len(body)
                payload = None
                if body and 'json' in self.headers.get('Content-Type', '').lower():
                    try:
                        payload = json.loads(body)
                    except (ValueError, UnicodeError, RecursionError):
                        pass
                # Preserve older clients omitting Content-Type on JSON chat requests.
                if payload is None and body and path.endswith('/chat/completions'):
                    try:
                        payload = json.loads(body)
                    except (ValueError, UnicodeError, RecursionError):
                        pass
                model = str(payload.get('model', ''))[:160] if isinstance(payload, dict) else ''
                chat_stream = path.rstrip('/').endswith('/chat/completions') and isinstance(payload, dict) and payload.get('stream') is True
                rid = self._meter('begin', self.client_address[0], key_id, model, path, self.command)
                headers = {}
                for name, value in self.headers.items():
                    if name.lower() in HOP_HEADERS:
                        continue
                    if managed and name.lower() in KEY_HEADERS:
                        continue
                    if cfg.get('replace_key') and name.lower() in KEY_HEADERS:
                        value = value.replace(cfg.get('external_key') or '\x00', cfg.get('backend_key') or '')
                    headers[name] = value
                if managed:
                    headers['Authorization'] = 'Bearer ' + cfg['backend_key']
                    headers['x-api-key'] = cfg['backend_key']
                if chat_stream:
                    headers = {k:v for k,v in headers.items() if k.lower() != 'accept-encoding'}
                    headers['Accept-Encoding'] = 'identity'
                request = urllib.request.Request(join_upstream(cfg['backend'], self.path),
                                                 data=body or None, headers=headers, method=self.command)
                try:
                    response = self.server.open_upstream(request, cfg.get('timeout', 300))
                except urllib.error.HTTPError as e:
                    response = e
                except Exception:
                    status = 502
                    sent = self._send(status, {'bridge_error': 'upstream_unreachable'})
                    return
                status = response.getcode()
                ctype = response.headers.get('Content-Type', '')
                encoding = response.headers.get('Content-Encoding', 'identity').lower()
                sse = 'event-stream' in ctype.lower()
                observer = UsageObserver(sse=sse, enabled=encoding == 'identity' and (sse or 'json' in ctype.lower()))
                rlen = response.headers.get('Content-Length')
                no_body = status in (204, 304) or self.command == 'HEAD'
                streaming = not no_body and (rlen is None or sse)
                self.send_response(status)
                for name, value in response.headers.items():
                    if name.lower() not in HOP_HEADERS:
                        self.send_header(name, value)
                if no_body:
                    if rlen is not None:
                        self.send_header('Content-Length', rlen)
                elif streaming:
                    self.send_header('Transfer-Encoding', 'chunked')
                else:
                    self.send_header('Content-Length', rlen)
                self.end_headers()
                stats = {}
                if not no_body:
                    class CountedReader:
                        count = 0
                        def __getattr__(reader, name):
                            return getattr(response, name)
                        def read(reader, size):
                            data = response.read(size)
                            reader.count += len(data)
                            return data
                        def read1(reader, size):
                            data = getattr(response, 'read1', response.read)(size)
                            reader.count += len(data)
                            return data
                        def readline(reader, size):
                            data = response.readline(size)
                            reader.count += len(data)
                            return data
                    source = CountedReader()
                    read_chunk = source.read1 if streaming else source.read
                    chunks = (chat_chunks(source, stats) if chat_stream and 200 <= status < 300 and sse and encoding == 'identity'
                              else iter(lambda: read_chunk(65536), b''))
                    for chunk in chunks:
                        observer.feed(chunk)
                        if streaming:
                            self.wfile.write(b'%x\r\n' % len(chunk) + chunk + b'\r\n')
                        else:
                            self.wfile.write(chunk)
                        self.wfile.flush()
                        sent += len(chunk)
                    if rlen is not None and source.count != int(rlen):
                        raise ConnectionError('incomplete_upstream')
                    if streaming:
                        self.wfile.write(b'0\r\n\r\n')
                        self.wfile.flush()
                outcome = 'ok' if 200 <= status < 400 else 'error'
                if stats.get('normalised'):
                    log_fn('[SSE 兼容] 规范 %d 个终态后空候选,保留 usage 统计' % stats['normalised'])
            except BodyError as e:
                status = e.status
                self.close_connection = True
                sent = self._send(status, {'error': 'invalid_or_oversized_body'})
            except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException):
                outcome = 'interrupted'
                self.close_connection = True
            finally:
                if response is not None:
                    response.close()
                if rid is None:
                    rid = self._meter('begin', self.client_address[0], 'unknown', '', path, self.command)
                if rid:
                    self._meter('finish', rid, status, received, sent, (time.monotonic()-started)*1000,
                                usage=observer.finish(), outcome=outcome)
                if admitted:
                    gate.release()
                self.server.end_api()
                # Do not log URLs/queries, exception strings or user-supplied credentials.
                log_fn('[%d] %s API %s (%d ms, 请求体 %d B, 已发 %d B)' % (
                    status, self.command, outcome, (time.monotonic()-started)*1000, received, sent))

        def _dispatch(self):
            if self.server.stopping.is_set():
                self.close_connection = True
                return
            parsed = urllib.parse.urlsplit(self.path)
            path = parsed.path
            if path == '/favicon.ico':
                self.close_connection = self.command not in ('GET', 'HEAD')
                return self._send(204 if not self.close_connection else 405, b'')
            if path == '/' or path.startswith('/portal/'):
                return self._portal(path, urllib.parse.parse_qs(parsed.query))
            if path == '/console' or path.startswith('/api/'):
                return self._admin(path)
            if path.rstrip('/') in ('/cert', '/cert.pem', '/bridge_cert.pem'):
                if self.command not in ('GET', 'HEAD'):
                    self.close_connection = True
                    return self._send(405, {'error': 'method_not_allowed'})
                data = cfg.get('public_cert')
                return self._send(200, data, 'application/x-pem-file') if data else self._send(503, {'error':'cert_unavailable'})
            return self._proxy(path)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _dispatch

    return Handler
