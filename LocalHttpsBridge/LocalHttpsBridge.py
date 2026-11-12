# -*- coding: utf-8 -*-
"""
LocalHttpsBridge — 本地 HTTP→HTTPS API 中转桥
================================================
把一个只支持 HTTP 的局域网 API 包装成本地 HTTPS 入口:
  外部软件 ──HTTPS──> 本桥(自签证书) ──HTTP──> 你的后端 API

功能:
  1. 填入后端 HTTP API 地址与 Key,一键测试连通性
  2. 启动本地 HTTPS 反向代理(自动生成含本机 IP SAN 的自签证书)
  3. 可选 Key 替换:对外暴露一个新 Key,转发时替换为真实 Key
  4. 一键安装证书到 Windows 系统信任库(需 UAC)
  5. 三种界面:Web 控制台(默认) / 传统桌面 GUI(--tk) / 无界面 headless

用法(Web 控制台,推荐): python LocalHttpsBridge.py
  自动打开浏览器 http://127.0.0.1:8765/?t=<一次性令牌>
用法(传统桌面 GUI):     python LocalHttpsBridge.py --tk
用法(无界面):           python LocalHttpsBridge.py --headless --backend http://192.168.1.50:8080 [--port 8443]
仅依赖:Python 3.8+ 标准库 + cryptography(生成证书)
"""

import argparse
import collections
import datetime
import hashlib
import ipaddress
import json
import os
import queue
import secrets
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from bridge_runtime import BoundedHTTPServer, radmin_ipv4s
import webbrowser

# ---------------------------------------------------------------------------
# 运行目录解析:PyInstaller onefile 打包后 __file__ 位于临时解压目录,
# 证书等持久化文件必须落在 EXE 同级目录,否则每次运行都会重新生成证书,
# 已安装到系统信任区的旧证书将失效。故打包态统一改用 sys.executable 所在目录。
# ---------------------------------------------------------------------------

APP_DIR = (os.path.dirname(os.path.abspath(sys.executable))
           if getattr(sys, "frozen", False)
           else os.path.dirname(os.path.abspath(__file__)))

_FORM_FIELDS = ("backend", "backend_key", "external_key", "port", "replace")


def _atomic_json_write(path, data):
    """同目录临时文件 + 原子替换,避免断电或并发请求留下半份配置。"""
    import tempfile
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=os.path.dirname(path),
                                         prefix=".bridge-", suffix=".tmp", delete=False) as f:
            temp_path = f.name
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)


def _acquire_instance_lock():
    """操作系统文件锁:进程退出/崩溃会自动释放,并发双击也只有一个主实例。"""
    handle = open(os.path.join(APP_DIR, "instance.lock"), "a+b")
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b"0")
        handle.flush()
    handle.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError:
        handle.close()
        return None


def set_autostart(enabled):
    """仅操作当前用户的本程序 Run 项,不需要管理员权限。"""
    import winreg
    if getattr(sys, "frozen", False):
        command = f'"{sys.executable}" --startup'
    else:
        pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        program = pythonw if os.path.isfile(pythonw) else sys.executable
        command = f'"{program}" "{os.path.abspath(__file__)}" --startup'
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                          r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
        if enabled:
            winreg.SetValueEx(key, "LocalHttpsBridge", 0, winreg.REG_SZ, command)
        else:
            try:
                winreg.DeleteValue(key, "LocalHttpsBridge")
            except FileNotFoundError:
                pass

# ---------------------------------------------------------------------------
# 证书生成(cryptography 优先,失败则回退到 openssl 可执行文件)
# ---------------------------------------------------------------------------

def local_ipv4s():
    """枚举本机所有可用 IPv4(含 127.0.0.1 与默认出口 IP)。"""
    ips = {"127.0.0.1"}
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("169.254."):
                ips.add(ip)
    except Exception:
        pass
    return sorted(ips)


