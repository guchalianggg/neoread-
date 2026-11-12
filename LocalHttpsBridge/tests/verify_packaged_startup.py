"""Exercise a packaged fast build in isolation; never changes the user's autorun entry.
Usage: python -B LocalHttpsBridge/tests/verify_packaged_startup.py <path-to-exe>
Uses fake keys and a temporary app folder only. No real backend calls.
"""
from contextlib import contextmanager
import stat
import http.client
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path

import test_neoread_sse as fixtures

src = Path(sys.argv[1]).resolve()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
passed = 0
processes = []


def check(name, value):
    global passed
    if not value:
        raise AssertionError(name)
    passed += 1
    print('PASS ' + name, flush=True)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def kill(p):
    if p.poll() is None:
        subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        p.wait(timeout=15)


@contextmanager
def app_directory():
    with tempfile.TemporaryDirectory(dir=os.environ.get('PI_SCRATCH_DIR')) as directory:
        try:
            yield directory
        finally:
            for process in processes:
                kill(process)  # Release EXE/DLL handles before deleting the directory.


class Backend(fixtures.VisionBackend):
    auth = []
    def do_POST(self):
        self.auth.append(self.headers.get('Authorization'))
        super().do_POST()


fake = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
threading.Thread(target=fake.serve_forever, daemon=True).start()
try:
    with app_directory() as temp:
        temp = Path(temp)
        exe = temp / src.name
        shutil.copy2(src, exe)
        shutil.copytree(src.parent / '_internal', temp / '_internal')
        web_port, proxy_port = free_port(), free_port()
        base = 'http://127.0.0.1:%d' % web_port

        def launch():
            p = subprocess.Popen([str(exe), '--startup', '--web-port', str(web_port)],
                                 cwd=temp, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            processes.append(p)
            return p

        def wait_ready():
            global base
            end = time.monotonic() + 20
            while time.monotonic() < end:
                try:
                    token = (temp / 'web_token.txt').read_text().strip()
                    cached = json.loads((temp/'console.json').read_text(encoding='utf-8'))
                    base = 'http://127.0.0.1:%d' % cached['port']
                    req = urllib.request.Request(base + '/api/ping', headers={'X-Bridge-Token': token})
                    with opener.open(req, timeout=.5) as r:
                        if json.load(r).get('app') == 'LocalHttpsBridge':
                            return token
                except (OSError, ValueError):
                    time.sleep(.04)
            raise AssertionError('console readiness timeout')

        def api(path, body=None):
            data = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(base + path, data=data,
                    headers={'Content-Type': 'application/json', 'X-Bridge-Token': token})
            with opener.open(req, timeout=15) as r:
                return json.load(r)

        def wait_running(expected):
            end = time.monotonic() + 15
            while time.monotonic() < end:
                state = api('/api/state')
                if state['running'] is expected:
                    return state
                time.sleep(.05)
            raise AssertionError('proxy state readiness timeout')

        def quit_app(p):
            api('/api/quit', {})
            p.wait(timeout=15)

        p = launch()
        token = wait_ready()
        check('silent --startup makes console ready', p.poll() is None)
        check('no previous intent means no unexpected proxy', api('/api/state')['running'] is False)
        cfg = dict(backend='http://127.0.0.1:%d/v1' % fake.server_port,
                   backend_key='fixture-backend', external_key='lb_fixture-startup',
                   port=proxy_port, replace=True)
        check('manual start saves durable state', api('/api/start', cfg)['state_saved'])
        state = wait_running(True)
        cert = temp / 'certs/bridge_cert.pem'
        original_cert = cert.read_bytes()
        context = ssl.create_default_context(cafile=str(cert))
        image, expected = fixtures.bridge._vision_challenge()
        payload = {'model': 'valid', 'stream': True, 'messages': [{'role': 'user', 'content': [
                    {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + image}}]}]}
        conn = http.client.HTTPSConnection('127.0.0.1', proxy_port, context=context, timeout=5)
        conn.request('POST', '/v1/chat/completions', json.dumps(payload).encode(),
                     {'Content-Type': 'application/json', 'Authorization': 'Bearer lb_fixture-startup'})
        response = conn.getresponse()
        answer = fixtures.bridge._read_chat_probe(response, time.monotonic()+5)
        conn.close()
        check('vision/SSE compatibility preserved in fast build', answer == expected)
        check('key replacement preserved', Backend.auth[-1] == 'Bearer fixture-backend')
        draft = dict(cfg, backend='http://unactivated-draft.invalid', port=9999)
        check('draft can be saved while proxy runs', api('/api/form', draft)['ok'])
        quit_app(p)

        p = launch()
        check('console token survives restart', wait_ready() == token)
        state = wait_running(True)
        check('automatic restore uses last active config, not draft',
              state['backend'] == cfg['backend'] and state['port'] == proxy_port)
        check('automatic restore preserves external key', state['external_key'] == cfg['external_key'])
        check('certificate remains trusted after automatic restore', cert.read_bytes() == original_cert)
        check('automatic restore preserves draft form', api('/api/form')['form']['backend'] == draft['backend'])

        # Duplicate launches must reuse the live instance, including alternate base ports.
        started = time.monotonic()
        duplicates = [subprocess.Popen([str(exe), '--startup', '--web-port', str(free_port())],
                       cwd=temp, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(3)]
        processes.extend(duplicates)
        for duplicate in duplicates:
            duplicate.wait(timeout=10)
        check('three duplicate launches exit instead of creating servers',
              all(d.returncode == 0 for d in duplicates) and p.poll() is None)
        check('cached console reuse finishes within 5 seconds', time.monotonic()-started < 5)

        # Simulate an unclean process loss; durable intent must have been saved already.
        kill(p)
        p = launch()
        wait_ready()
        check('forced-process-loss restart restores proxy', wait_running(True)['port'] == proxy_port)
        check('explicit stop persists disabled intent', api('/api/stop', {})['ok'])
        quit_app(p)
        p = launch()
        wait_ready()
        check('stopped proxy does not restart on next login launch', api('/api/state')['running'] is False)
        quit_app(p)

        # Race two cold launches; there must be exactly one surviving primary process.
        racers = [launch(), launch()]
        wait_ready()
        end = time.monotonic()+8
        while time.monotonic() < end and sum(r.poll() is None for r in racers) != 1:
            time.sleep(.1)
        live = [r for r in racers if r.poll() is None]
        check('concurrent cold launches yield exactly one primary', len(live) == 1)
        quit_app(live[0])
        for r in racers:
            r.wait(timeout=10)
        # Default web port equals the last successful HTTPS port: avoid stealing it.
        collision = dict(cfg, port=web_port)
        settings = json.loads((temp/'config.json').read_text(encoding='utf-8'))
        settings['_runtime'] = {'running': True, 'proxy': collision}
        fixtures.bridge._atomic_json_write(str(temp/'config.json'), settings)
        p = launch()
        wait_ready()
        check('console avoids port reserved for restored HTTPS proxy', wait_running(True)['port'] == web_port)
        quit_app(p)

        # An optional, read-only console cache must not prevent the app from running.
        cache = temp/'console.json'
        cache.chmod(stat.S_IREAD)
        try:
            p = launch()
            wait_ready()
            check('read-only console cache does not stop proxy restoration', wait_running(True)['port'] == web_port)
            check('read-only cache failure is visible in logs', any('缓存写入失败' in s for s in api('/api/logs')['lines']))
            quit_app(p)
        finally:
            cache.chmod(stat.S_IREAD | stat.S_IWRITE)

        check('all isolated app processes exited', all(p.poll() is not None for p in processes))
        print('PACKAGED_STARTUP_RESULT: %d passed' % passed, flush=True)
finally:
    for p in processes:
        kill(p)
    fake.shutdown()
    fake.server_close()
