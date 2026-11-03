#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""shot —— 手机摄像头变焦测试服务（临时，可完整卸载）

仅使用 Python 标准库，无第三方依赖。

目录约定（--root）:
    <root>/app           本程序与静态文件
    <root>/tls/fullchain.pem + privkey.pem   证书（由 bin/sync-cert.sh 从 Caddy 同步）
    <root>/logs/...      收集到的日志
    <root>/config.json   {"admin_token": "..."}
"""

from __future__ import annotations

import argparse
import hmac
import html
import io
import json
import os
import re
import ssl
import sys
import threading
import time
import zipfile
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

MAX_JSON = 2 * 1024 * 1024      # 单次日志上报上限
MAX_FRAME = 8 * 1024 * 1024     # 单张照片上限
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,96}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CERT_RECHECK_SEC = 20

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
}


def iso_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def log(msg: str) -> None:
    print(f"{iso_now()} {msg}", flush=True)


class CamServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def __init__(self, addr, handler, root: str, certfile: str | None, keyfile: str | None):
        self.root = os.path.abspath(root)
        self.certfile = certfile
        self.keyfile = keyfile
        self._ctx: ssl.SSLContext | None = None
        self._ctx_stamp = None
        self._ctx_checked = 0.0
        self._ctx_lock = threading.Lock()
        self.logs_dir = os.path.join(self.root, "logs")
        self.static_dir = os.path.join(self.root, "app", "static")
        os.makedirs(self.logs_dir, exist_ok=True)
        self.admin_token = self._load_token()
        super().__init__(addr, handler)

    # ---- 证书热加载 -------------------------------------------------
    def _load_token(self) -> str:
        cfg = os.path.join(self.root, "config.json")
        try:
            with open(cfg, "r", encoding="utf-8") as f:
                token = json.load(f).get("admin_token", "")
            if token:
                return token
        except Exception:
            pass
        token = os.environ.get("SHOT_ADMIN_TOKEN") or "change-me"
        log(f"WARN: 未读到 {cfg} 中的 admin_token，使用环境变量/默认值")
        return token

    def _cert_stamp(self):
        try:
            st = os.stat(self.certfile)
            kst = os.stat(self.keyfile)
            return (st.st_mtime_ns, st.st_size, kst.st_mtime_ns, kst.st_size)
        except OSError:
            return None

    def tls_context(self) -> ssl.SSLContext | None:
        if not self.certfile:
            return None
        now = time.time()
        if self._ctx is not None and now - self._ctx_checked < CERT_RECHECK_SEC:
            return self._ctx
        with self._ctx_lock:
            if self._ctx is not None and time.time() - self._ctx_checked < CERT_RECHECK_SEC:
                return self._ctx
            stamp = self._cert_stamp()
            if stamp is not None and stamp != self._ctx_stamp:
                ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                ctx.minimum_version = ssl.TLSVersion.TLSv1_2
                ctx.set_alpn_protocols(["http/1.1"])
                ctx.load_cert_chain(self.certfile, self.keyfile)
                self._ctx = ctx
                self._ctx_stamp = stamp
                log(f"TLS 证书已加载/更新: {self.certfile}")
            self._ctx_checked = time.time()
        if self._ctx is None:
            log("ERROR: 证书不可用，拒绝连接")
        return self._ctx

    def get_request(self):
        """接受连接并完成 TLS 握手（失败不影响主循环）。"""
        if not self.certfile:  # 本地调试：纯 HTTP
            sock, addr = self.socket.accept()
            sock.settimeout(60)
            return sock, addr
        while True:
            sock, addr = self.socket.accept()
            ctx = self.tls_context()
            if ctx is None:
                try:
                    sock.close()
                except OSError:
                    pass
                continue
            try:
                sock.settimeout(15)
                conn = ctx.wrap_socket(sock, server_side=True)
                conn.settimeout(60)
                return conn, addr
            except (ssl.SSLError, OSError):
                try:
                    sock.close()
                except OSError:
                    pass
                continue


class Handler(BaseHTTPRequestHandler):
    server_version = "shot/1.0"
    protocol_version = "HTTP/1.1"
    server: CamServer

    # ---- 基础工具 ---------------------------------------------------
    def log_message(self, fmt, *args):  # 精简访问日志
        sys.stderr.write("%s %s %s\n" % (iso_now(), self.address_string(), fmt % args))

    def _send(self, code: int, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, code: int, obj, extra=None):
        self._send(code, json.dumps(obj, ensure_ascii=False), extra=extra)

    def _read_body(self, limit: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return b""
        if length > limit:
            raise ValueError(f"body too large: {length}")
        return self.rfile.read(length)

    def _qs(self):
        return parse_qs(urlparse(self.path).query)

    def _token_ok(self) -> bool:
        q = self._qs()
        token = (q.get("token") or [""])[0]
        if not token:
            cookie = self.headers.get("Cookie") or ""
            m = re.search(r"(?:^|;\s*)shot_admin=([^;]+)", cookie)
            token = m.group(1) if m else ""
        return bool(token) and hmac.compare_digest(token, self.server.admin_token)

    # ---- 路由 -------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                return self._serve_static("index.html")
            if path == "/healthz":
                return self._send(200, "ok", "text/plain; charset=utf-8")
            if path == "/favicon.ico":
                return self._send(204, b"", "image/x-icon")
            if path.startswith("/static/"):
                return self._serve_static(path[len("/static/"):])
            if path == "/admin":
                return self._admin_page()
            if path == "/admin/session":
                return self._admin_session()
            if path == "/admin/zip":
                return self._admin_zip()
            if path == "/admin/login":
                return self._admin_login()
            return self._send(404, "not found", "text/plain; charset=utf-8")
        except Exception as exc:  # 兜底，避免线程崩溃无输出
            log(f"ERROR GET {path}: {exc!r}")
            return self._send(500, "server error", "text/plain; charset=utf-8")

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/log":
                return self._api_log()
            if path == "/api/frame":
                return self._api_frame()
            return self._send(404, "not found", "text/plain; charset=utf-8")
        except ValueError as exc:
            return self._json(413, {"ok": False, "error": str(exc)})
        except Exception as exc:
            log(f"ERROR POST {path}: {exc!r}")
            return self._json(500, {"ok": False, "error": "server error"})

    # ---- 静态文件 ---------------------------------------------------
    def _serve_static(self, rel: str):
        rel = rel.split("?")[0]
        if not rel or ".." in rel or rel.startswith("/"):
            return self._send(400, "bad path", "text/plain; charset=utf-8")
        full = os.path.normpath(os.path.join(self.server.static_dir, rel))
        if not full.startswith(self.server.static_dir + os.sep):
            return self._send(403, "forbidden", "text/plain; charset=utf-8")
        if not os.path.isfile(full):
            return self._send(404, "not found", "text/plain; charset=utf-8")
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            body = f.read()
        extra = {"Cache-Control": "no-cache"} if ext == ".html" else {"Cache-Control": "max-age=60"}
        return self._send(200, body, MIME.get(ext, "application/octet-stream"), extra)

    # ---- 日志接收 ---------------------------------------------------
    def _api_log(self):
        raw = self._read_body(MAX_JSON)
        data = json.loads(raw.decode("utf-8"))
        session = str(data.get("session") or "")
        if not SAFE_NAME.match(session):
            return self._json(400, {"ok": False, "error": "bad session id"})
        events = data.get("events") or []
        if not isinstance(events, list):
            return self._json(400, {"ok": False, "error": "events must be list"})
        day = datetime.now().astimezone().strftime("%Y-%m-%d")
        ddir = os.path.join(self.server.logs_dir, day)
        os.makedirs(os.path.join(ddir, "frames"), exist_ok=True)
        rec = {
            "recv_at": iso_now(),
            "ip": self.headers.get("X-Real-IP") or self.client_address[0],
            "ua_header": self.headers.get("User-Agent", ""),
            "session": session,
            "meta": data.get("meta") or {},
            "events": events,
        }
        path = os.path.join(ddir, session + ".jsonl")
        line = json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n"
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
        return self._json(200, {"ok": True, "saved": len(events), "day": day})

    def _api_frame(self):
        raw = self._read_body(MAX_FRAME)
        session = self.headers.get("X-Session", "")
        label = self.headers.get("X-Label", "frame")
        zoom = self.headers.get("X-Zoom", "")
        if not SAFE_NAME.match(session):
            return self._json(400, {"ok": False, "error": "bad session"})
        if not SAFE_NAME.match(label):
            label = "frame"
        ctype = self.headers.get("Content-Type", "")
        if ctype not in ("image/jpeg", "image/png"):
            return self._json(415, {"ok": False, "error": "expected image/jpeg"})
        day = datetime.now().astimezone().strftime("%Y-%m-%d")
        ddir = os.path.join(self.server.logs_dir, day, "frames")
        os.makedirs(ddir, exist_ok=True)
        name = f"{session}-{label}-{zoom or 'na'}-{int(time.time() * 1000)}.jpg"
        with open(os.path.join(ddir, name), "wb") as f:
            f.write(raw)
        # 同时把照片事件写进会话日志，方便按会话查看
        rec = {
            "recv_at": iso_now(),
            "session": session,
            "events": [{"t": iso_now(), "type": "server.frame", "label": label, "zoom": zoom,
                        "file": f"{day}/frames/{name}", "bytes": len(raw)}],
        }
        with open(os.path.join(self.server.logs_dir, day, session + ".jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
        log(f"frame saved: {day}/frames/{name} ({len(raw)} bytes)")
        return self._json(200, {"ok": True, "file": f"{day}/frames/{name}"})

    # ---- 后台查看 ---------------------------------------------------
    def _admin_login(self):
        q = self._qs()
        token = (q.get("token") or [""])[0]
        if not token or not hmac.compare_digest(token, self.server.admin_token):
            return self._send(401, "bad token", "text/plain; charset=utf-8")
        body = '<meta http-equiv="refresh" content="0;url=/admin?token=%s">' % quote(token)
        return self._send(200, body, "text/html; charset=utf-8",
                          {"Set-Cookie": f"shot_admin={token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax"})

    def _admin_page(self):
        if not self._token_ok():
            return self._send(401, "需要 token：/admin?token=XXX", "text/plain; charset=utf-8")
        q = self._qs()
        token = (q.get("token") or [""])[0]
        suffix = f"?token={quote(token)}" if token else ""

        rows = []
        total = 0
        for day in sorted(os.listdir(self.server.logs_dir), reverse=True):
            if not DAY_RE.match(day):
                continue
            ddir = os.path.join(self.server.logs_dir, day)
            files = sorted(f for f in os.listdir(ddir) if f.endswith(".jsonl"))
            frames = os.path.join(ddir, "frames")
            nframes = len(os.listdir(frames)) if os.path.isdir(frames) else 0
            rows.append(
                f'<tr class="day"><td colspan="4"><b>{html.escape(day)}</b> '
                f'<a href="/admin/zip{suffix}&day={day}">打包下载</a> · 照片 {nframes} 张</td></tr>'
            )
            for f in files:
                total += 1
                p = os.path.join(ddir, f)
                st = os.stat(p)
                rows.append(
                    "<tr>"
                    f'<td><a href="/admin/session{suffix}&day={day}&file={quote(f)}">{html.escape(f)}</a></td>'
                    f"<td>{st.st_size / 1024:.1f} KB</td>"
                    f"<td>{datetime.fromtimestamp(st.st_mtime).strftime('%H:%M:%S')}</td>"
                    f'<td><a href="/admin/session{suffix}&day={day}&file={quote(f)}">查看</a></td>'
                    "</tr>"
                )
        if not rows:
            rows.append('<tr><td colspan="4">还没有日志。让手机打开页面并点一次「开始测试」。</td></tr>')

        body = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>shot · 日志后台</title>
<style>
 body{{font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0;padding:20px;background:#0f1115;color:#e6e6e6}}
 h1{{font-size:18px;margin:0 0 4px}} .muted{{color:#8b93a7;font-size:12px}}
 table{{width:100%;border-collapse:collapse;margin-top:16px}}
 td,th{{padding:8px;border-bottom:1px solid #23262f;text-align:left;font-size:13px;vertical-align:top}}
 th{{color:#8b93a7;font-weight:500}}
 tr.day td{{background:#161922;color:#c9d1e6}}
 a{{color:#7cc4ff;text-decoration:none}} a:hover{{text-decoration:underline}}
 .bar{{margin:12px 0}} .bar a{{margin-right:16px}}
</style></head><body>
<h1>shot · 摄像头测试日志</h1>
<div class="muted">共 {total} 个会话 · 数据目录 /opt/shot/logs</div>
<div class="bar"><a href="/admin/zip{suffix}&day=all">下载全部（zip）</a>
<a href="/">返回测试页</a></div>
<table><thead><tr><th>会话</th><th>大小</th><th>更新时间</th><th></th></tr></thead>
<tbody>{''.join(rows)}</tbody></table>
</body></html>"""
        return self._send(200, body, "text/html; charset=utf-8")

    def _admin_session(self):
        if not self._token_ok():
            return self._send(401, "unauthorized", "text/plain; charset=utf-8")
        q = self._qs()
        day = (q.get("day") or [""])[0]
        name = (q.get("file") or [""])[0]
        if not DAY_RE.match(day) or not SAFE_NAME.match(name) or not name.endswith(".jsonl"):
            return self._send(400, "bad params", "text/plain; charset=utf-8")
        path = os.path.join(self.server.logs_dir, day, name)
        if not os.path.isfile(path):
            return self._send(404, "not found", "text/plain; charset=utf-8")
        with open(path, "rb") as f:
            body = f.read()
        return self._send(200, body, "application/json; charset=utf-8",
                          {"Content-Disposition": f'attachment; filename="{day}-{name}"'})

    def _admin_zip(self):
        if not self._token_ok():
            return self._send(401, "unauthorized", "text/plain; charset=utf-8")
        q = self._qs()
        day = (q.get("day") or [""])[0]
        buf = io.BytesIO()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for d in sorted(os.listdir(self.server.logs_dir)):
                if not DAY_RE.match(d):
                    continue
                if day != "all" and d != day:
                    continue
                ddir = os.path.join(self.server.logs_dir, d)
                for root, _dirs, files in os.walk(ddir):
                    for f in files:
                        full = os.path.join(root, f)
                        zf.write(full, os.path.relpath(full, self.server.logs_dir))
        data = buf.getvalue()
        return self._send(200, data, "application/zip",
                          {"Content-Disposition": f'attachment; filename="shot-logs-{day}-{stamp}.zip"'})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8082)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--root", default="/opt/shot")
    ap.add_argument("--no-tls", action="store_true", help="本地调试用，直接跑 HTTP")
    args = ap.parse_args()

    certfile = keyfile = None
    if not args.no_tls:
        certfile = os.path.join(args.root, "tls", "fullchain.pem")
        keyfile = os.path.join(args.root, "tls", "privkey.pem")
        if not (os.path.exists(certfile) and os.path.exists(keyfile)):
            log(f"FATAL: 证书不存在: {certfile} / {keyfile}")
            return 2
        # 先构建一次，确保证书可用
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile, keyfile)
        del ctx

    srv = CamServer((args.bind, args.port), Handler, args.root, certfile, keyfile)
    scheme = "http" if args.no_tls else "https"
    log(f"listening on {scheme}://{args.bind}:{args.port} root={args.root}")
    try:
        srv.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