def _gen_cert_cryptography(cert_file, key_file, ips, dns_names):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "LocalHttpsBridge")])
    san = [x509.DNSName(d) for d in dns_names] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, None, None), True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    with open(cert_file, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(key_file, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    return True


def _find_openssl():
    candidates = [
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Git", "usr", "bin", "openssl.exe"),
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Git", "mingw64", "bin", "openssl.exe"),
        r"C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
        "openssl",
    ]
    for c in candidates:
        try:
            subprocess.run([c, "version"], capture_output=True, timeout=5, check=True)
            return c
        except Exception:
            continue
    return None


def _gen_cert_openssl(cert_file, key_file, ips, dns_names):
    exe = _find_openssl()
    if not exe:
        return False
    san = ",".join([f"DNS:{d}" for d in dns_names] + [f"IP:{i}" for i in ips])
    cmd = [
        exe, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key_file, "-out", cert_file,
        "-days", "3650", "-subj", "/CN=LocalHttpsBridge",
        "-addext", f"subjectAltName={san}",
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        "-addext", "subjectKeyIdentifier=hash",
        "-addext", "extendedKeyUsage=serverAuth",
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=20, check=True)
        return True
    except Exception:
        return False


def ensure_certificate(cert_dir):
    """固定信任根:兼容沿用旧版 CA:TRUE 证书,IP 变化不轮换信任根。"""
    os.makedirs(cert_dir, exist_ok=True)
    cert_file = os.path.join(cert_dir, "bridge_cert.pem")
    key_file = os.path.join(cert_dir, "bridge_key.pem")
    ips = local_ipv4s()
    if os.path.exists(cert_file) or os.path.exists(key_file):
        try:
            check_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            check_ctx.load_cert_chain(cert_file, key_file)
            cert = ssl._ssl._test_decode_cert(cert_file)
            now = time.time()
            if not (ssl.cert_time_to_seconds(cert["notBefore"]) <= now <
                    ssl.cert_time_to_seconds(cert["notAfter"]) - 86400):
                raise ValueError("根证书已过期或即将过期")
            return cert_file, key_file, ips
        except (OSError, ValueError, ssl.SSLError, KeyError, AttributeError) as e:
            raise RuntimeError("固定根证书无效或私钥不匹配;请恢复 certs 备份。"
                               "若需更换信任根,须在所有客户端重新导入,程序不会自动替换。") from e
    ok = False
    try:
        ok = _gen_cert_cryptography(cert_file, key_file, ips, ["localhost"])
    except ImportError:
        pass
    if not ok:
        ok = _gen_cert_openssl(cert_file, key_file, ips, ["localhost"])
    if not ok:
        raise RuntimeError("无法生成证书:请先 `pip install cryptography`,或安装 Git for Windows(自带 openssl)。")
    return cert_file, key_file, ips


def ensure_server_certificate(cert_dir, ca_file, ca_key_file, ips):
    """服务证书可随 SAN 更新;始终由同一个固定信任根签发。"""
    server_file = os.path.join(cert_dir, "bridge_server.pem")
    server_key = os.path.join(cert_dir, "bridge_server_key.pem")
    required = {("DNS", "localhost")} | {("IP Address", ip) for ip in ips}
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(server_file, server_key)
        cert = ssl._ssl._test_decode_cert(server_file)
        now = time.time()
        valid = (ssl.cert_time_to_seconds(cert["notBefore"]) <= now <
                 ssl.cert_time_to_seconds(cert["notAfter"]) - 86400 and
                 required.issubset(set(cert.get("subjectAltName", ()))))
    except (OSError, ValueError, ssl.SSLError, KeyError):
        valid = False
    try:
        from cryptography import x509
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
        from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    except ImportError:
        exe = _find_openssl()
        if valid and exe:
            result = subprocess.run([exe, "verify", "-CAfile", ca_file, "-purpose", "sslserver",
                                     server_file], capture_output=True, timeout=10)
            if result.returncode == 0:
                return server_file, server_key
        if not exe:
            raise RuntimeError("无法签发服务证书:需要 cryptography 或 openssl。")
        import tempfile
        with tempfile.TemporaryDirectory(dir=cert_dir) as tmp:
            csr = os.path.join(tmp, "server.csr")
            ext = os.path.join(tmp, "server.ext")
            with open(ext, "w", encoding="ascii") as f:
                f.write("basicConstraints=critical,CA:FALSE\n"
                        "keyUsage=critical,digitalSignature,keyEncipherment\n"
                        "extendedKeyUsage=serverAuth\n"
                        "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n"
                        "subjectAltName=DNS:localhost," + ",".join("IP:" + ip for ip in ips) + "\n")
            commands = [
                [exe, "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", server_key,
                 "-out", csr, "-subj", "/CN=LocalHttpsBridge Server"],
                [exe, "x509", "-req", "-in", csr, "-CA", ca_file, "-CAkey", ca_key_file,
                 "-set_serial", "0x" + secrets.token_hex(16), "-days", "365", "-sha256",
                 "-extfile", ext, "-out", server_file],
            ]
            for command in commands:
                subprocess.run(command, capture_output=True, timeout=20, check=True)
        return server_file, server_key
    with open(ca_file, "rb") as f:
        ca = x509.load_pem_x509_certificate(f.read())
    if not ca.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
        raise RuntimeError("固定根证书不是 CA 证书,无法签发服务证书。")
    if valid:
        try:
            with open(server_file, "rb") as f:
                leaf = x509.load_pem_x509_certificate(f.read())
            if leaf.issuer != ca.subject:
                raise ValueError("签发者不匹配")
            ca.public_key().verify(leaf.signature, leaf.tbs_certificate_bytes,
                                   padding.PKCS1v15(), leaf.signature_hash_algorithm)
            return server_file, server_key
        except (OSError, ValueError, InvalidSignature):
            pass  # 仅重签服务证书,固定信任根保持不变。
    with open(ca_key_file, "rb") as f:
        ca_key = serialization.load_pem_private_key(f.read(), password=None)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_expiry = datetime.datetime.fromtimestamp(
        ssl.cert_time_to_seconds(ssl._ssl._test_decode_cert(ca_file)["notAfter"]),
        datetime.timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "LocalHttpsBridge Server")]))
            .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(min(now + datetime.timedelta(days=365), ca_expiry))
            .add_extension(x509.SubjectAlternativeName(
                [x509.DNSName("localhost")] + [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]), False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
            .add_extension(x509.KeyUsage(True, False, True, False, False, False, False, None, None), True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), False)
            .sign(ca_key, hashes.SHA256()))
    with open(server_key, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM,
                                 serialization.PrivateFormat.TraditionalOpenSSL,
                                 serialization.NoEncryption()))
    with open(server_file, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    return server_file, server_key

def public_certificate_pem(cert_file):
    """重新编码第一张公开证书,不把文件中夹带的私钥或其他证书对外发送。"""
    with open(cert_file, "r", encoding="ascii") as f:
        text = f.read()
    start = text.index("-----BEGIN CERTIFICATE-----")
    end = text.index("-----END CERTIFICATE-----", start) + len("-----END CERTIFICATE-----")
    der = ssl.PEM_cert_to_DER_cert(text[start:end])
    return ssl.DER_cert_to_PEM_cert(der).encode("ascii")


def cert_fingerprint(cert_file):
    """固定根证书 SHA-256 指纹(大写 64 位十六进制)。"""
    try:
        der = ssl.PEM_cert_to_DER_cert(public_certificate_pem(cert_file).decode("ascii"))
        return hashlib.sha256(der).hexdigest().upper()
    except (OSError, ValueError):
        return ""


# ---------------------------------------------------------------------------
# HTTPS 反向代理
# ---------------------------------------------------------------------------

HOP_HEADERS = {"host", "content-length", "transfer-encoding", "connection",
               "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "upgrade"}
KEY_HEADERS = {"authorization", "x-api-key", "api-key", "x-goog-api-key", "x-auth-token"}


def _join_upstream(backend, path):
    """拼接上游地址;后端已带 /v1 而请求路径也以 /v1 开头时自动去重,
    防止拼出 /v1/v1/models 这类 404(目标软件「获取模型列表失败」的头号原因)。"""
    base = backend.rstrip("/")
    p = path or "/"
    if base.endswith("/v1") and (p == "/v1" or p.startswith("/v1/")):
        base = base[:-3]
    return base + p

def _replace_key(value, external_key, backend_key):
    """把头值里出现的对外 Key 替换为真实 Key(支持 Bearer 前缀与裸值)。"""
    if not external_key:
        return value
    if external_key in value:
        return value.replace(external_key, backend_key or "")
    return value


def _normalise_chat_frame(lines, finished, stats):
    """仅修正已 stop 的候选后重复出现的空 delta(上游 usage 占位格式)。
    不修改真实文本、错误、其他终止原因,不补造 stop / [DONE]。"""
    original = b"".join(lines)
    data_lines = [line[5:].lstrip(b" ").rstrip(b"\r\n")
                  for line in lines if line.startswith(b"data:")]
    try:
        data = json.loads(b"\n".join(data_lines).decode("utf-8"))
    except (ValueError, UnicodeError):
        return original
    if not isinstance(data, dict) or data.get("error"):
        return original
    choices = data.get("choices")
    if not isinstance(choices, list):
        return original
    kept, removed = [], 0
    for choice in choices:
        if not isinstance(choice, dict):
            kept.append(choice)
            continue
        index = choice.get("index")
        empty_tail = (isinstance(index, int) and not isinstance(index, bool) and
                      index in finished and choice.get("delta") == {} and
                      choice.get("finish_reason") in (None, "stop") and
                      set(choice).issubset({"index", "delta", "finish_reason", "logprobs"}) and
                      choice.get("logprobs") is None)
        if empty_tail:
            removed += 1
        else:
            kept.append(choice)
    for choice in choices:
        if (isinstance(choice, dict) and isinstance(choice.get("index"), int) and
                choice.get("finish_reason") == "stop"):
            finished.add(choice["index"])
    if not removed:
        return original
    stats["normalised"] = stats.get("normalised", 0) + removed
    data["choices"] = kept
    newline = b"\r\n" if any(line.endswith(b"\r\n") for line in lines) else b"\n"
    replacement = b"data: " + json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + newline
    result, inserted = [], False
    for line in lines:
        if line.startswith(b"data:"):
            if not inserted:
                result.append(replacement)
                inserted = True
        else:
            result.append(line)
    return b"".join(result)


def _chat_sse_chunks(resp, stats, deadline=None):
    """逐事件转发,不缓存整段流;EOF 残帧原样传递,不伪造成功终态。"""
    frame, finished = [], set()
    while True:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("探测超时")
            try:
                resp.fp.raw._sock.settimeout(remaining)
            except AttributeError:
                pass
        line = resp.readline(2 * 1024 * 1024 + 1)
        if len(line) > 2 * 1024 * 1024 or sum(map(len, frame)) + len(line) > 2 * 1024 * 1024:
            raise ValueError("SSE 单事件超过 2 MiB 限制")
        if not line:
            break
        if line.startswith(b":") and not frame:
            yield line  # heartbeat 立即转发
            continue
        frame.append(line)
        if line in (b"\n", b"\r\n"):
            yield _normalise_chat_frame(frame, finished, stats)
            frame = []
    if frame:
        yield b"".join(frame)



def make_handler(cfg, log_fn):
    from bridge_runtime import make_proxy_handler
    return make_proxy_handler(cfg, log_fn, _join_upstream, _chat_sse_chunks)


class BridgeServer:
    """HTTPS 代理服务器封装。"""

    def __init__(self, backend, port, backend_key=None, external_key=None,
                 replace_key=True, cert_dir=None, log_fn=print, timeout=300, store=None,
                 admin=None, console_html=None, enabled=True):
        self.backend = backend
        self.port = port
        self.backend_key = backend_key
        self.external_key = external_key
        self.replace_key = replace_key
        self.cert_dir = cert_dir or os.path.join(APP_DIR, "certs")
        self.log_fn = log_fn
        self.timeout = timeout
        self.httpd = None
        self.thread = None
        self.cert_file = None
        self.ips = []
        self.store = store
        self.vpn_ips = []
        self.admin = admin
        self.console_html = console_html
        self.enabled = enabled
        self.cfg = {}

    def start(self):
        from http.server import ThreadingHTTPServer
        if self.httpd:
            raise RuntimeError("代理已在运行")
        self.cert_file, key_file, self.ips = ensure_certificate(self.cert_dir)
        self.server_cert_file, server_key = ensure_server_certificate(
            self.cert_dir, self.cert_file, key_file, self.ips)
        self.vpn_ips = radmin_ipv4s()
        cfg = {
            "backend": self.backend,
            "backend_key": self.backend_key,
            "external_key": self.external_key,
            "replace_key": self.replace_key,
            "timeout": self.timeout,
            "public_cert": public_certificate_pem(self.cert_file),
            "cert_fp": cert_fingerprint(self.cert_file),
            "store": self.store,
            "vpn_ips": self.vpn_ips,
            "capacity": 8,
            "cert_file": self.cert_file,
            "admin": self.admin, "console_html": self.console_html, "enabled": self.enabled,
        }
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(self.server_cert_file, server_key)
        self.httpd = BoundedHTTPServer(("0.0.0.0", self.port), make_handler(cfg, self.log_fn), tls_context=ctx)
        self.port = self.httpd.server_port
        self.cfg = cfg
        self.httpd.proxy_cfg = dict(cfg)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return self

    def reconfigure(self, backend, backend_key, external_key, replace_key):
        settings = dict(self.cfg, backend=backend, backend_key=backend_key,
                        external_key=external_key, replace_key=replace_key, enabled=True)
        self.httpd.configure(settings)
        self.cfg = settings
        self.backend, self.backend_key = backend, backend_key
        self.external_key, self.replace_key = external_key, replace_key
        self.enabled = True

    def pause(self):
        self.enabled = False
        self.cfg = dict(self.cfg, enabled=False)
        if self.httpd:
            self.httpd.configure(self.cfg)

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None
            self.thread = None

    def urls(self):
        ordered = list(dict.fromkeys(getattr(self, "vpn_ips", []) + self.ips))
        return [f"https://{ip}:{self.port}" for ip in ordered]

    @property
    def running(self):
        return self.httpd is not None and self.enabled

    @property
    def listening(self):
        return self.httpd is not None


# ---------------------------------------------------------------------------
# 连通性测试
# ---------------------------------------------------------------------------

def test_backend(backend, api_key=None, timeout=10):
    """对后端发一个探测请求。返回 dict(result, status, ms, snippet, error)。"""
    backend = backend.rstrip("/") + "/"
    headers = {}
    if api_key:
        if api_key.lower().startswith("bearer "):
            headers["Authorization"] = api_key
        else:
            headers["Authorization"] = "Bearer " + api_key
            headers["x-api-key"] = api_key
    req = urllib.request.Request(backend, headers=headers, method="GET")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            snippet = resp.read(400).decode("utf-8", "replace")
            return {"result": "ok", "status": resp.status,
                    "ms": int((time.time() - t0) * 1000), "snippet": snippet, "error": ""}
    except urllib.error.HTTPError as e:
        # 任何 HTTP 状态码(401/403/404)都说明网络层是通的
        try:
            snippet = e.read(400).decode("utf-8", "replace")
        except Exception:
            snippet = ""
        return {"result": "reachable", "status": e.code,
                "ms": int((time.time() - t0) * 1000), "snippet": snippet, "error": ""}
    except Exception as e:
        return {"result": "fail", "status": 0, "ms": int((time.time() - t0) * 1000),
                "snippet": "", "error": str(e)}


def _fetch_models(backend, api_key=None, timeout=10):
    """请求 GET {backend}/v1/models(_join_upstream 自动去重 /v1),尽力解析模型名列表。
    与连通性探测解耦:取不到模型只降级为提示文案,不影响连通性结论。"""
    url = _join_upstream(backend, "/v1/models")
    headers = {}
    if api_key:
        if api_key.lower().startswith("bearer "):
            headers["Authorization"] = api_key
        else:
            headers["Authorization"] = "Bearer " + api_key
            headers["x-api-key"] = api_key
    req = urllib.request.Request(url, headers=headers, method="GET")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(1 << 20).decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        hint = {401: "Key 无效或未授权", 403: "Key 无权访问模型列表",
                404: "后端未提供 /v1/models 接口"}.get(e.code, f"HTTP {e.code}")
        return {"models": [], "note": f"后端可达,但取模型列表失败({hint})"}
    except Exception as e:
        return {"models": [], "note": f"取模型列表失败:{e}"}
    ms = int((time.time() - t0) * 1000)
    names = []
    try:
        data = json.loads(raw)
        arr = data.get("data") if isinstance(data, dict) else data
        if not isinstance(arr, list) and isinstance(data, dict):
            arr = data.get("models")
        if isinstance(arr, list):
            for it in arr:
                if isinstance(it, str):
                    names.append(it)
                elif isinstance(it, dict):
                    v = it.get("id") or it.get("name") or it.get("model")
                    if isinstance(v, str) and v:
                        names.append(v)
    except Exception:
        pass
    seen, uniq = set(), []
    for n in names:
        if n not in seen:
            seen.add(n)
            uniq.append(n)
    total = len(uniq)
    uniq = uniq[:100]
    if not uniq:
        return {"models": [],
                "note": "后端可达,但 /v1/models 返回里没有可识别的模型名"}
    note = f"GET {url} · HTTP {status} · {ms}ms"
    if total > 100:
        note += f" · 仅显示前 100 个(共 {total})"
    return {"models": uniq, "note": note}


# ---------------------------------------------------------------------------
# 视觉能力探测(测试连通性时对模型列表顺带进行)
# ---------------------------------------------------------------------------

VISION_PROBE_MAX = 30
VISION_PROBE_WORKERS = 5
VISION_PROBE_TIMEOUT = 90  # 与 NeoRead 默认视觉检测等待上限一致
VISION_PROMPT = "Inspect the attached image. It contains one horizontal row of 8 colored squares. Reply with exactly 8 uppercase color names in left-to-right order, separated by single spaces. Allowed names: RED BLUE GREEN YELLOW. No punctuation or tools."


def _vision_challenge():
    """生成与 NeoRead 相同布局/配色的随机 800x140 PNG,答案仅留在本地。"""
    import base64
    import struct
    import zlib
    colors = [(230, 30, 30), (25, 70, 235), (30, 175, 65), (245, 210, 20)]
    names = ["RED", "BLUE", "GREEN", "YELLOW"]
    choices = [v % 4 for v in secrets.token_bytes(8)]
    white = b"\x00" + b"\xff" * (800 * 3)
    middle = bytearray(white)
    for i, c in enumerate(choices):
        middle[1 + (i * 100 + 10) * 3:1 + (i * 100 + 90) * 3] = bytes(colors[c]) * 80

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    pixels = white * 30 + bytes(middle) * 80 + white * 30
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 800, 140, 8, 2, 0, 0, 0)) +
           chunk(b"IDAT", zlib.compress(pixels, 9)) + chunk(b"IEND", b""))
    return base64.b64encode(png).decode("ascii"), " ".join(names[c] for c in choices)


