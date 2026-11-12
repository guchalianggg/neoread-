"""Acceptance fixtures: real TLS, simulated upstream, no user secrets/paid models."""
import concurrent.futures
import http.client
import json
import socket
import ssl
import struct
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
import bridge_runtime as runtime
from bridge_store import UsageStore


class FakeUpstream(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        data = json.loads(raw or b'{}')
        with self.server.lock:
            self.server.hits.append((self.path, self.headers.get('Authorization')))
        model = data.get('model', '')
        if model == 'stall-headers':
            self.server.headers_waiting.set()
            self.server.release_abort.wait(4)
            self.close_connection = True
            return
        if model in ('fixed-truncated', 'fixed-normalised'):
            output = (b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
                      b'data: {"choices":[{"index":0,"delta":{},"finish_reason":null}],"usage":{"total_tokens":7}}\n\n'
                      b'data: [DONE]\n\n')
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(output)+(100 if model=='fixed-truncated' else 0)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(output)
            self.wfile.flush()
            self.close_connection = True
            return
        if model.startswith('sse-'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            first = {'choices':[{'index':0,'delta':{'content':model}}]}
            self.wfile.write(b'data: '+json.dumps(first).encode()+b'\n\n')
            self.wfile.flush()
            if model == 'sse-disconnect':
                self.server.release_abort.wait(3)
                try:
                    for _ in range(400):
                        self.wfile.write(b'data: '+b'x'*16384+b'\n\n')
                        self.wfile.flush()
                except (OSError, ConnectionError):
                    pass
                self.close_connection = True
                return
            with self.server.lock:
                self.server.active += 1
                if self.server.active == 2:
                    self.server.two_active.set()
            try:
                for _ in range(11):
                    time.sleep(1)
                    self.wfile.write(b': keepalive\n\n')
                    self.wfile.flush()
                self.wfile.write(b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
                self.wfile.write(b'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n')
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
            except OSError:
                pass
            finally:
                with self.server.lock:
                    self.server.active -= 1
            self.close_connection = True
            return
        time.sleep(0.15)
        status = 429 if model == 'error' else 200
        output = {'model':model, 'choices':[{'message':{'content':'PRIVATE_RESPONSE_MARKER'}}]}
        if model != 'unknown':
            output['usage'] = {'prompt_tokens':5,'completion_tokens':2,'total_tokens':7}
        encoded = json.dumps(output).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class PortalAcceptance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = UsageStore(str(self.root/'usage.sqlite3'))
        self.addCleanup(self.store.close)
        self.up = ThreadingHTTPServer(('127.0.0.1', 0), FakeUpstream)
        self.up.hits, self.up.active = [], 0
        self.up.lock = threading.Lock()
        self.up.two_active = threading.Event()
        self.up.release_abort = threading.Event()
        self.up.headers_waiting = threading.Event()
        threading.Thread(target=self.up.serve_forever, daemon=True).start()
        self.addCleanup(self.up.server_close)
        self.addCleanup(self.up.shutdown)
        self.logs = []
        self.vpn = runtime.radmin_ipv4s()
        self.addresses = list(dict.fromkeys(bridge.local_ipv4s()+['127.0.0.2']+self.vpn))
        with patch.object(bridge, 'local_ipv4s', return_value=self.addresses), \
             patch.object(bridge, 'make_handler', wraps=bridge.make_handler) as maker:
            self.proxy = bridge.BridgeServer('http://127.0.0.1:%d' % self.up.server_port, 0,
                                             backend_key='fixture-upstream-secret', external_key='lb_fixture_legacy',
                                             store=self.store, cert_dir=str(self.root/'certs'), log_fn=self.logs.append).start()
            self.cfg = maker.call_args.args[0]
        self.addCleanup(self.proxy.stop)
        self.port = self.proxy.httpd.server_port
        self.context = ssl.create_default_context(cafile=self.proxy.cert_file)

    def request(self, path, data=None, key=None, host='127.0.0.1', source=None, headers=None, method=None):
        conn = http.client.HTTPSConnection(host, self.port, context=self.context, timeout=18,
                                           source_address=(source,0) if source else None)
        payload = json.dumps(data).encode() if data is not None else None
        h = {'Content-Type':'application/json', 'X-Bridge-Portal':'1'}
        if key:
            h['Authorization'] = 'Bearer '+key
        h.update(headers or {})
        try:
            conn.request(method or ('POST' if data is not None else 'GET'), path, body=payload, headers=h)
            response = conn.getresponse()
            raw = response.read()
            try:
                output = json.loads(raw)
            except ValueError:
                output = raw
            return response.status, output, raw
        finally:
            conn.close()

    def issue(self, label):
        code, data, _ = self.request('/portal/api/keys', {'label':label})
        self.assertEqual(code, 201)
        return data

    def wait_records(self, n):
        until = time.monotonic()+4
        while time.monotonic() < until:
            snap = self.store.snapshot()
            if snap['summary']['requests'] >= n:
                return snap
            time.sleep(.02)
        self.fail('metadata not committed')

    def test_two_long_streams_and_portal_remain_responsive(self):
        a, b = self.issue('device A'), self.issue('device B')
        def stream(key, model, source):
            c = http.client.HTTPSConnection('127.0.0.1', self.port, context=self.context,
                                            timeout=18, source_address=(source,0))
            payload = json.dumps({'model':model,'stream':True,'messages':[{'role':'user','content':'PRIVATE_PROMPT_MARKER'}]}).encode()
            start = time.monotonic()
            c.request('POST', '/v1/chat/completions', payload,
                      {'Authorization':'Bearer '+key, 'Content-Type':'application/json'})
            r = c.getresponse()
            first = r.readline()
            first_ms = (time.monotonic()-start)*1000
            body = first+r.read()
            elapsed = time.monotonic()-start
            c.close()
            return model, first_ms, elapsed, body, len(payload)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(stream,a['key'],'sse-A','127.0.0.1'),
                       pool.submit(stream,b['key'],'sse-B','127.0.0.2')]
            self.assertTrue(self.up.two_active.wait(5), 'two streams must actually overlap')
            t=time.monotonic(); code,_,_=self.request('/portal/api/stats'); stats_ms=(time.monotonic()-t)*1000
            self.assertEqual(code,200); self.assertLess(stats_ms,2000)
            t=time.monotonic(); self.issue('third idle device'); issue_ms=(time.monotonic()-t)*1000
            self.assertLess(issue_ms,2000)
            devices=self.store.devices()
            self.assertEqual(sum(d['active'] for d in devices),2)
            self.assertTrue({'127.0.0.1','127.0.0.2'}.issubset({d['ip'] for d in devices if d['online']}))
            results=[f.result() for f in futures]
        for model,first_ms,elapsed,body,size in results:
            self.assertLess(first_ms,2000); self.assertGreaterEqual(elapsed,10)
            self.assertIn(model.encode(),body); self.assertIn(b'[DONE]',body)
            self.assertNotIn(('sse-B' if model=='sse-A' else 'sse-A').encode(),body)
        snap=self.wait_records(2)
        self.assertEqual(snap['summary']['requests'],2)
        self.assertEqual(snap['summary']['success'],2)
        self.assertEqual(snap['summary']['total_tokens'],14)
        self.assertEqual(snap['summary']['out_bytes'],sum(len(r[3]) for r in results))
        self.assertEqual(snap['summary']['in_bytes'],sum(r[4] for r in results))
        print('DOUBLE_SSE=PASS duration=%.2fs/%.2fs first=%.1fms/%.1fms stats=%.1fms key=%.1fms' %
              (results[0][2],results[1][2],results[0][1],results[1][1],stats_ms,issue_ms))

    def test_parallel_json_keys_auth_revocation_and_persistence(self):
        a,b=self.issue('A'),self.issue('B')
        def invoke(item):
            key,model=item
            return self.request('/v1/chat/completions',{'model':model,'messages':[{'content':'PRIVATE_PROMPT_MARKER'}]},key=key)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(invoke,[(a['key'],'json-A'),(b['key'],'json-B')]))
        self.assertEqual([r[1]['model'] for r in results],['json-A','json-B'])
        self.assertEqual([auth for _,auth in self.up.hits],['Bearer fixture-upstream-secret']*2)
        self.wait_records(2)
        self.assertEqual(self.request('/portal/api/revoke',{'id':a['id']})[0],200)
        count=len(self.up.hits)
        for key in (a['key'],'lbp_invalid','nonsense'):
            self.assertEqual(invoke((key,'rejected'))[0],401)
        self.assertEqual(len(self.up.hits),count)
        self.assertEqual(invoke(('lb_fixture_legacy','old-client'))[0],200)
        self.wait_records(6)
        second=UsageStore(str(self.root/'usage.sqlite3'))
        try:
            self.assertIsNone(second.resolve_key(a['key']))
            self.assertIsNotNone(second.resolve_key(b['key']))
            self.assertEqual(second.snapshot()['summary']['requests'],6)
        finally:
            second.close()
        for endpoint in ('/portal/api/info','/portal/api/stats','/portal/api/keys','/portal/api/devices','/'):
            raw=self.request(endpoint)[2]
            for secret in (a['key'],b['key'],'fixture-upstream-secret','PRIVATE_PROMPT_MARKER','PRIVATE_RESPONSE_MARKER'):
                self.assertNotIn(secret.encode(),raw)
        self.assertFalse(any('PRIVATE_' in log or 'secret' in log for log in self.logs))
        for file in self.root.glob('usage.sqlite3*'):
            data=file.read_bytes()
            for secret in (a['key'],b['key'],'PRIVATE_PROMPT_MARKER','PRIVATE_RESPONSE_MARKER'):
                self.assertFalse(secret.encode() in data)

    def test_errors_usage_unknown_overload_and_size_bounds(self):
        key=self.issue('A')['key']
        for model,status in [('error',429),('unknown',200)]:
            self.assertEqual(self.request('/v1/chat/completions',{'model':model},key=key)[0],status)
        snap=self.wait_records(2)
        self.assertEqual(snap['summary']['failed'],1)
        self.assertEqual(snap['summary']['usage_known'],1)
        self.assertEqual(snap['summary']['usage_unknown'],1)
        self.assertEqual(snap['summary']['total_tokens'],7)
        for _ in range(8): self.assertTrue(self.cfg['api_gate'].acquire(False))
        try:
            self.assertEqual(self.request('/v1/chat/completions',{'model':'busy'},key=key)[0],503)
            self.assertEqual(self.request('/portal/api/stats')[0],200)
        finally:
            for _ in range(8): self.cfg['api_gate'].release()
        c=http.client.HTTPSConnection('127.0.0.1',self.port,context=self.context,timeout=4)
        c.request('POST','/v1/chat/completions',headers={'Authorization':'Bearer '+key,'Content-Length':str(runtime.MAX_BODY+1)})
        r=c.getresponse();self.assertEqual(r.status,413);r.read();c.close()
        self.assertEqual(len(self.up.hits),2)

    def test_remote_management_blocked_origin_guard_and_interface_restriction(self):
        host=self.vpn[0] if self.vpn else '127.0.0.1'
        self.assertEqual(self.request('/portal/api/info',host=host)[0],200)
        if self.vpn:
            self.assertEqual(self.proxy.urls()[0],'https://%s:%d'%(host,self.port))
            print('ACTUAL_RADMIN_TLS_PORTAL=PASS '+host)
        for path in ('/api/form','/api/state','/api/start','/api/stop','/api/cert','/api/quit'):
            self.assertEqual(self.request(path,{},host=host,headers={'X-Bridge-Token':'fixture'})[0],403)
        self.assertEqual(self.request('/portal/api/keys',{'label':'cross'},headers={'Origin':'https://other.invalid'})[0],403)
        other=next((ip for ip in self.addresses if not ip.startswith('127.') and ip not in self.vpn),None)
        if other:
            self.assertEqual(self.request('/',host=other)[0],404)
            self.assertEqual(self.request('/portal/api/keys',{},host=other)[0],404)
        with patch.object(runtime,'_vpn_cache',(time.monotonic()+10,[])):
            self.assertEqual(runtime.radmin_ipv4s(),[])

    def test_client_abort_recorded_once(self):
        key=self.issue('A')['key']
        c=http.client.HTTPSConnection('127.0.0.1',self.port,context=self.context,timeout=5)
        c.request('POST','/v1/chat/completions',json.dumps({'model':'sse-disconnect','stream':True}),
                  {'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        r=c.getresponse(); self.assertIn(b'data:',r.readline())
        c.sock.setsockopt(socket.SOL_SOCKET,socket.SO_LINGER,struct.pack('hh',1,0))
        c.sock.close(); c.close(); r.close()
        self.up.release_abort.set()
        snap=self.wait_records(1)
        self.assertEqual(snap['summary']['requests'],1)
        self.assertEqual(snap['summary']['failed'],1)
        self.assertEqual(snap['details'][0]['outcome'],'interrupted')

    def test_fixed_length_sse_checks_raw_bytes_after_normalisation(self):
        key = self.issue('fixed')['key']
        self.assertEqual(self.request('/v1/chat/completions', {'model':'fixed-normalised','stream':True}, key=key)[0], 200)
        c = http.client.HTTPSConnection('127.0.0.1', self.port, context=self.context, timeout=5)
        c.request('POST', '/v1/chat/completions', json.dumps({'model':'fixed-truncated','stream':True}),
                  {'Content-Type':'application/json','Authorization':'Bearer '+key})
        r = c.getresponse()
        with self.assertRaises(http.client.IncompleteRead):
            r.read()
        c.close()
        snap = self.wait_records(2)
        self.assertEqual(snap['summary']['requests'], 2)
        self.assertEqual(snap['summary']['success'], 1)
        self.assertEqual(snap['summary']['failed'], 1)
        self.assertEqual({d['outcome'] for d in snap['details']}, {'ok','interrupted'})

    def test_generated_errors_count_actual_response_bytes(self):
        key = self.issue('errors')['key']
        a = self.request('/v1/chat/completions', key='lbp_invalid')
        self.assertEqual(a[0], 401)
        for _ in range(8): self.cfg['api_gate'].acquire()
        try:
            b = self.request('/v1/chat/completions', key=key)
            self.assertEqual(b[0], 503)
        finally:
            for _ in range(8): self.cfg['api_gate'].release()
        with patch.object(self.proxy.httpd, 'open_upstream', side_effect=OSError):
            c = self.request('/v1/chat/completions', key=key)
            self.assertEqual(c[0], 502)
        snap = self.wait_records(3)
        self.assertEqual(snap['summary']['out_bytes'], len(a[2])+len(b[2])+len(c[2]))
        self.assertEqual(len(self.up.hits), 0)

    def test_stop_closes_keepalive_and_cancels_pending_headers(self):
        key = self.issue('stop')['key']
        idle = http.client.HTTPSConnection('127.0.0.1', self.port, context=self.context, timeout=4)
        idle.request('GET', '/portal/api/info')
        idle.getresponse().read()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.request, '/v1/chat/completions', {'model':'stall-headers'}, key)
            self.assertTrue(self.up.headers_waiting.wait(3))
            old = self.proxy.httpd
            start = time.monotonic()
            self.proxy.stop()
            self.assertLess(time.monotonic()-start, 2)
            self.assertEqual(old._workers, {})
            with self.assertRaises((OSError, http.client.HTTPException)):
                future.result()
        count = len(self.up.hits)
        with self.assertRaises((OSError, http.client.HTTPException)):
            idle.request('POST', '/v1/chat/completions', '{}', {'Authorization':'Bearer '+key})
            idle.getresponse().read()
        idle.close()
        self.assertEqual(len(self.up.hits), count)
        self.assertEqual(self.store.snapshot()['active'], 0)
        self.up.release_abort.set()


class ObserverUnit(unittest.TestCase):
    def test_usage_only_actual_values_and_bounded_parser(self):
        observer=runtime.UsageObserver(sse=True)
        raw=b'data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\r\n\r\n'
        for byte in raw: observer.feed(bytes([byte]))
        self.assertEqual(observer.finish(),dict(input_tokens=3,output_tokens=4,total_tokens=None))
        observer=runtime.UsageObserver(sse=True)
        observer.feed(b'data: '+b'x'*(runtime.MAX_CAPTURE+100))
        self.assertLessEqual(len(observer.buffer),runtime.MAX_CAPTURE)
        observer.feed(b'\n'+b'data: {"usage":{"total_tokens":9}}\n\n')
        self.assertEqual(observer.finish()['total_tokens'],9)

    def test_vpn_adapter_discovery_not_just_address_prefix(self):
        from types import SimpleNamespace
        with patch.object(runtime,'_vpn_cache',(0,[])), patch.object(runtime.os,'name','nt'), \
             patch.object(runtime.subprocess,'run',return_value=SimpleNamespace(stdout=b'"26.1.2.3"')) as run:
            self.assertEqual(runtime.radmin_ipv4s(refresh=True),['26.1.2.3'])
            script=run.call_args.args[0][-1]
            self.assertIn('InterfaceDescription',script);self.assertIn('Radmin',script)
        with patch.object(runtime,'_vpn_cache',(0,[])), patch.object(runtime.os,'name','nt'), \
             patch.object(runtime.subprocess,'run',return_value=SimpleNamespace(stdout=b'[]')):
            self.assertEqual(runtime.radmin_ipv4s(refresh=True),[])


if __name__=='__main__':
    unittest.main(verbosity=2)
