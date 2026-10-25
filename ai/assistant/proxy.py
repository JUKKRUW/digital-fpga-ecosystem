"""
proxy.py - llama.cpp's own chat page (llama-ui) as the assistant, with the app's knowledge added.

The launcher serves this proxy on its own port (Home ▸ ผู้ช่วย AI opens it). Everything is passed through
to llama-server unchanged (the page, its assets, /props, /slots …) except a chat request from the page:
  * the app's system prompt goes first (Thai only, board facts, how to answer), before the user's own one;
  * the latest question gets the course notes (RAG) and the user's memories that match it, in front;
  * "จำไว้ว่า …" is stored at once;
  * while the answer streams, CJK characters are taken out of a Thai answer, and the sources are
    added as the answer's last line;
  * after the answer, `after(question, answer)` runs in the background (the memory extractor).
The page keeps its conversations in its own browser storage, as it does without us.
"""
from __future__ import annotations

import gzip
import http.client
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

CJK = re.compile("[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ]")
THAI = re.compile("[฀-๿]")
_HOP = {"connection", "keep-alive", "transfer-encoding", "content-length", "host", "proxy-connection", "upgrade"}


def user_text(content) -> str:
    """The text of a message (a string, or OpenAI content parts)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text") or "" for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def with_prefix(content, prefix: str):
    """The message content with `prefix` in front (keeps images / files of a parts list)."""
    if not prefix:
        return content
    if isinstance(content, list):
        return [{"type": "text", "text": prefix}] + content
    return prefix + (content or "")


def sources_line(sources) -> str:
    if not sources:
        return ""
    items = [f"[{s['n']}] " + " · ".join(x for x in (s.get("topic") or s.get("title"), s.get("source")) if x) for s in sources]
    return "\n\n---\n*ที่มาจากเนื้อหาวิชา: " + " · ".join(items) + "*"


class Hooks:
    """What the launcher plugs in. augment(question) -> {"system", "prefix", "sources"}; after(question, answer);
    touch() on every request (the launcher quits when no window of it is open: this window counts)."""
    def __init__(self, upstream, augment, after=None, touch=None):
        self.upstream = upstream        # () -> "http://127.0.0.1:8080"
        self.augment = augment
        self.after = after
        self.touch = touch or (lambda: None)


# the page pings while it is open (like launcher/web/shim.js in the app's own pages)
PING_PATH = "/__fe_ping"
PING_JS = b'<script>setInterval(function(){fetch("' + PING_PATH.encode() + b'",{cache:"no-store"}).catch(function(){})},15000)</script>'


def make_handler(hooks: Hooks):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *a):
            pass

        def _upstream(self, method, body=None, headers=None):
            u = urlparse(hooks.upstream())
            conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=900)
            h = {k: v for k, v in self.headers.items() if k.lower() not in _HOP}
            h.update(headers or {})
            if body is not None:
                h["Content-Length"] = str(len(body))
            conn.request(method, self.path, body=body, headers=h)
            return conn, conn.getresponse()

        def _headers(self, resp, drop=()):
            self.send_response(resp.status, resp.reason)
            for k, v in resp.getheaders():
                if k.lower() not in _HOP and k.lower() not in drop:
                    self.send_header(k, v)

        def _pass(self, method, body=None):
            try:
                conn, resp = self._upstream(method, body)
            except Exception as e:
                msg = json.dumps({"error": {"code": 503, "message": f"โมเดล AI ยังไม่เปิด ({e}) — เปิดได้ที่ หน้าหลัก ▸ ตั้งค่า ▸ โมเดล AI",
                                            "type": "unavailable_error"}}, ensure_ascii=False).encode("utf-8")
                self.send_response(503)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
                return
            try:
                data = resp.read()
                drop = ()
                if method == "GET" and urlparse(self.path).path in ("/", "/index.html") and \
                        "text/html" in (resp.getheader("Content-Type") or ""):
                    if (resp.getheader("Content-Encoding") or "").lower() == "gzip":
                        data, drop = gzip.decompress(data), ("content-encoding",)
                    data = data.replace(b"</body>", PING_JS + b"</body>", 1)
                self._headers(resp, drop)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            finally:
                conn.close()

        def do_GET(self):
            hooks.touch()
            if urlparse(self.path).path == PING_PATH:
                self.send_response(204)
                self.end_headers()
                return
            self._pass("GET")

        def do_DELETE(self):
            self._pass("DELETE")

        def do_OPTIONS(self):
            self._pass("OPTIONS")

        def do_POST(self):
            hooks.touch()
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            if urlparse(self.path).path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
                return self._pass("POST", raw)
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                return self._pass("POST", raw)
            msgs = body.get("messages") or []
            if not (body.get("stream") and msgs and msgs[-1].get("role") == "user"):
                return self._pass("POST", raw)      # the page's own side calls (titles …) as they are
            q = user_text(msgs[-1].get("content")).strip()
            try:
                aug = hooks.augment(q) or {}
            except Exception as e:
                aug = {"note": f"augment failed: {e}"}
            if aug.get("system"):
                if msgs[0].get("role") == "system":
                    msgs[0] = dict(msgs[0], content=aug["system"] + "\n\n[คำสั่งเพิ่มเติมจากผู้ใช้]\n" + user_text(msgs[0].get("content")))
                else:
                    msgs.insert(0, {"role": "system", "content": aug["system"]})
            msgs[-1] = dict(msgs[-1], content=with_prefix(msgs[-1].get("content"), aug.get("prefix") or ""))
            body["messages"] = msgs
            self._stream(json.dumps(body).encode("utf-8"), q, aug.get("sources") or [])

        def _stream(self, data, q, sources):
            try:
                conn, resp = self._upstream("POST", data, {"Content-Type": "application/json"})
            except Exception:
                return self._pass("POST", data)
            answer, thai = [], False
            try:
                self._headers(resp)
                self.end_headers()
                last = None
                try:
                    while True:
                        line = resp.readline()
                        if not line:
                            break
                        s = line.decode("utf-8", "replace")
                        if s.startswith("data:") and s[5:].strip() not in ("", "[DONE]"):
                            try:
                                ev = json.loads(s[5:])
                                for ch in ev.get("choices") or []:
                                    d = ch.get("delta") or {}
                                    c = d.get("content")
                                    if c:
                                        thai = thai or bool(THAI.search(c))
                                        if thai and CJK.search(c):
                                            d["content"] = c = CJK.sub("", c)
                                        answer.append(c)
                                last = ev
                                line = ("data: " + json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8")
                            except ValueError:
                                pass
                        elif s.strip() == "data: [DONE]" and sources and answer and last is not None:
                            # the sources as one more content piece, before the end of the stream
                            extra = {k: v for k, v in last.items() if k not in ("choices", "usage", "timings")}
                            extra["choices"] = [{"index": 0, "delta": {"content": sources_line(sources)}, "finish_reason": None}]
                            self.wfile.write(("data: " + json.dumps(extra, ensure_ascii=False) + "\n\n").encode("utf-8"))
                        self.wfile.write(line)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return      # the page stopped: closing our side stops llama-server's generation
            finally:
                conn.close()
            text = "".join(answer).strip()
            if hooks.after and text:
                threading.Thread(target=hooks.after, args=(q, text), daemon=True).start()

    return H


def serve(hooks: Hooks, port: int = 0):
    """Start the proxy in a thread; returns the server (server.server_address[1] = its port)."""
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(hooks))
    except OSError:
        srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(hooks))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