def _read_chat_probe(resp, deadline):
    """按 NeoRead Chat 检测规则验收完整 SSE,只接收 index=0 的最终文本。"""
    text, finished = [], False
    for frame in _chat_sse_chunks(resp, {}, deadline):
        if not frame.endswith((b"\n\n", b"\r\n\r\n")):
            continue  # EOF 残帧不能充当完整事件
        data = b"\n".join(line[5:].lstrip(b" ") for line in frame.splitlines()
                           if line.startswith(b"data:"))
        if not data:
            continue
        if data == b"[DONE]":
            answer = "".join(text)
            if finished and answer.strip():
                return answer
            raise ValueError("SSE 缺少成功终态或文字")
        try:
            obj = json.loads(data.decode("utf-8"))
        except (ValueError, UnicodeError):
            raise ValueError("SSE 事件格式无效") from None
        if not isinstance(obj, dict):
            raise ValueError("SSE 事件格式无效")
        if obj.get("error") is not None or (obj.get("base_resp") or {}).get("status_code", 0):
            raise ValueError("上游在 SSE 流中返回错误")
        choices, selected = obj.get("choices", []), False
        if not isinstance(choices, list):
            raise ValueError("SSE 候选格式无效")
        for choice in choices:
            if not isinstance(choice, dict) or choice.get("index") is None:
                raise ValueError("SSE 缺少候选编号")
            if choice["index"] != 0:
                continue
            if selected or finished:
                raise ValueError("SSE 重复候选或终态后仍有内容")
            selected = True
            delta = choice.get("delta") or {}
            if not isinstance(delta, dict):
                raise ValueError("SSE delta 格式无效")
            if (delta.get("refusal") or delta.get("tool_calls") is not None or
                    delta.get("function_call") is not None):
                raise ValueError("SSE 返回拒绝或工具调用")
            content = delta.get("content")
            if content is not None:
                if not isinstance(content, str):
                    raise ValueError("SSE 文字格式无效")
                text.append(content)
            reason = choice.get("finish_reason")
            if reason is not None:
                if reason != "stop":
                    raise ValueError("SSE 未正常完成回答")
                finished = True
    raise ValueError("SSE 缺少完整的 stop + [DONE] 终态")


def _vision_probe(model, backend, api_key=None, timeout=VISION_PROBE_TIMEOUT):
    """真实八色块识图 + 流式终态校验;HTTP 200 本身不算视觉通过。"""
    import re
    image, expected = _vision_challenge()
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a reading assistant. Do not use tools, read files, browse, or execute commands."},
            {"role": "user", "content": [
                {"type": "text", "text": VISION_PROMPT},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + image}},
            ]},
        ],
        "stream": True, "n": 1, "stream_options": {"include_usage": True},
        "reasoning_effort": "medium",
    }
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream", "Accept-Encoding": "identity"}
    if api_key:
        headers["Authorization"] = api_key if api_key.lower().startswith("bearer ") else "Bearer " + api_key
    req = urllib.request.Request(_join_upstream(backend, "/v1/chat/completions"),
                                 data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if "text/event-stream" not in (resp.headers.get("Content-Type") or "").lower():
                return None, "后端未返回 SSE 流,不符合 NeoRead 检测协议"
            answer = _read_chat_probe(resp, started + timeout)
        actual = " ".join(re.findall(r"\b(?:red|blue|green|yellow)\b", answer.upper(), re.I))
        if actual != expected:
            return False, "识图回答与随机八色块顺序不符"
        return True, f"八色块识图与 SSE 终态通过 · {int((time.monotonic() - started) * 1000)}ms"
    except urllib.error.HTTPError as e:
        with e:
            err = e.read(4096).decode("utf-8", "replace").lower()
        image_words = ("image", "vision", "multimodal", "multi-modal", "图像", "图片")
        if e.code in (400, 404, 422, 501) and any(word in err for word in image_words):
            return False, f"HTTP {e.code} 后端拒绝图像请求"
        return None, f"HTTP {e.code}(鉴权、模型或接口异常,未判定视觉能力)"
    except (socket.timeout, TimeoutError):
        return None, "探测超时"
    except ValueError as e:
        return None, str(e)  # 本地校验器的固定错误,不回显上游内容
    except Exception as e:
        return None, type(e).__name__


def _test_vision(models, backend, api_key=None,
                 max_n=VISION_PROBE_MAX, workers=VISION_PROBE_WORKERS,
                 timeout=VISION_PROBE_TIMEOUT):
    """并发对模型列表做视觉探测。返回 (vision, note):
    vision=[{"id":模型名,"ok":True/False/None,"note":"判定依据"}],note 为汇总文案。"""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    sel = [m for m in models if isinstance(m, str) and m][:max_n]
    if not sel:
        return [], ""
    results = {m: {"id": m, "ok": None, "note": "未测"} for m in sel}

    def run(m):
        return m, _vision_probe(m, backend, api_key, timeout)

    try:
        workers = min(workers, len(sel))
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(run, m) for m in sel]
            batches = (len(sel) + workers - 1) // workers
            try:
                for f in as_completed(futs, timeout=timeout * (batches + 1)):
                    try:
                        m, (okv, note) = f.result()
                        results[m] = {"id": m, "ok": okv, "note": note}
                    except Exception:
                        pass
            except Exception:
                pass  # 超过总时限:剩余模型保持“未测”
    except Exception:
        pass
    vision = [results[m] for m in sel]
    n_ok = sum(1 for v in vision if v["ok"] is True)
    n_no = sum(1 for v in vision if v["ok"] is False)
    note = f"视觉探测:支持 {n_ok} · 不支持 {n_no} · 未判定 {len(vision) - n_ok - n_no}"
    if len(models) > len(sel):
        note += f"(仅探测前 {len(sel)} 个)"
    return vision, note


# ---------------------------------------------------------------------------
# Windows 证书安装
# ---------------------------------------------------------------------------

def install_cert_windows(cert_file):
    """把证书装入 CurrentUser\\Root(免 UAC);失败则尝试 LocalMachine(弹 UAC)。"""
    try:
        r = subprocess.run(
            ["certutil", "-user", "-addstore", "Root", cert_file],
            capture_output=True, timeout=15,
        )
        if r.returncode == 0:
            return True, "已安装到当前用户信任库(免重启生效)。"
    except Exception:
        pass
    try:
        ps = ("Start-Process certutil -Verb RunAs -Wait -ArgumentList "
              f"'-addstore','-f','Root','{cert_file}'")
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, timeout=60)
        if r.returncode == 0:
            return True, "已通过管理员权限安装到本机信任库。"
        return False, "管理员安装被取消或失败。"
    except Exception as e:
        return False, f"安装失败:{e}"


# ---------------------------------------------------------------------------
# Web 控制台(默认模式:127.0.0.1 + 一次性 token,浏览器打开)
# ---------------------------------------------------------------------------

