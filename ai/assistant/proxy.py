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
import time
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
    def __init__(self, upstream, augment, after=None, touch=None, call_tool=None):
        self.upstream = upstream        # () -> "http://127.0.0.1:8080"
        self.augment = augment          # may return "tools" (OpenAI schemas) the model can call …
        self.after = after
        self.touch = touch or (lambda: None)
        self.call_tool = call_tool      # … run by call_tool(name, args, sources) -> result text


MAX_ROUNDS = 4          # tool rounds per question; the round after the last one answers without tools
TOOL_LABEL = {"search_course": "ค้นเนื้อหาวิชา", "find_parts": "ค้นคลังชิ้นส่วน", "app_help": "ดูวิธีใช้โปรแกรม"}


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
            # our tools only when the page sent none of its own (llama-ui's MCP servers keep working as they do)
            ours = bool(aug.get("tools")) and hooks.call_tool is not None and not body.get("tools")
            if ours:
                body["tools"] = aug["tools"]
            self._run(body, q, list(aug.get("sources") or []), ours, aug.get("prefetch") if ours else None)

        def _emit(self, ev):
            self.wfile.write(("data: " + json.dumps(ev, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        def _run(self, body, q, sources, ours, prefetch=None):
            """Stream the answer to the page; a round that ends in tool calls is not shown as such: the app runs
            the calls (a 🔎 line in the page's reasoning box says what was looked up), adds the results and asks
            again, up to MAX_ROUNDS — the last round goes without tools, so it has to answer.
            prefetch [(tool, args)]: calls the app makes before the first round, handed over as the model's own."""
            answer, st = [], {"thai": False, "last": None, "sent": False}
            pending = list(prefetch or [])
            for rnd in range(MAX_ROUNDS + 1):
                if pending:
                    if not st["sent"]:
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.send_header("Cache-Control", "no-cache")
                        self.end_headers()
                        st["sent"] = True
                        st["last"] = {"object": "chat.completion.chunk", "created": int(time.time()), "id": "chatcmpl-fe"}
                    ids = [f"call_pre_{i}" for i in range(len(pending))]
                    body["messages"] = body["messages"] + [{"role": "assistant", "content": "", "tool_calls": [
                        {"id": i, "type": "function", "function": {"name": n, "arguments": json.dumps(a, ensure_ascii=False)}}
                        for i, (n, a) in zip(ids, pending)]}]
                    for i, (n, a) in zip(ids, pending):
                        self._note(st, "🔎 " + TOOL_LABEL.get(n, n) + ": " + str(next(iter(a.values()), ""))[:80] + "\n")
                        body["messages"].append({"role": "tool", "tool_call_id": i, "content": hooks.call_tool(n, a, sources)})
                    pending = []
                if rnd == MAX_ROUNDS and ours:
                    body.pop("tools", None)
                try:
                    conn, resp = self._upstream("POST", json.dumps(body).encode("utf-8"), {"Content-Type": "application/json"})
                except Exception:
                    if not st["sent"]:
                        return self._pass("POST", json.dumps(body).encode("utf-8"))
                    break
                calls, said = {}, []
                try:
                    if not st["sent"]:
                        self._headers(resp)
                        self.end_headers()
                        st["sent"] = True
                    if resp.status != 200:
                        self.wfile.write(resp.read())
                        return
                    while True:
                        line = resp.readline()
                        if not line:
                            break
                        s = line.decode("utf-8", "replace")
                        payload = s[5:].strip() if s.startswith("data:") else None
                        if payload == "[DONE]":
                            continue                 # ours is sent once, at the very end
                        if not payload:
                            continue                 # blank separators: _emit writes its own
                        try:
                            ev = json.loads(payload)
                        except ValueError:
                            self.wfile.write(line)
                            continue
                        for ch in ev.get("choices") or []:
                            d = ch.get("delta") or {}
                            for tc in ((d.pop("tool_calls", None) or []) if ours else []):
                                c = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "args": ""})
                                c["id"] = tc.get("id") or c["id"]
                                fn = tc.get("function") or {}
                                c["name"] += fn.get("name") or ""
                                c["args"] += fn.get("arguments") or ""
                            if ch.get("finish_reason") == "tool_calls" and ours:
                                ch["finish_reason"] = None
                            c = d.get("content")
                            if c:
                                st["thai"] = st["thai"] or bool(THAI.search(c))
                                if st["thai"] and CJK.search(c):
                                    d["content"] = c = CJK.sub("", c)
                                answer.append(c)
                                said.append(c)
                        st["last"] = ev
                        self._emit(ev)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return      # the page stopped: closing our side stops llama-server's generation
                finally:
                    conn.close()
                if not (ours and calls and rnd < MAX_ROUNDS):
                    break
                order = [calls[i] for i in sorted(calls)]
                for i, c in enumerate(order):
                    c["id"] = c["id"] or f"call_{rnd}_{i}"
                body["messages"] = body["messages"] + [{"role": "assistant", "content": "".join(said), "tool_calls": [
                    {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["args"] or "{}"}} for c in order]}]
                for c in order:
                    try:
                        args = json.loads(c["args"] or "{}")
                    except ValueError:
                        args = {}
                    self._note(st, "🔎 " + TOOL_LABEL.get(c["name"], c["name"]) + ": " + str(next(iter(args.values()), "")) + "\n")
                    result = hooks.call_tool(c["name"], args if isinstance(args, dict) else {}, sources)
                    body["messages"].append({"role": "tool", "tool_call_id": c["id"], "content": result})
            try:
                if sources and answer and st["last"] is not None:
                    self._piece(st, {"content": sources_line(sources)})
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except OSError:
                return
            text = "".join(answer).strip()
            if hooks.after and text:
                threading.Thread(target=hooks.after, args=(q, text), daemon=True).start()

        def _piece(self, st, delta):
            ev = {k: v for k, v in (st["last"] or {}).items() if k not in ("choices", "usage", "timings")}
            ev["choices"] = [{"index": 0, "delta": delta, "finish_reason": None}]
            self._emit(ev)

        def _note(self, st, text):
            """A line in the page's reasoning box (what the app is looking up for the model)."""
            try:
                self._piece(st, {"reasoning_content": text})
            except OSError:
                pass

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
