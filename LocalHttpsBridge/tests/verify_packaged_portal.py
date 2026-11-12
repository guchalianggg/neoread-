"""Real packaged EXE portal/restart checks; isolated copies, fixture upstream only.
Usage: python -B LocalHttpsBridge/tests/verify_packaged_portal.py <exe>
No production configuration/credentials or system trust changes are used.
"""
import concurrent.futures
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge_runtime import radmin_ipv4s
from test_portal_integration import FakeUpstream


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main():
    src = Path(sys.argv[1]).resolve()
    passed = 0
    processes = []
    def check(name, value):
        nonlocal passed
        if not value:
            raise AssertionError(name)
        passed += 1
        print('PASS '+name, flush=True)
    up = ThreadingHTTPServer(('127.0.0.1', 0), FakeUpstream)
    up.hits, up.active = [], 0
    up.lock = threading.Lock()
    up.two_active = threading.Event()
    up.release_abort = threading.Event()
    up.headers_waiting = threading.Event()
    threading.Thread(target=up.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(dir=os.environ.get('PI_SCRATCH_DIR')) as tmp:
            tmp = Path(tmp)
            exe = tmp / src.name
            shutil.copy2(src, exe)
            shutil.copytree(src.parent/'_internal', tmp/'_internal')
            web, port = free_port(), free_port()
            vpn = radmin_ipv4s()
            host = vpn[0] if vpn else '127.0.0.1'
            token = None
            context = None
            def launch():
                p = subprocess.Popen([str(exe), '--startup', '--web-port', str(web)], cwd=tmp,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                processes.append(p)
                return p
            def console(path, body=None):
                raw = json.dumps(body).encode() if body is not None else None
                c = http.client.HTTPConnection('127.0.0.1', web, timeout=10)
                try:
                    c.request('POST' if body is not None else 'GET', path, raw,
                              {'X-Bridge-Token':token or '', 'Content-Type':'application/json'})
                    r = c.getresponse()
                    return json.loads(r.read())
                finally:
                    c.close()
            def ready(running=None):
                nonlocal token
                end = time.monotonic()+25
                while time.monotonic()<end:
                    try:
                        token = (tmp/'web_token.txt').read_text().strip()
                        s = console('/api/state')
                        if running is None or s['running'] is running:
                            return s
                    except (OSError, ValueError, http.client.HTTPException):
                        pass
                    time.sleep(.05)
                raise AssertionError('EXE readiness timeout')
            def request(path, data=None, key=None, target=host, extra_headers=None):
                raw = json.dumps(data).encode() if data is not None else None
                headers = {'Content-Type':'application/json', 'X-Bridge-Portal':'1'}
                if key:
                    headers['Authorization'] = 'Bearer '+key
                headers.update(extra_headers or {})
                c = http.client.HTTPSConnection(target, port, context=context, timeout=18)
                try:
                    c.request('POST' if data is not None else 'GET', path, raw, headers)
                    r = c.getresponse()
                    output = r.read()
                    try:
                        parsed = json.loads(output)
                    except ValueError:
                        parsed = output
                    return r.status, parsed, output
                finally:
                    c.close()
            def stop(p):
                console('/api/quit', {})
                p.wait(timeout=15)
            try:
                p = launch(); ready(False)
                cfg = dict(backend='http://127.0.0.1:%d/v1'%up.server_port, backend_key='fixture-upstream-secret',
                           external_key='lb_fixture_packaged', replace=False, port=port)
                check('EXE starts fixture proxy in legacy passthrough mode', console('/api/start', cfg)['ok'])
                state = ready(True)
                context = ssl.create_default_context(cafile=str(tmp/'certs/bridge_cert.pem'))
                check('actual Radmin is preferred after start', state['preferred_url']=='https://%s:%d'%(host,port))
                root_hash = hashlib.sha256((tmp/'certs/bridge_cert.pem').read_bytes()).hexdigest()
                root_key_hash = hashlib.sha256((tmp/'certs/bridge_key.pem').read_bytes()).hexdigest()
                page = request('/')
                check('bundled portal module serves real Chinese HTML', page[0]==200 and '共享接入门户'.encode() in page[2])
                check('loopback remains available', request('/portal/api/info', target='127.0.0.1')[0]==200)
                check('VPN portal contains no backend configuration', request('/portal/api/info')[0]==200 and b'fixture-upstream-secret' not in request('/portal/api/info')[2])
                check('all navigation pages and migrated console served by EXE', all(request(path)[0]==200 for path in ('/portal/devices','/portal/keys','/portal/requests','/console')))
                form=request('/api/form')
                check('remote form masks saved backend key', form[0]==200 and form[1]['form']['backend_key']=='' and form[1]['form']['backend_key_configured'] and b'fixture-upstream-secret' not in form[2])
                check('remote management denies cross-origin requests', request('/api/stop',{},extra_headers={'Origin':'https://other.invalid'})[0]==403)
                check('EXE entry points to VPN portal without control token', console('/api/entry')['url']==state['preferred_url'] and token not in console('/api/entry')['url'])
                check('remote stop leaves portal and configuration online', request('/api/stop',{})[1]['ok'] and request('/')[0]==200 and not request('/api/state')[1]['running'])
                check('paused forwarding returns 503 without upstream', request('/v1/models')[0]==503 and len(up.hits)==0)
                masked=dict(cfg,backend_key='',preserve_backend_key=True)
                check('remote save preserves the existing upstream key', request('/api/form',masked)[1]['ok'] and console('/api/form')['form']['backend_key']=='fixture-upstream-secret')
                check('remote start resumes forwarding', request('/api/start',masked)[1]['ok'] and request('/api/state')[1]['running'])
                check('remote certificate action is a client download', request('/api/cert',{})[1]['download_url']=='/cert')
                ca = request('/cert')[2]
                check('download is one public root, no key', ca.count(b'BEGIN CERTIFICATE')==1 and b'PRIVATE KEY' not in ca)
                a = request('/portal/api/keys', {'label':'packaged A'})[1]
                b = request('/portal/api/keys', {'label':'packaged B'})[1]
                check('independent keys issued from real EXE', a['key']!=b['key'] and a['key'].startswith('lbp_'))
                def call(item):
                    k,m=item
                    return request('/v1/chat/completions', {'model':m, 'messages':[{'content':'PRIVATE_PROMPT_MARKER'}]}, k)
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    results=list(pool.map(call, [(a['key'],'pack-A'),(b['key'],'pack-B')]))
                check('two independent VPN clients isolate JSON responses', [r[1]['model'] for r in results]==['pack-A','pack-B'])
                check('new keys replace upstream key despite passthrough setting', [h[1] for h in up.hits]==['Bearer fixture-upstream-secret']*2)
                check('legacy backend credential remains compatible', call(('fixture-upstream-secret','legacy'))[0]==200)
                check('key revocation succeeds', request('/portal/api/revoke', {'id':a['id']})[0]==200)
                hits=len(up.hits)
                check('revoked/invalid return 401 without upstream', all(call((k,'rejected'))[0]==401 for k in (a['key'],'lbp_invalid')) and len(up.hits)==hits)
                end=time.monotonic()+3
                while time.monotonic()<end:
                    stats=request('/portal/api/stats')[1]
                    if stats['summary']['requests']==5: break
                    time.sleep(.02)
                check('packaged metadata exact once with byte counts and usage', stats['summary']['requests']==5 and stats['summary']['success']==3 and stats['summary']['failed']==2 and stats['summary']['total_tokens']==21 and stats['summary']['out_bytes']>0)
                check('portal lists omit all complete keys and body markers', all(secret.encode() not in request('/portal/api/keys')[2]+request('/portal/api/stats')[2] for secret in (a['key'],b['key'],'fixture-upstream-secret','PRIVATE_PROMPT_MARKER','PRIVATE_RESPONSE_MARKER')))
                stop(p)
                p=launch(); restored=ready(True)
                check('root and root private key unchanged after EXE restore', root_hash==hashlib.sha256((tmp/'certs/bridge_cert.pem').read_bytes()).hexdigest() and root_key_hash==hashlib.sha256((tmp/'certs/bridge_key.pem').read_bytes()).hexdigest())
                check('VPN default restored after EXE restart', restored['preferred_url']==state['preferred_url'])
                after=request('/portal/api/stats')[1]
                check('persistent usage unchanged across process restart', after['summary']==stats['summary'])
                listing=request('/portal/api/keys')[1]['keys']
                check('issued key and revocation state survive process restart', len(listing)==2 and next(k for k in listing if k['id']==a['id'])['revoked'] and not next(k for k in listing if k['id']==b['id'])['revoked'])
                hits=len(up.hits)
                check('revocation enforced after restart', call((a['key'],'revoked-after'))[0]==401 and len(up.hits)==hits)
                check('remaining key usable after restart', call((b['key'],'valid-after'))[0]==200)
                check('remote quit replies before closing packaged process', request('/api/quit',{})[1]['ok'])
                p.wait(timeout=15)
                print('PACKAGED_PORTAL %d/%d PASS HOST=%s'%(passed,passed,host),flush=True)
            finally:
                for p in processes:
                    if p.poll() is None:
                        subprocess.run(['taskkill','/PID',str(p.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                        p.wait(timeout=15)
    finally:
        up.shutdown();up.server_close()


if __name__=='__main__':
    main()