WEB_INDEX_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LocalHttpsBridge · 控制台</title>
<style>
:root{--bg:#f4f7fb;--card:#ffffff;--line:#e2e8f2;--txt:#1b2537;--dim:#67748e;
--ac:#0891b2;--ac2:#7c3aed;--ok:#10b981;--bad:#ef4444}
*{box-sizing:border-box}
body{margin:0;color:var(--txt);min-height:100vh;
font-family:"Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;
background:radial-gradient(1100px 520px at 85% -10%,rgba(124,58,237,.08),transparent),
radial-gradient(900px 480px at -10% 110%,rgba(8,145,178,.07),transparent),var(--bg)}
.wrap{max-width:900px;margin:0 auto;padding:26px 18px 70px}
header{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.logo{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;font-size:23px;
background:linear-gradient(135deg,var(--ac),var(--ac2));box-shadow:0 8px 22px rgba(8,145,178,.26)}
h1{font-size:20px;margin:0;letter-spacing:.3px}
.sub{color:var(--dim);font-size:12.5px;margin-top:3px}
.pill{margin-left:auto;padding:6px 15px;border-radius:999px;font-size:12.5px;color:var(--dim);
border:1px solid var(--line);background:#fff;white-space:nowrap}
.pill.on{color:#fff;background:var(--ok);border-color:transparent;font-weight:700;animation:pu 2s infinite}
@keyframes pu{0%,100%{box-shadow:0 0 0 0 rgba(16,185,129,.45)}50%{box-shadow:0 0 0 8px rgba(16,185,129,0)}}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:18px;
box-shadow:0 1px 3px rgba(27,37,55,.05);transition:border .25s,box-shadow .25s}
.card h2{font-size:13px;margin:0 0 15px;color:var(--dim);font-weight:600;letter-spacing:.6px}
#resultCard.glow{border-color:rgba(8,145,178,.45);box-shadow:0 0 0 1px rgba(8,145,178,.22),0 14px 44px rgba(8,145,178,.12)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:680px){.grid{grid-template-columns:1fr}}
.f{display:flex;flex-direction:column;gap:6px}
.f.full{grid-column:1/-1}
.f label{font-size:12.5px;color:var(--dim)}
.row{display:flex;gap:8px;align-items:center}
input[type=text],input[type=password]{width:100%;padding:10px 12px;border-radius:10px;font-size:13.5px;
border:1px solid var(--line);background:#fff;color:var(--txt);outline:none;transition:border .15s,box-shadow .15s}
input:focus{border-color:var(--ac);box-shadow:0 0 0 3px rgba(8,145,178,.13)}
.switch{display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none}
.sw{position:relative;width:44px;height:24px;flex:none;background:#d5dde9;border-radius:999px;transition:.2s}
.sw:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;
box-shadow:0 1px 3px rgba(27,37,55,.25);transition:.2s}
.switch input{display:none}
.switch input:checked+.sw{background:linear-gradient(135deg,var(--ac),var(--ac2))}
.switch input:checked+.sw:after{left:23px;background:#fff}
.btn{padding:10px 20px;border-radius:10px;border:0;cursor:pointer;font-size:13.5px;font-weight:700;color:#fff;
background:linear-gradient(135deg,var(--ac),var(--ac2));transition:transform .1s,opacity .2s;
box-shadow:0 4px 14px rgba(8,145,178,.25)}
.btn:hover{transform:translateY(-1px)}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.btn.ghost{background:#fff;border:1px solid #d5dde9;color:var(--txt);box-shadow:none}
.btn.sm{padding:6px 13px;font-size:12px}
.btn.quit{background:#fff;border:1px solid #fda4af;color:#dc2626;box-shadow:none}
.btn.quit:hover{background:#fef2f3}
.actions{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.kv{margin-bottom:14px}
.kv .lab{font-size:12px;color:var(--dim);margin-bottom:7px;display:flex;justify-content:space-between;align-items:center}
.big{font-family:Consolas,"Cascadia Mono",monospace;font-size:16.5px;padding:13px 14px;border-radius:12px;
background:#f7fafd;border:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:10px;word-break:break-all}
.big .btn{flex:none}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:6px 11px;border-radius:8px;background:#fff;border:1px solid var(--line);color:var(--dim);
font-family:Consolas,monospace;font-size:12px;cursor:pointer;transition:.15s}
.chip:hover{color:var(--txt);border-color:#c6d2e3}
.chip.sel{color:var(--txt);border-color:var(--ac);box-shadow:0 0 0 1px rgba(8,145,178,.25);background:#eff9fc}
.tip{font-size:12px;color:var(--dim);line-height:1.8;margin-top:12px}
#log{background:#f7fafd;border:1px solid var(--line);border-radius:12px;padding:12px;height:210px;overflow:auto;
font:12px/1.65 Consolas,monospace;color:#46566e;white-space:pre-wrap;margin:0}
#placeholder{color:var(--dim);font-size:13px;text-align:center;padding:26px 10px;line-height:1.9}
.toast{position:fixed;bottom:28px;left:50%;transform:translate(-50%,18px);background:#fff;color:var(--txt);
border:1px solid var(--ac);padding:10px 22px;border-radius:11px;font-size:13px;opacity:0;transition:.25s;z-index:9;
pointer-events:none;max-width:80vw;box-shadow:0 12px 32px rgba(27,37,55,.18)}
.toast.show{opacity:1;transform:translate(-50%,0)}
a{color:var(--dim);text-decoration:none}
.mlab{font-size:12px;color:var(--dim);margin-bottom:8px}
.mchip{padding:5px 10px;border-radius:8px;background:#eff9fc;border:1px solid #bae6fd;color:#075985;
font-family:Consolas,monospace;font-size:12px;cursor:pointer;word-break:break-all}
.mchip:hover{border-color:#38bdf8;color:#0369a1;background:#e0f2fe}
.mchip.mv{background:#ecfdf5;border-color:#6ee7b7;color:#065f46}
.mchip.mv:hover{border-color:#10b981;background:#d1fae5;color:#065f46}
.mchip.mnv{opacity:.5}
.mlegend{font-size:12px;color:var(--dim);margin-top:8px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">🌉</div>
    <div><h1>LocalHttpsBridge</h1><div class="sub">HTTP API → 本地 HTTPS 中转 · Web 控制台</div></div>
    <div class="pill" id="pill">○ 已停止</div>
    <button class="btn quit sm" id="btnQuit" title="停止代理并退出整个程序">⏻ 退出</button>
  </header>

  <div class="card">
    <h2>① 后端配置(你的 HTTP API)</h2>
    <div class="grid">
      <div class="f full"><label>后端 API 地址(以 http:// 开头,支持带 /v1 等路径前缀)</label>
        <input type="text" id="backend" placeholder="http://192.168.1.50:8080/v1" spellcheck="false"></div>
      <div class="f"><label>后端 Key(真实) · <a href="javascript:;" id="eyeB">👁 显示</a></label>
        <input type="password" id="bkey" placeholder="sk-..." spellcheck="false"></div>
      <div class="f"><label>对外端口(HTTPS 监听)</label>
        <input type="text" id="port" value="8443" spellcheck="false"></div>
      <div class="f full"><label>对外 Key(可选 · 留空自动生成 lb_ 前缀新 Key)</label>
        <input type="text" id="ekey" placeholder="留空 = 自动生成" spellcheck="false"></div>
      <div class="f full">
        <label class="switch"><input type="checkbox" id="replace" checked><span class="sw"></span>
        <span>启用 Key 替换 —— 对外用新 Key,转发时自动换回真实 Key(推荐)</span></label>
      </div>
    </div>
    <div class="actions">
      <button class="btn ghost" id="btnTest">🔌 测试连通性</button>
      <button class="btn" id="btnStart">🚀 启动 HTTPS 代理</button>
      <button class="btn ghost" id="btnStop" disabled>⏹ 停止</button>
    </div>
    <div id="models" style="display:none;margin-top:16px">
      <div class="mlab">后端模型列表(GET /v1/models)· 共 <b id="mcount">0</b> 个 · 点击复制 · 👁=已通过视觉测试</div>
      <div class="chips" id="mchips"></div>
      <div class="mlegend" id="mlegend" style="display:none"></div>
      <div class="tip" id="mnote" style="margin-top:8px"></div>
    </div>
  </div>

  <div class="card" id="resultCard">
    <h2>② 对外接入信息 —— 把下面两项填进目标软件</h2>
    <div id="placeholder">代理未启动<br>填好上方配置 → 点「🚀 启动 HTTPS 代理」,这里会生成对外的 HTTPS 地址与 Key</div>
    <div id="resultBody" style="display:none">
      <div class="kv"><div class="lab"><span>对外 HTTPS API 地址</span></div>
        <div class="big"><span id="apiUrl"></span><button class="btn sm" id="btnCopyUrl">复制</button></div></div>
      <div class="kv"><div class="lab"><span id="keyLab">对外 Key</span><a href="javascript:;" id="eyeK">👁 显示</a></div>
        <div class="big"><span id="apiKey">...</span><button class="btn sm" id="btnCopyKey">复制</button></div></div>
      <div class="kv"><div class="lab"><span>全部可用地址(点选切换主地址)</span></div><div class="chips" id="chips"></div></div>
      <div class="tip"><a id="portalLink" target="_blank" rel="noreferrer">打开共享统计与 Key 门户</a><br><span id="vpnNotice"></span></div>
      <div class="kv" id="peerBox" style="display:none"><div class="lab"><span>其他电脑接入 —— 在对方电脑的 PowerShell 执行(下载并信任本机当前证书)</span><button class="btn sm ghost" id="btnCopyPeer">复制命令</button></div>
        <pre class="big" id="peerCmd" style="font-size:11.5px;line-height:1.55;white-space:pre-wrap;display:block;max-height:260px;overflow:auto"></pre>
        <div class="tip" id="certFp"></div></div>
      <button class="btn ghost sm" id="btnCert">🔒 安装证书到系统(目标软件报证书错误时点这个)</button>
      <div class="tip">· 局域网其他设备要用时,选对应网段的地址并在防火墙放行端口<br>· 私钥位于 certs/bridge_key.pem,请勿外传</div>
    </div>
  </div>

  <div class="card">
    <h2>③ 运行日志</h2>
    <pre id="log"></pre>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const el=id=>document.getElementById(id);
const REMOTE=window.BRIDGE_REMOTE_ADMIN===true;
const qs=new URLSearchParams(location.search);
let TOKEN=REMOTE?'':(qs.get('t')||localStorage.getItem('lhb_t')||'');
if(TOKEN&&!REMOTE)localStorage.setItem('lhb_t',TOKEN);
let selUrl='',realKey='',keyShown=false,tT=0,warnConn=false,warnTok=false;
function toast(m){const t=el('toast');t.textContent=m;t.classList.add('show');clearTimeout(tT);tT=setTimeout(()=>t.classList.remove('show'),2400)}
async function api(path,body){
  const url=REMOTE?path:path+(path.includes('?')?'&':'?')+'t='+encodeURIComponent(TOKEN);
  const headers=REMOTE?{'X-Bridge-Portal':'1'}:{'X-Bridge-Token':TOKEN};
  const opt=body?{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)}:{headers};
  opt.cache='no-store';opt.credentials='same-origin';opt.referrerPolicy='no-referrer';
  const r=await fetch(url,opt).catch(()=>null);
  if(!r){if(!warnConn){warnConn=true;toast('⚠ 连不上控制台:程序可能已退出,请重新双击 LocalHttpsBridge.exe')}throw 0}
  warnConn=false;
  if(r.status===401){if(!warnTok){warnTok=true;if(!REMOTE)localStorage.removeItem('lhb_t');toast('控制令牌失效:请关闭本页,重新双击 LocalHttpsBridge.exe 打开')}throw 0}
  warnTok=false;
  return r.json();
}
function copyTxt(txt,label){
  const done=()=>toast('已复制 '+(label||''));
  const fb=()=>{const ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');done()}catch(e){toast('复制失败,请手动选择')}ta.remove()};
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(txt).then(done).catch(fb)}else fb();
}
el('eyeB').onclick=()=>{const i=el('bkey');i.type=i.type==='password'?'text':'password';
  el('eyeB').textContent=i.type==='password'?'👁 显示':'🙈 隐藏'};
el('eyeK').onclick=()=>{keyShown=!keyShown;el('apiKey').style.filter=keyShown?'none':'blur(6px)';
  el('eyeK').textContent=keyShown?'🙈 隐藏':'👁 显示'};
el('btnTest').onclick=async()=>{const bt=el('btnTest');bt.disabled=true;
  const old='🔌 测试连通性';bt.textContent='🔎 测试中(含视觉)...';
  try{const r=await api('/api/test',{backend:el('backend').value,key:el('bkey').value,preserve_backend_key:REMOTE});
    if(r.ok){const nv=(r.vision||[]).filter(v=>v.ok===true).length;
      toast('✅ 可达 · HTTP '+r.status+' · '+r.ms+'ms'+((r.models&&r.models.length)?(' · '+r.models.length+' 个模型'+((r.vision&&r.vision.length)?(' · 👁 '+nv+' 个支持视觉'):'')):''))}
    else toast('❌ 不可达:'+(r.msg||r.error||'未知错误'));
    renderModels(r)}catch(e){renderModels(null)}
  bt.textContent=old;bt.disabled=false};
el('btnStart').onclick=async()=>{el('btnStart').disabled=true;
  try{const r=await api('/api/start',collectForm());
    if(!r.ok)toast('❌ '+(r.msg||'启动失败'));
    else if(r.pending&&r.redirect_url){toast('端口切换中,即将打开新地址');setTimeout(()=>location.assign(r.redirect_url),1800);return}
    else if(r.external_key&&!el('ekey').value)el('ekey').value=r.external_key;
  }catch(e){}setTimeout(refresh,250)};
el('btnStop').onclick=async()=>{try{await api('/api/stop',{})}catch(e){}refresh()};
el('btnCert').onclick=async()=>{if(REMOTE){const a=document.createElement('a');a.href='/cert';a.download='bridge_cert.pem';a.click();toast('下载根证书;请在当前客户端核对指纹后安装');return}try{const r=await api('/api/cert',{});toast((r.ok?'✅ ':'❌ ')+r.msg)}catch(e){}};
el('btnQuit').onclick=async()=>{if(!confirm('确定退出 LocalHttpsBridge?运行中的代理将一并停止。'))return;
  try{await api('/api/quit',{});toast('已退出,可关闭此页面')}catch(e){}
  el('pill').textContent='○ 已退出';el('pill').classList.remove('on')};
el('btnCopyUrl').onclick=()=>copyTxt(el('apiUrl').textContent,'HTTPS 地址');
el('btnCopyKey').onclick=()=>copyTxt(realKey,'Key');
el('btnCopyPeer').onclick=()=>copyTxt(el('peerCmd').textContent,'其他电脑接入命令');
let rootFp='';
function renderPeer(){
  el('peerBox').style.display='';
  el('certFp').textContent=rootFp?'固定根证书 SHA-256:'+rootFp+'(两台客户端应信任同一根证书)':'';
  const usable=selUrl&&!/https:\/\/(127\.|localhost(?:[:/]|$))/.test(selUrl)&&/^[A-F0-9]{64}$/.test(rootFp);
  el('btnCopyPeer').disabled=!usable;
  if(!usable){el('peerCmd').textContent='请先在上方点选对方可访问的地址(例如 Radmin VPN 地址),不要选 127.0.0.1。';return}
  el('peerCmd').textContent=`$p=Join-Path $env:TEMP ('lhb-'+[guid]::NewGuid()+'.pem')
try {
  curl.exe --noproxy "*" --fail --silent --show-error --max-time 15 -k -o $p "${selUrl}/cert"
  if($LASTEXITCODE -ne 0){throw 'Certificate download failed'}
  $c=[Security.Cryptography.X509Certificates.X509Certificate2]::new($p)
  $sha=[Security.Cryptography.SHA256]::Create()
  try {$raw=$c.RawData;$fp=[BitConverter]::ToString($sha.ComputeHash($raw)).Replace('-','')} finally {$sha.Dispose();$c.Dispose()}
  if($fp -ne '${rootFp}'){throw 'Certificate fingerprint mismatch'}
  [IO.File]::WriteAllBytes($p,$raw)
  certutil -user -addstore Root $p
  if($LASTEXITCODE -ne 0){throw 'Certificate import failed'}
} finally {Remove-Item -LiteralPath $p -ErrorAction SilentlyContinue}`;
}
function renderChips(urls){
  const c=el('chips');c.innerHTML='';
  urls.forEach(u=>{const d=document.createElement('div');d.className='chip'+(u===selUrl?' sel':'');d.textContent=u;
    d.onclick=()=>{selUrl=u;el('apiUrl').textContent=u;renderChips(urls)};c.appendChild(d)});
  renderPeer();
}
function renderModels(r){
  const box=el('models');
  if(!r||!r.ok){box.style.display='none';return}
  const list=r.models||[],note=r.models_note||'';
  if(!list.length&&!note){box.style.display='none';return}
  box.style.display='';
  el('mcount').textContent=String(list.length);
  el('mnote').textContent=note;
  const vmap={};let nOK=0,nNO=0,nUNK=0;
  (r.vision||[]).forEach(v=>{vmap[v.id]=v;
    if(v.ok===true)nOK++;else if(v.ok===false)nNO++;else nUNK++});
  const c=el('mchips');c.innerHTML='';
  list.forEach(m=>{const d=document.createElement('div');
    const v=vmap[m];let cls='mchip',pre='',ti='点击复制模型名';
    if(v){if(v.ok===true){cls+=' mv';pre='👁 ';ti='✅ 已通过视觉测试('+(v.note||'')+')· 点击复制'}
      else if(v.ok===false){cls+=' mnv';ti='❌ 视觉测试未通过:'+(v.note||'')+' · 点击复制'}
      else ti='⚠ 视觉未判定:'+(v.note||'')+' · 点击复制'}
    d.className=cls;d.textContent=pre+m;d.title=ti;
    d.onclick=()=>copyTxt(m,'模型名');c.appendChild(d)});
  const lg=el('mlegend');
  if((r.vision||[]).length){lg.style.display='';
    lg.textContent='👁 视觉探测:支持 '+nOK+' · 不支持 '+nNO+' · 未判定 '+nUNK+'(👁=支持图片输入,浅灰=不支持)'}
  else lg.style.display='none';
}
async function refresh(){
  let s;try{s=await api('/api/state')}catch(e){return}
  el('pill').textContent=s.running?'● 运行中':'○ 已停止';
  el('pill').classList.toggle('on',s.running);
  el('btnStart').disabled=s.running;
  el('btnStop').disabled=!s.running;
  el('resultCard').classList.toggle('glow',s.running);
  if(s.running||(REMOTE&&s.preferred_url)){
    if(!selUrl||!s.urls.includes(selUrl))selUrl=s.preferred_url||s.urls[0]||'';
    el('apiUrl').textContent=selUrl;
    realKey=s.replace?(s.external_key||''):'';
    el('keyLab').textContent=s.replace?'对外 Key(填进目标软件)':'透传模式(此处直接填你的真实 Key)';
    el('apiKey').textContent=s.replace?(s.external_key||''):'用你的真实 Key';
    el('apiKey').style.filter=(s.replace&&!keyShown)?'blur(6px)':'none';
    rootFp=s.cert_fp||'';
    renderChips(s.urls);
    const p=el('portalLink');p.href=(s.preferred_url||selUrl)+'/';p.textContent='打开共享统计与 Key 门户';
    el('vpnNotice').textContent=s.vpn_notice||'默认使用 Radmin VPN 地址;VPN 用户可在配置管理页操作';
    el('placeholder').style.display='none';el('resultBody').style.display='';
  }else{selUrl='';realKey='';el('resultBody').style.display='none';el('placeholder').style.display='';el('peerBox').style.display='none'}
}
async function pollLogs(){let r;try{r=await api('/api/logs')}catch(e){return}
  const pre=el('log');if(!r.lines||!r.lines.length)return;
  const stick=pre.scrollTop+pre.clientHeight>=pre.scrollHeight-12;
  pre.textContent=r.lines.join('\n');if(stick)pre.scrollTop=pre.scrollHeight}
let saveT=0;
function collectForm(){return{backend:el('backend').value,backend_key:el('bkey').value,preserve_backend_key:REMOTE,
  external_key:el('ekey').value,port:parseInt(el('port').value)||8443,replace:el('replace').checked}}
function saveNow(){clearTimeout(saveT);api('/api/form',collectForm()).catch(()=>{})}
function autoSave(){clearTimeout(saveT);saveT=setTimeout(saveNow,800)}
['backend','bkey','port','ekey'].forEach(id=>{el(id).addEventListener('input',autoSave);
  el(id).addEventListener('blur',saveNow);window.addEventListener('beforeunload',saveNow)});
el('replace').addEventListener('change',saveNow);
(async()=>{try{const r=await api('/api/form');const f=r.form||{};
  if(f.backend)el('backend').value=f.backend;
  if(f.backend_key)el('bkey').value=f.backend_key;
  if(REMOTE){el('bkey').placeholder=f.backend_key_configured?'已配置 · 留空保留,输入新值替换':'尚未配置后端 Key';el('btnCert').textContent='下载根证书'}
  if(f.external_key)el('ekey').value=f.external_key;
  if(f.port)el('port').value=f.port;
  if(typeof f.replace==='boolean')el('replace').checked=f.replace;
}catch(e){}})();
refresh();pollLogs();setInterval(()=>{refresh();pollLogs()},2000);
</script>
</body>
</html>
"""


class WebUIApp:
    """本地 Web 控制台:仅绑定 127.0.0.1 + 持久化 token,防止本机其他网页越权调用。"""

    @staticmethod
    def _load_or_create_token():
        """令牌持久化到 APP_DIR/web_token.txt:重启后控制台地址保持不变,
        旧标签页/收藏的地址继续有效;令牌仅用于防本机其他网页越权(CSRF)。"""
        path = os.path.join(APP_DIR, "web_token.txt")
        try:
            with open(path, "r", encoding="utf-8") as f:
                tok = f.read().strip()
            if tok and len(tok) >= 16:
                return tok
        except OSError:
            pass
        tok = secrets.token_urlsafe(16)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(tok)
        except OSError:
            pass  # 目录只读时退化为内存令牌(重启后地址会变)
        return tok

    def __init__(self, cert_dir=None):
        self.token = self._load_or_create_token()
        self.cert_dir = cert_dir or os.path.join(APP_DIR, "certs")
        self.config_path = os.path.join(APP_DIR, "config.json")
        self.lock = threading.Lock()
        self.config_lock = threading.RLock()
        self.control_lock = threading.RLock()
        self.control_revision = 0
        self.closing = False
        self.server = None
        self.portal_server = None
        self.portal_ready = threading.Event()
        self.logs = collections.deque(maxlen=300)
        self.httpd = None
        self.usage = None

    def log(self, msg):
        with self.lock:
            self.logs.append(f"{time.strftime('%H:%M:%S')} {msg}")

    def snapshot(self):
        srv = self.server or self.portal_server
        if not srv:
            return {"running": False, "urls": [], "replace": True, "port": None,
                    "backend": "", "external_key": "", "cert_file": "", "cert_fp": "", "preferred_url": ""}
        return {"running": bool(self.server and srv.running), "urls": srv.urls(), "replace": srv.replace_key,
                "port": srv.port, "backend": srv.backend,
                "external_key": srv.external_key or "", "cert_file": srv.cert_file or "",
                "cert_fp": cert_fingerprint(srv.cert_file),
                "vpn_available": bool(getattr(srv, "vpn_ips", [])),
                "preferred_url": self.public_url(),
                "vpn_notice": "" if getattr(srv, "vpn_ips", []) else "未检测到在线 Radmin VPN 网卡;门户仅本机可用"}

    def public_url(self):
        srv = self.portal_server or self.server
        if not srv or not getattr(srv, 'listening', srv.running):
            return ''
        host = next(iter(getattr(srv, 'vpn_ips', [])), '127.0.0.1')
        return f'https://{host}:{srv.port}'

    def console_page(self, remote=False):
        from portal_ui import console_shell
        return console_shell(WEB_INDEX_HTML, self.public_url(), remote=remote)

    def bootstrap(self):
        try:
            self.restore_proxy()
            self.ensure_portal()
        finally:
            self.portal_ready.set()

    def ensure_portal(self):
        with self.control_lock:
            if self.closing or self.portal_server:
                return
            try:
                with self.config_lock:
                    cfg = self._read_config()
                port = int(cfg.get('port') or 8443)
                if not 1 <= port <= 65535:
                    raise ValueError('invalid_port')
                if self.usage is None:
                    from bridge_store import UsageStore
                    self.usage = UsageStore(os.path.join(APP_DIR, 'usage.sqlite3'))
                srv = BridgeServer(cfg.get('backend') or '', port,
                                   backend_key=cfg.get('backend_key'), external_key=cfg.get('external_key'),
                                   replace_key=bool(cfg.get('replace', True)), cert_dir=self.cert_dir,
                                   log_fn=self.log, store=self.usage, admin=self.portal_api,
                                   console_html=lambda: self.console_page(True), enabled=False)
                srv.start()
                self.portal_server = srv
                self.log('共享门户已就绪;API 转发保持停止')
            except Exception as e:
                self.log('共享门户启动失败:' + type(e).__name__ + ',可使用本机备用控制台')

    def _remote_payload(self, payload, test=False):
        p = dict(payload)
        name = 'key' if test else 'backend_key'
        p[name] = (p.get(name) or '').strip()
        if not p.get(name) and p.get('preserve_backend_key') is True:
            p[name] = self._read_config().get('backend_key') or ''
        return p

    def _redact(self, value, extra=()):
        with self.config_lock:
            saved = self._read_config()
        secrets_to_hide = [self.token, saved.get('backend_key')] + list(extra)
        srv = self.server or self.portal_server
        if srv:
            secrets_to_hide.append(srv.backend_key)
        def clean(item):
            if isinstance(item, str):
                for secret in secrets_to_hide:
                    if secret:
                        item = item.replace(secret, '[已隐藏]')
                return item
            if isinstance(item, dict):
                return {k: clean(v) for k, v in item.items()}
            if isinstance(item, list):
                return [clean(v) for v in item]
            return item
        return clean(value)

    def portal_api(self, method, path, payload):
        # No local token or stored upstream credential is exported to VPN browsers.
        if method == 'GET':
            if path == '/api/state':
                data = self.snapshot()
                data.pop('cert_file', None)
                return 200, self._redact(data), None
            if path == '/api/form':
                data = self.api_form_load()
                form = data['form']
                form['backend_key_configured'] = bool(form.get('backend_key'))
                form['backend_key'] = ''
                return 200, self._redact(data), None
            if path == '/api/logs':
                with self.lock:
                    lines = list(self.logs)
                return 200, self._redact({'lines': lines}), None
        elif method == 'POST':
            if path == '/api/quit':
                return 200, {'ok': True}, self.request_quit
            if path == '/api/cert':
                return 200, {'ok': True, 'download_url': '/cert',
                             'msg': '下载根证书后在当前客户端确认指纹并安装;不会修改服务端信任'}, None
            if path == '/api/stop':
                return 200, self.api_stop(), None
            if path == '/api/test':
                with self.config_lock:
                    p = self._remote_payload(payload, test=True)
                return 200, self._redact(self.api_test(p), [p.get('key')]), None
            if path in ('/api/form', '/api/start'):
                with self.control_lock, self.config_lock:
                    p = self._remote_payload(payload)
                    if path == '/api/form':
                        return 200, self.api_form_save(p), None
                    port = int(p.get('port') or 8443)
                    if not 1 <= port <= 65535 or not str(p.get('backend', '')).lower().startswith('http://'):
                        return 400, {'ok': False, 'msg': '请检查后端地址与端口'}, None
                    if p.get('replace', True) and not p.get('backend_key'):
                        return 400, {'ok': False, 'msg': 'Key 替换模式需要后端真实 Key'}, None
                    srv = self.portal_server
                    if srv and srv.port != port:
                        try:
                            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                                if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                                probe.bind(('0.0.0.0', port))
                        except OSError:
                            return 409, {'ok': False, 'msg': '新端口被占用;原门户保持在线'}, None
                        self.control_revision += 1
                        ticket = self.control_revision
                        host = next(iter(getattr(srv, 'vpn_ips', [])), '127.0.0.1')
                        def restart():
                            with self.control_lock:
                                if self.closing or ticket != self.control_revision:
                                    return
                                result = self._start_proxy(p)
                                if not result['ok']:
                                    self.ensure_portal()
                        return 202, {'ok': True, 'pending': True,
                                     'redirect_url': f'https://{host}:{port}/console'}, restart
                    return 200, self._redact(self.api_start(p)), None
        return 404, {'ok': False, 'msg': '接口不存在'}, None

    def _read_config(self):
        try:
            with open(self.config_path, encoding="utf-8") as f:
                cfg = json.load(f)
        except FileNotFoundError:
            return {}
        if not isinstance(cfg, dict):
            raise ValueError("配置格式无效")
        return cfg

    def _update_config(self, changes):
        try:
            with self.config_lock:
                cfg = self._read_config()
                cfg.update(changes)
                _atomic_json_write(self.config_path, cfg)
            return True
        except Exception as e:
            self.log(f"⚠ 配置保存失败:{type(e).__name__},请检查目录权限或配置格式")
            return False

    def api_form_load(self):
        try:
            with self.config_lock:
                cfg = self._read_config()
            return {"ok": True, "form": {k: cfg[k] for k in _FORM_FIELDS if k in cfg}}
        except Exception as e:
            self.log(f"⚠ 读取已保存配置失败:{type(e).__name__}")
            return {"ok": True, "form": {}}

    def api_form_save(self, p):
        # 表单草稿和上次成功运行配置分开保存,输入防抖不会覆盖恢复状态。
        form = {
            "backend": (p.get("backend") or "").strip(),
            "backend_key": (p.get("backend_key") or "").strip(),
            "external_key": (p.get("external_key") or "").strip(),
            "port": p.get("port"),
            "replace": bool(p.get("replace", True)),
        }
        ok = self._update_config(form)
        return {"ok": ok, "msg": "" if ok else "配置保存失败,请检查目录权限或配置格式"}



    def api_test(self, p):
        backend = (p.get("backend") or "").strip()
        if not backend.lower().startswith("http://"):
            return {"ok": False, "msg": "后端地址必须以 http:// 开头"}
        key = (p.get("key") or "").strip() or None
        self.log(f"测试连通性: {backend}")
        r = test_backend(backend, key)
        r["ok"] = r["result"] != "fail"
        icon = "✅" if r["ok"] else "❌"
        extra = "" if r["ok"] else f" {r['error']}"
        self.log(f"{icon} {r['result']} HTTP={r['status']} {r['ms']}ms{extra}")
        if r["ok"]:
            m = _fetch_models(backend, key)
            r["models"] = m.get("models", [])
            r["models_note"] = m.get("note", "")
            if r["models"]:
                head = ", ".join(r["models"][:8])
                tail = " ..." if len(r["models"]) > 8 else ""
                self.log(f"📋 模型列表({len(r['models'])} 个):{head}{tail}")
            else:
                self.log(f"📋 未取到模型列表:{r['models_note']}")
            # 视觉能力探测:对每个模型发一条极小的图片请求,判定能否吃图
            r["vision"], r["vision_note"] = [], ""
            if r["models"]:
                self.log(f"👁 视觉探测中(每模型 1 次八色块流式识图,最多 {VISION_PROBE_MAX} 个)...")
                vision, vnote = _test_vision(r["models"], backend, key)
                r["vision"] = vision
                r["vision_note"] = vnote
                eyed = [v["id"] for v in vision if v.get("ok") is True]
                if eyed:
                    head2 = ", ".join(eyed[:8])
                    tail2 = " ..." if len(eyed) > 8 else ""
                    self.log(f"👁 支持视觉({len(eyed)} 个):{head2}{tail2}")
                else:
                    self.log(f"👁 无模型通过视觉探测:{vnote}")
        else:
            r["models"] = []
            r["models_note"] = ""
            r["vision"] = []
            r["vision_note"] = ""
        return r

    def api_start(self, p):
        with self.control_lock:
            self.control_revision += 1
            return self._start_proxy(p)

    def restore_proxy(self):
        with self.control_lock:
            if self.closing:
                return
            try:
                with self.config_lock:
                    runtime = self._read_config().get("_runtime", {})
                if not isinstance(runtime, dict) or runtime.get("running") is not True:
                    return
                active = runtime.get("proxy")
                if not isinstance(active, dict):
                    self.log("⚠ 没有可恢复的代理配置,请手动启动一次")
                    return
                result = self._start_proxy(active, restore=True)
                self.log("✅ 已恢复上次运行的代理" if result["ok"] else "⚠ 自动恢复失败,请检查运行日志")
            except Exception as e:
                self.log(f"⚠ 自动恢复失败:{type(e).__name__},可在控制台手动启动")

    def _start_proxy(self, p, restore=False):
        if self.closing:
            return {"ok": False, "msg": "程序正在退出"}
        backend = (p.get("backend") or "").strip()
        if not backend.lower().startswith("http://"):
            return {"ok": False, "msg": "后端地址必须以 http:// 开头"}
        try:
            port = int(p.get("port") or 8443)
        except (TypeError, ValueError):
            return {"ok": False, "msg": "端口必须是整数"}
        if not 1 <= port <= 65535:
            return {"ok": False, "msg": "端口必须在 1-65535"}
        replace = bool(p.get("replace", True))
        backend_key = (p.get("backend_key") or "").strip()
        external_key = (p.get("external_key") or "").strip()
        if replace:
            if not backend_key:
                return {"ok": False, "msg": "Key 替换模式需要后端真实 Key;或关闭 Key 替换改为透传"}
            if not external_key:
                external_key = "lb_" + secrets.token_urlsafe(24)
        else:
            external_key = ""
        if self.usage is None:
            from bridge_store import UsageStore
            self.usage = UsageStore(os.path.join(APP_DIR, "usage.sqlite3"))
        srv = self.portal_server
        try:
            if srv and getattr(srv, 'listening', False) and srv.port == port:
                srv.reconfigure(backend, backend_key or None, external_key or None, replace)
            else:
                srv = BridgeServer(
                    backend=backend, port=port, backend_key=backend_key or None,
                    external_key=external_key or None, replace_key=replace,
                    cert_dir=self.cert_dir, log_fn=self.log, store=self.usage,
                    admin=self.portal_api, console_html=lambda: self.console_page(True))
                srv.start()
                self.stop()  # New listener bound successfully; only now retire the old one.
        except (OSError, RuntimeError) as e:
            self.log('❌ 启动失败:' + type(e).__name__)
            return {"ok": False, "msg": "启动失败(端口被占用或权限不足),请查看日志"}
        self.portal_server = srv
        self.server = srv
        self.log(f"🚀 HTTPS 代理已启动:0.0.0.0:{port} → {backend}")
        self.log(f"   证书:{srv.cert_file}")
        active = {"backend": backend, "backend_key": backend_key,
                  "external_key": external_key, "port": port, "replace": replace}
        changes = {"_runtime": {"running": True, "proxy": active}}
        if not restore:
            changes.update(active)
        saved = self._update_config(changes)
        return {"ok": True, "urls": srv.urls(), "external_key": external_key,
                "port": port, "state_saved": saved}

    def stop(self):
        with self.control_lock:
            servers = {srv for srv in (self.server, self.portal_server) if srv}
            for srv in servers:
                srv.stop()
            self.server = self.portal_server = None

    def api_stop(self):
        with self.control_lock:
            self.control_revision += 1
            if self.server and hasattr(self.server, 'pause'):
                self.server.pause()
                self.server = None
            elif self.server:
                self.stop()
            saved = self._update_config({"_runtime": {"running": False}})
            self.log("⏹ 代理已停止,下次启动不再自动恢复")
            return {"ok": saved, "msg": "" if saved else "代理已停止,但运行状态保存失败"}

    def api_cert(self):
        cert = (self.server.cert_file if self.server and self.server.running
                else os.path.join(self.cert_dir, "bridge_cert.pem"))
        if not os.path.exists(cert):
            return {"ok": False, "msg": "请先启动一次代理以生成证书"}
        ok, msg = install_cert_windows(cert)
        self.log(("✅ " if ok else "❌ ") + msg)
        return {"ok": ok, "msg": msg}

    def request_quit(self):
        """退出本次进程,保留最后的代理开关状态供下次启动恢复。"""
        with self.control_lock:
            self.control_revision += 1
            self.closing = True
            self.log("⏻ 收到退出请求,控制台关闭中...")
            self.stop()
        threading.Timer(0.25, lambda: self.httpd and self.httpd.shutdown()).start()
        return {"ok": True}

    def make_handler(self):
        from http.server import BaseHTTPRequestHandler
        app = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt, *args):
                pass

            def _send(self, code, body, ctype="application/json; charset=utf-8"):
                data = body if isinstance(body, bytes) else body.encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)

            def _authed(self):
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                tok = (q.get("t") or [self.headers.get("X-Bridge-Token") or ""])[0]
                return tok == app.token

            def do_GET(self):
                path = urllib.parse.urlparse(self.path).path
                if path == "/":
                    return self._send(200, app.console_page(), "text/html; charset=utf-8")
                if path == "/favicon.ico":
                    return self._send(204, b"", "image/x-icon")
                if not self._authed():
                    return self._send(401, '{"ok":false,"msg":"token invalid"}')
                if path == "/api/ping":
                    return self._send(200, '{"ok":true,"app":"LocalHttpsBridge"}')
                if path == '/api/entry':
                    return self._send(200, json.dumps({'ready': app.portal_ready.is_set(), 'url': app.public_url()}))
                if path == "/api/state":
                    with app.lock:
                        snap = app.snapshot()
                    return self._send(200, json.dumps(snap, ensure_ascii=False))
                if path == "/api/logs":
                    with app.lock:
                        lines = list(app.logs)
                    return self._send(200, json.dumps({"lines": lines}, ensure_ascii=False))
                if path == "/api/form":
                    return self._send(200, json.dumps(app.api_form_load(), ensure_ascii=False))
                return self._send(404, '{"ok":false,"msg":"not found"}')

            def do_POST(self):
                path = urllib.parse.urlparse(self.path).path
                if not self._authed():
                    return self._send(401, '{"ok":false,"msg":"token invalid"}')
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    payload = json.loads(self.rfile.read(n) or b"{}")
                except Exception:
                    return self._send(400, '{"ok":false,"msg":"bad json"}')
                if path == "/api/test":
                    return self._send(200, json.dumps(app.api_test(payload), ensure_ascii=False))
                if path == "/api/start":
                    return self._send(200, json.dumps(app.api_start(payload), ensure_ascii=False))
                if path == "/api/stop":
                    return self._send(200, json.dumps(app.api_stop(), ensure_ascii=False))
                if path == "/api/cert":
                    return self._send(200, json.dumps(app.api_cert(), ensure_ascii=False))
                if path == "/api/quit":
                    return self._send(200, json.dumps(app.request_quit(), ensure_ascii=False))
                if path == "/api/form":
                    return self._send(200, json.dumps(app.api_form_save(payload), ensure_ascii=False))
                return self._send(404, '{"ok":false,"msg":"not found"}')

        return Handler


def _detect_existing_console(base, token):
    """本机直连快速探测,避免系统 HTTP 代理拖慢每次双击。"""
    import http.client
    ports = []
    try:
        with open(os.path.join(APP_DIR, "console.json"), encoding="utf-8") as f:
            cached = json.load(f).get("port")
        if isinstance(cached, int) and 1 <= cached <= 65535:
            ports.append(cached)
    except (OSError, ValueError, AttributeError):
        pass
    ports += [p for p in range(base, base + 10) if p not in ports]
    for port in ports:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=0.1)
        try:
            conn.request("GET", "/api/ping", headers={"X-Bridge-Token": token})
            response = conn.getresponse()
            data = response.read(4096)
            if response.status == 200 and json.loads(data).get("app") == "LocalHttpsBridge":
                return port
        except (OSError, ValueError, AttributeError, http.client.HTTPException):
            pass
        finally:
            conn.close()
    return None


def _open_console(port, token, no_browser):
    if no_browser:
        return
    import http.client
    url = f'http://127.0.0.1:{port}/?t={token}'
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=0.5)
        try:
            conn.request('GET', '/api/entry', headers={'X-Bridge-Token': token})
            response = conn.getresponse()
            data = json.loads(response.read(4096))
            if response.status != 200:
                break
            candidate = urllib.parse.urlsplit(data.get('url', ''))
            if candidate.scheme == 'https' and candidate.hostname and not candidate.query and not candidate.username:
                url = candidate.geturl() + '/'
                break
            if data.get('ready'):
                break
        except (OSError, ValueError, http.client.HTTPException):
            break
        finally:
            conn.close()
        time.sleep(0.1)
    try:
        webbrowser.open(url)
    except Exception:
        pass


def _console_port_candidates(base, config):
    """控制台不得抢占上次成功运行的 HTTPS 端口。"""
    runtime = config.get("_runtime", {})
    active = runtime.get("proxy", {}) if isinstance(runtime, dict) else {}
    reserved = None
    if (isinstance(runtime, dict) and runtime.get("running") is True and
            isinstance(active, dict)):
        value = active.get("port")
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65535:
            reserved = value
    return [port for port in range(base, min(base + 10, 65536)) if port != reserved]


def run_web(args):
    from http.server import ThreadingHTTPServer
    base = args.web_port or 8765
    no_browser = args.no_browser or getattr(args, "startup", False)
    guard = _acquire_instance_lock()
    if guard is None:
        # 第一实例可能仍在初始化:等待其就绪,不生成第二份 token/服务。
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                with open(os.path.join(APP_DIR, "web_token.txt"), encoding="utf-8") as f:
                    token = f.read().strip()
                port = _detect_existing_console(base, token)
                if port:
                    _open_console(port, token, no_browser)
                    return
            except OSError:
                pass
            time.sleep(0.1)
        return
    app, httpd = None, None
    try:
        app = WebUIApp()
        app.log("欢迎使用 LocalHttpsBridge · Web 控制台")
        try:
            with app.config_lock:
                saved = app._read_config()
        except (OSError, ValueError):
            saved = {}
        for port in _console_port_candidates(base, saved):
            try:
                httpd = ThreadingHTTPServer(("127.0.0.1", port), app.make_handler())
                break
            except OSError:
                continue
        if httpd is None:
            raise OSError("Web 控制台端口被占用,请用 --web-port 指定其他端口")
        app.httpd = httpd
        try:
            _atomic_json_write(os.path.join(APP_DIR, "console.json"), {"port": port})
        except OSError as e:
            app.log(f"⚠ 控制台端口缓存写入失败:{type(e).__name__},不影响服务运行")
        app.log(f"控制台已就绪:127.0.0.1:{port}")
        # UI 立即可用;恢复 HTTPS 代理不阻塞控制台启动。
        threading.Thread(target=app.bootstrap, daemon=True).start()
        if not no_browser:
            threading.Timer(0.05, _open_console, args=(port, app.token, False)).start()
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if app:
            with app.control_lock:
                app.closing = True
                app.stop()  # 退出不清除恢复意图;只有「停止代理」会取消恢复
        if httpd:
            httpd.server_close()
        if app and app.usage is not None:
            app.usage.close()
        guard.close()

# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------

def run_gui():
    import tkinter as tk
    from tkinter import scrolledtext, ttk

    CERT_DIR = os.path.join(APP_DIR, "certs")

    root = tk.Tk()
    root.title("LocalHttpsBridge — HTTP→HTTPS 本地中转")
    root.geometry("780x720")
    root.minsize(680, 620)

    logq = queue.Queue()

    def log(msg):
        stamp = time.strftime("%H:%M:%S")
        logq.put(f"{stamp}  {msg}")

    state = {"server": None}

    # ---- 输入区 ----
    frm_in = ttk.LabelFrame(root, text="① 后端信息(HTTP API)")
    frm_in.pack(fill="x", padx=10, pady=(10, 5))

    tk.Label(frm_in, text="后端 API 地址:").grid(row=0, column=0, sticky="w", padx=6, pady=4)
    var_backend = tk.StringVar(value="http://192.168.1.50:8080")
    ent_backend = ttk.Entry(frm_in, textvariable=var_backend, width=58)
    ent_backend.grid(row=0, column=1, columnspan=3, sticky="we", padx=6, pady=4)

    tk.Label(frm_in, text="后端 Key(真实):").grid(row=1, column=0, sticky="w", padx=6, pady=4)
    var_bkey = tk.StringVar()
    ent_bkey = ttk.Entry(frm_in, textvariable=var_bkey, width=58, show="*")
    ent_bkey.grid(row=1, column=1, columnspan=3, sticky="we", padx=6, pady=4)

    def _toggle_show():
        ent_bkey.configure(show="" if ent_bkey.cget("show") == "*" else "*")

    ttk.Checkbutton(frm_in, text="显示", command=_toggle_show).grid(row=1, column=4, padx=2)

    tk.Label(frm_in, text="对外端口:").grid(row=2, column=0, sticky="w", padx=6, pady=4)
    var_port = tk.StringVar(value="8443")
    ttk.Entry(frm_in, textvariable=var_port, width=10).grid(row=2, column=1, sticky="w", padx=6, pady=4)

    var_replace = tk.BooleanVar(value=True)
    ttk.Checkbutton(frm_in, text="启用 Key 替换(对外用新 Key,转发时换回真实 Key)",
                    variable=var_replace).grid(row=2, column=2, columnspan=2, sticky="w", padx=6)

    tk.Label(frm_in, text="对外 Key:").grid(row=3, column=0, sticky="w", padx=6, pady=4)
    var_ekey = tk.StringVar(value="lb_" + secrets.token_urlsafe(24))
    ttk.Entry(frm_in, textvariable=var_ekey, width=58).grid(row=3, column=1, columnspan=3, sticky="we", padx=6, pady=4)
    ttk.Button(frm_in, text="换一个", command=lambda: var_ekey.set("lb_" + secrets.token_urlsafe(24))
               ).grid(row=3, column=4, padx=2)
    frm_in.columnconfigure(1, weight=1)

    # ---- 操作区 ----
    frm_btn = ttk.Frame(root)
    frm_btn.pack(fill="x", padx=10, pady=5)
    btn_test = ttk.Button(frm_btn, text="② 测试连通性")
    btn_test.pack(side="left", padx=4)
    btn_start = ttk.Button(frm_btn, text="③ 启动 HTTPS 代理")
    btn_start.pack(side="left", padx=4)
    btn_stop = ttk.Button(frm_btn, text="停止", state="disabled")
    btn_stop.pack(side="left", padx=4)
    btn_cert = ttk.Button(frm_btn, text="安装证书到系统(推荐)")
    btn_cert.pack(side="right", padx=4)

    # ---- 结果区 ----
    frm_out = ttk.LabelFrame(root, text="对外接入信息(填到要求 HTTPS 的软件里)")
    frm_out.pack(fill="x", padx=10, pady=5)

    tk.Label(frm_out, text="HTTPS 地址:").grid(row=0, column=0, sticky="w", padx=6, pady=4)
    var_url = tk.StringVar(value="(未启动)")
    cmb_url = ttk.Combobox(frm_out, textvariable=var_url, state="readonly", width=46)
    cmb_url.grid(row=0, column=1, sticky="we", padx=6, pady=4)
    btn_copy_url = ttk.Button(frm_out, text="复制", command=lambda: _copy(var_url.get()))
    btn_copy_url.grid(row=0, column=2, padx=4)

    tk.Label(frm_out, text="对外 Key:").grid(row=1, column=0, sticky="w", padx=6, pady=4)
    var_ekey_out = tk.StringVar(value="(未启动)")
    tk.Label(frm_out, textvariable=var_ekey_out, wraplength=430, justify="left").grid(row=1, column=1, sticky="w", padx=6, pady=4)
    ttk.Button(frm_out, text="复制", command=lambda: _copy(var_ekey_out.get())).grid(row=1, column=2, padx=4)

    var_status = tk.StringVar(value="状态:未启动")
    tk.Label(frm_out, textvariable=var_status, foreground="#555").grid(row=2, column=0, columnspan=3, sticky="w", padx=6, pady=(0, 4))
    frm_out.columnconfigure(1, weight=1)

    # ---- 日志区 ----
    frm_log = ttk.LabelFrame(root, text="日志 / 连通性结果")
    frm_log.pack(fill="both", expand=True, padx=10, pady=(5, 10))
    txt = scrolledtext.ScrolledText(frm_log, height=16, state="disabled", font=("Consolas", 9))
    txt.pack(fill="both", expand=True, padx=6, pady=6)

    def _copy(s):
        root.clipboard_clear()
        root.clipboard_append(s)
        log(f"已复制: {s}")

    def flush_log():
        try:
            while True:
                line = logq.get_nowait()
                txt.configure(state="normal")
                txt.insert("end", line + "\n")
                txt.see("end")
                txt.configure(state="disabled")
        except queue.Empty:
            pass
        root.after(200, flush_log)

    def messagebox_warn(msg):
        from tkinter import messagebox
        messagebox.showwarning("LocalHttpsBridge", msg)
    # ---- 行为 ----
    def on_test():
        backend = var_backend.get().strip()
        if not backend.lower().startswith("http://"):
            messagebox_warn("后端地址必须以 http:// 开头")
            return
        log(f"测试连通性: {backend}")
        def work():
            r = test_backend(backend, var_bkey.get().strip() or None)
            if r["result"] == "ok":
                log(f"✅ 连通:HTTP {r['status']},耗时 {r['ms']} ms")
            elif r["result"] == "reachable":
                log(f"✅ 网络可达:HTTP {r['status']}(401/404 等也算通,说明服务在线)")
            else:
                log(f"❌ 不通:{r['error']}")
            if r["snippet"]:
                log(f"   响应片段: {r['snippet'][:200]}")
        threading.Thread(target=work, daemon=True).start()

    def on_start():
        backend = var_backend.get().strip()
        if not backend.lower().startswith("http://"):
            messagebox_warn("后端地址必须以 http:// 开头")
            return
        try:
            port = int(var_port.get().strip())
            if not (1 <= port <= 65535):
                raise ValueError
        except ValueError:
            messagebox_warn("端口必须是 1-65535 的整数")
            return
        try:
            srv = BridgeServer(
                backend=backend, port=port,
                backend_key=var_bkey.get().strip() or None,
                external_key=var_ekey.get().strip() or None,
                replace_key=var_replace.get(),
                cert_dir=CERT_DIR, log_fn=log,
            )
            srv.start()
        except OSError as e:
            messagebox_warn(f"启动失败(端口被占用或权限不足):{e}")
            return
        except Exception as e:
            messagebox_warn(f"启动失败:{e}")
            return
        state["server"] = srv
        urls = srv.urls()
        cmb_url["values"] = urls
        # 默认选中非 127 的地址
        pick = next((u for u in urls if "127.0.0.1" not in u), urls[-1] if urls else "")
        var_url.set(pick)
        if var_replace.get() and var_ekey.get().strip():
            var_ekey_out.set(var_ekey.get().strip())
        else:
            var_ekey_out.set("(透传模式:请直接填写你的真实 Key)")
        var_status.set(f"状态:运行中 — 监听 0.0.0.0:{port} → {backend}")
        btn_start.configure(state="disabled")
        btn_stop.configure(state="normal")
        log(f"🚀 HTTPS 代理已启动:0.0.0.0:{port} → {backend}")
        log(f"   证书:{srv.cert_file}")
        log(f"   可用地址:{'  '.join(urls)}")
        log("   若目标软件报证书错误,请点击右上『安装证书到系统』。")

    def on_stop():
        srv = state.get("server")
        if srv:
            srv.stop()
            state["server"] = None
        var_status.set("状态:已停止")
        var_url.set("(未启动)")
        var_ekey_out.set("(未启动)")
        btn_start.configure(state="normal")
        btn_stop.configure(state="disabled")
        log("⏹ 代理已停止")

    def on_cert():
        srv = state.get("server")
        cert = srv.cert_file if srv else os.path.join(CERT_DIR, "bridge_cert.pem")
        if not os.path.exists(cert):
            messagebox_warn("请先启动一次代理以生成证书")
            return
        log(f"安装证书:{cert}")
        ok, msg = install_cert_windows(cert)
        log(("✅ " if ok else "❌ ") + msg)

    btn_test.configure(command=on_test)
    btn_start.configure(command=on_start)
    btn_stop.configure(command=on_stop)
    btn_cert.configure(command=on_cert)

    log("欢迎使用 LocalHttpsBridge。")
    log("步骤:① 填后端 HTTP API 与 Key → ② 测试连通性 → ③ 启动代理 → 复制对外信息填入目标软件。")
    root.after(200, flush_log)
    root.protocol("WM_DELETE_WINDOW", lambda: (on_stop(), root.destroy()))
    root.mainloop()


# ---------------------------------------------------------------------------
# headless 模式
# ---------------------------------------------------------------------------

def run_headless(args):
    srv = BridgeServer(
        backend=args.backend, port=args.port,
        backend_key=args.backend_key, external_key=args.external_key,
        replace_key=not args.no_replace,
        log_fn=lambda m: print(time.strftime("%H:%M:%S"), m, flush=True),
    )
    srv.start()
    print("HTTPS 入口:", flush=True)
    for u in srv.urls():
        print("  ", u, flush=True)
    if not args.no_replace and args.external_key:
        print("对外 Key:", args.external_key, flush=True)
    print("证书:", srv.cert_file, flush=True)
    print("Ctrl+C 退出", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        srv.stop()
        print("已退出")


def main():
    ap = argparse.ArgumentParser(description="LocalHttpsBridge — HTTP→HTTPS 本地中转")
    ap.add_argument("--tk", action="store_true", help="使用旧版 tkinter 界面(默认为 Web 控制台)")
    ap.add_argument("--headless", action="store_true", help="无界面运行")
    ap.add_argument("--web-port", type=int, default=8765, help="Web 控制台端口(默认 8765,占用则自动+1)")
    ap.add_argument("--no-browser", action="store_true", help="Web 控制台不自动打开浏览器")
    ap.add_argument("--startup", action="store_true", help="登录时静默启动,恢复上次运行的代理")
    autorun = ap.add_mutually_exclusive_group()
    autorun.add_argument("--enable-autostart", action="store_true", help="启用当前用户登录自启后退出")
    autorun.add_argument("--disable-autostart", action="store_true", help="关闭当前用户登录自启后退出")
    ap.add_argument("--backend", help="后端 HTTP API 地址,如 http://192.168.1.50:8080/v1")
    ap.add_argument("--port", type=int, default=8443, help="HTTPS 监听端口(默认 8443)")
    ap.add_argument("--backend-key", default=None)
    ap.add_argument("--external-key", default=None)
    ap.add_argument("--no-replace", action="store_true", help="不做 Key 替换,原样透传")
    args = ap.parse_args()
    if args.enable_autostart or args.disable_autostart:
        set_autostart(args.enable_autostart)
        return
    if args.startup:
        args.no_browser = True
    if args.headless:
        if not args.backend:
            ap.error("--headless 需要 --backend")
        run_headless(args)
    elif args.tk:
        run_gui()
    else:
        run_web(args)


if __name__ == "__main__":
    main()
