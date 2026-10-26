"""The ถาม-ตอบ assistant (ai/assistant): thinking is split from the answer whichever way the server sends
it, the stream is read piece by piece, and the prompt keeps each part inside its budget."""
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "ai")]

from assistant import backend as AB, chat as AC  # noqa: E402


def split_all(chunks):
    s, out = AB._ThinkSplitter(), []
    for c in chunks:
        out += s.feed(c)
    out += s.flush()
    joined = {"think": "", "text": ""}
    for k, t in out:
        joined[k] += t
    return joined


class Splitter(unittest.TestCase):
    def test_tags_cut_between_chunks(self):
        j = split_all(["<thi", "nk>คิด", "ก่อน</th", "ink>\n\nคำตอบ <b>"])
        self.assertEqual(j["think"], "คิดก่อน")
        self.assertEqual(j["text"], "\n\nคำตอบ <b>")

    def test_no_tags(self):
        self.assertEqual(split_all(["a < b", " and c <", "/x>"])["text"], "a < b and c </x>")


class FakeModel(BaseHTTPRequestHandler):
    """An OpenAI-style streaming server: reasoning_content first (llama-server), then content."""
    last = {}

    def log_message(self, *a):
        pass

    def do_POST(self):
        FakeModel.last = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunks = [{"choices": [{"delta": {"reasoning_content": "ลองคิด"}}]},
                  {"choices": [{"delta": {"content": "flip-flop "}}]},
                  {"choices": [{"delta": {"content": "ไวต่อขอบ"}, "finish_reason": "stop"}],
                   "timings": {"predicted_per_second": 31.5}}]
        for c in chunks:
            self.wfile.write(b"data: " + json.dumps(c).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")


class Stream(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}/v1/chat/completions"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def test_stream_and_complete(self):
        be = AB.Backend("llama", self.url)
        evs = list(be.stream([{"role": "user", "content": "q"}], think=True))
        self.assertEqual([e["type"] for e in evs], ["think", "text", "text", "done"])
        self.assertEqual(evs[-1]["finish"], "stop")
        self.assertEqual(evs[-1]["timings"]["predicted_per_second"], 31.5)
        self.assertEqual(FakeModel.last["chat_template_kwargs"], {"enable_thinking": True})
        self.assertTrue(FakeModel.last["stream"])
        out = be.complete([{"role": "user", "content": "q"}])
        self.assertEqual((out["think"], out["text"]), ("ลองคิด", "flip-flop ไวต่อขอบ"))
        self.assertEqual(FakeModel.last["chat_template_kwargs"], {"enable_thinking": False})

    def test_ollama_body_has_model_no_template_kwargs(self):
        be = AB.Backend("ollama", self.url, "qwen3:8b")
        be.complete([{"role": "user", "content": "q"}])
        self.assertEqual(FakeModel.last["model"], "qwen3:8b")
        self.assertNotIn("chat_template_kwargs", FakeModel.last)

    def test_server_that_ignores_stream(self):
        class Plain(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                b = json.dumps({"choices": [{"message": {"content": "<think>x</think>คำตอบ"}, "finish_reason": "stop"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
        srv = ThreadingHTTPServer(("127.0.0.1", 0), Plain)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            out = AB.Backend("llama", f"http://127.0.0.1:{srv.server_address[1]}/v1/chat/completions").complete([])
            self.assertEqual((out["think"], out["text"], out["finish"]), ("x", "คำตอบ", "stop"))
        finally:
            srv.shutdown()

    def test_unreachable(self):
        with self.assertRaises(AB.BackendError):
            list(AB.Backend("llama", "http://127.0.0.1:9/v1/chat/completions").stream([], timeout=2))


class Prompt(unittest.TestCase):
    def test_sheet_only_when_asked_about_it(self):
        sheet = "แผ่น \"top\" — อินพุต: a, b"
        self.assertNotIn("top", AC.messages("D latch คืออะไร", [], sheet)[-1]["content"])
        self.assertIn("[วงจรบนแผ่นที่ผู้ใช้เปิดอยู่]", AC.messages("วงจรนี้ผิดตรงไหน", [], sheet)[-1]["content"])

    def test_notes_numbered_and_clipped(self):
        hits = [{"topic": "D Latch", "source": "Ch_5.pdf", "text": "x " * 2000, "title": "t", "group": "notes"}]
        u = AC.messages("q", hits)[-1]["content"]
        self.assertIn("[1] D Latch · Ch_5.pdf", u)
        self.assertLess(len(u), AC.NOTE_CHARS + 200)
        self.assertEqual(AC.sources(hits)[0]["n"], 1)

    def test_history_budget_and_flagged_answers(self):
        h = []
        for i in range(20):
            h += [{"role": "user", "content": f"q{i} " + "ก" * 1400}, {"role": "assistant", "content": f"a{i}"}]
        h += [{"role": "user", "content": "q-last"}, {"role": "assistant", "content": "⚠ flagged"}]
        m = AC.messages("now", None, "", h)
        self.assertEqual(m[0]["role"], "system")
        self.assertEqual(m[1]["role"], "user")
        self.assertNotIn("⚠ flagged", json.dumps(m, ensure_ascii=False))
        self.assertLessEqual(sum(len(x["content"]) for x in m[1:-1]), AC.HISTORY_CHARS)
        self.assertEqual(m[-1]["content"], "now")


class Memory(unittest.TestCase):
    def setUp(self):
        import tempfile
        from assistant import memory as AM
        self.AM = AM
        self.s = AM.Store(Path(tempfile.mkdtemp()) / "m.sqlite")

    def test_explicit(self):
        self.assertEqual(self.AM.explicit("จำไว้ว่า ผมใช้บอร์ด EDGE"), "ผมใช้บอร์ด EDGE")
        self.assertEqual(self.AM.explicit("D latch คืออะไร"), "")

    def test_changed_fact_replaces_old(self):
        self.s.add("ผู้ใช้ชื่อเก่ง อยู่กลุ่มแลป 3")
        r = self.s.add("ผู้ใช้ชื่อเก่ง ตอนนี้อยู่กลุ่มแลป 5")
        self.assertEqual(r["replaced"], "ผู้ใช้ชื่อเก่ง อยู่กลุ่มแลป 3")
        self.assertEqual(len(self.s.all()), 1)

    def test_search_pinned_first(self):
        a = self.s.add("ชอบให้อธิบายเป็นข้อ ๆ", "preference")
        self.s.add("ผู้ใช้อยู่กลุ่มแลป 3")
        self.s.update(a["id"], pinned=True)
        hits = [m["text"] for m in self.s.search("กลุ่มแลปไหน")]
        self.assertEqual(hits, ["ชอบให้อธิบายเป็นข้อ ๆ", "ผู้ใช้อยู่กลุ่มแลป 3"])

    def test_extract_only_on_cues(self):
        self.assertTrue(self.AM.should_extract("ผมไม่เข้าใจเรื่อง K-map"))
        self.assertFalse(self.AM.should_extract("D latch คืออะไร"))


class Proxy(unittest.TestCase):
    """llama-ui behind the proxy: the question gets the app's prefix, the answer is scrubbed + sourced."""
    @classmethod
    def setUpClass(cls):
        from assistant import proxy as AP
        cls.AP = AP
        cls.up = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
        threading.Thread(target=cls.up.serve_forever, daemon=True).start()
        cls.after = []
        hooks = AP.Hooks(lambda: f"http://127.0.0.1:{cls.up.server_address[1]}",
                         lambda q: {"system": "SYS", "prefix": "NOTES\n\n",
                                    "sources": [{"n": 1, "topic": "D Latch", "source": "Ch_5.pdf"}]},
                         lambda q, a: cls.after.append((q, a)))
        cls.px = AP.serve(hooks, 0)
        cls.url = f"http://127.0.0.1:{cls.px.server_address[1]}/v1/chat/completions"

    @classmethod
    def tearDownClass(cls):
        cls.px.shutdown()
        cls.up.shutdown()

    def test_chat_is_augmented(self):
        import time
        import urllib.request
        body = {"stream": True, "messages": [{"role": "system", "content": "mine"}, {"role": "user", "content": "q?"}]}
        r = urllib.request.urlopen(urllib.request.Request(self.url, json.dumps(body).encode(), {"Content-Type": "application/json"}))
        text = ""
        for line in r:
            line = line.decode("utf-8")
            if line.startswith("data:") and "[DONE]" not in line:
                for c in json.loads(line[5:]).get("choices") or []:
                    text += (c.get("delta") or {}).get("content") or ""
        m = FakeModel.last["messages"]
        self.assertTrue(m[0]["content"].startswith("SYS") and m[0]["content"].endswith("mine"))
        self.assertEqual(m[-1]["content"], "NOTES\n\nq?")
        self.assertTrue(text.startswith("flip-flop ไวต่อขอบ"))
        self.assertIn("[1] D Latch · Ch_5.pdf", text)
        for _ in range(20):
            if self.after:
                break
            time.sleep(0.05)
        self.assertEqual(self.after[0][0], "q?")


class Compact(unittest.TestCase):
    """A long chat: the early turns become a cached summary in the system message, the recent ones stay."""
    def setUp(self):
        from assistant import compact as ACP
        self.ACP = ACP
        self.calls = []

        def summarize(sys_, text):
            self.calls.append(text)
            return f"สรุป#{len(self.calls)}"
        # n_ctx so that the budget is 2000 tokens: compact past 1600, down to 900; each turn = 100 + 6 tokens
        self.c = ACP.Compactor(summarize, count=lambda t: 100, n_ctx=lambda: 2000 + ACP.RESERVE + ACP.FIXED)

    def chat(self, turns):
        m = [{"role": "system", "content": "SYS"}]
        for i in range(turns):
            m += [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": f"a{i}"}]
        return m + [{"role": "user", "content": "now"}]

    def test_short_chat_untouched(self):
        m = self.chat(3)
        self.assertEqual(self.c.apply(m), (m, None))
        self.assertEqual(self.calls, [])

    def test_long_chat_summarised_and_reused(self):
        m = self.chat(10)                                   # 21 messages ≈ 2226 tokens > 1600
        out, note = self.c.apply(m)
        self.assertIn("🗜", note)
        self.assertEqual(out[0]["role"], "system")
        self.assertTrue(out[0]["content"].startswith("SYS\n\n[สรุปบทสนทนาก่อนหน้า"))
        self.assertTrue(out[0]["content"].endswith("สรุป#1"))
        self.assertEqual(out[1]["role"], "user")
        self.assertEqual(out[-1]["content"], "now")
        self.assertLessEqual(len(out[1:]) * 106, 0.45 * 2000 + 106)
        self.assertNotIn("q9", self.calls[0])               # recent turns are not summarised
        # the next question of the same chat: same summary, no new model call
        m2 = m[:-1] + [{"role": "user", "content": "now"}, {"role": "assistant", "content": "ans"}, {"role": "user", "content": "next"}]
        out2, note2 = self.c.apply(m2)
        self.assertIsNone(note2)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(out2[0]["content"].endswith("สรุป#1"))
        self.assertEqual(out2[-1]["content"], "next")

    def test_cut_moves_forward_from_old_summary(self):
        m = self.chat(10)
        self.c.apply(m)
        longer = self.chat(20)                              # same chat, much later
        out, note = self.c.apply(longer)
        self.assertIn("🗜", note)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(self.calls[1].startswith("[สรุปเดิม]\nสรุป#1"))   # built on the first summary
        self.assertTrue(out[0]["content"].endswith("สรุป#2"))

    def test_compact_command_then_go_on(self):
        self.assertTrue(self.ACP.is_command(" /compact ") and self.ACP.is_command("/ย่อ") and self.ACP.is_command("ย่อแชต"))
        self.assertFalse(self.ACP.is_command("/compact this") or self.ACP.is_command("ช่วยย่อแชตนี้หน่อย"))
        m = self.chat(4)[:-1] + [{"role": "user", "content": "/compact"}]
        reply = self.c.command(m)
        self.assertTrue(reply.startswith("🗜 **ย่อแชตแล้ว** — 8 ข้อความ"))
        self.assertTrue(reply.endswith("สรุป#1"))
        self.assertIn("q0", self.calls[0])
        # the page sends the command and the app's reply back with the next question: both are dropped
        nxt = m + [{"role": "assistant", "content": reply}, {"role": "user", "content": "ต่อเลย"}]
        out, note = self.c.apply(nxt)
        self.assertIsNone(note)
        self.assertEqual([x["content"] for x in out[1:]], ["ต่อเลย"])
        self.assertTrue(out[0]["content"].endswith("สรุป#1"))
        # a second /compact later builds on the first summary, without the first exchange
        more = nxt + [{"role": "assistant", "content": "ตอบ"}, {"role": "user", "content": "/compact"}]
        self.c.command(more)
        self.assertTrue(self.calls[1].startswith("[สรุปเดิม]\nสรุป#1"))
        self.assertNotIn("ย่อแชตแล้ว", self.calls[1])
        self.assertNotIn("/compact", self.calls[1])

    def test_nothing_to_compact(self):
        self.assertIn("ยังไม่มี", self.c.command([{"role": "user", "content": "/compact"}]))
        self.assertEqual(self.calls, [])

    def test_text_of_drops_think_and_sources(self):
        m = {"role": "assistant", "content": "<think>x</think>ตอบ\n\n---\n*ที่มาจากเนื้อหาวิชา: [1] a*"}
        self.assertEqual(self.ACP.text_of(m), "ตอบ")


class ToolModel(BaseHTTPRequestHandler):
    """Streams a find_parts call while it has no tool result, then an answer naming what the result said."""
    seen = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        ToolModel.seen.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        results = [m["content"] for m in body["messages"] if m["role"] == "tool"]
        if len(results) < 2:      # one from the app's own look-up, one of its own
            chunks = [{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "find_parts", "arguments": ""}}]}}]},
                      {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{\"query\": \"debounce\"}"}}]}}]},
                      {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}]
        else:
            name = "debounce" if "- debounce —" in results[-1] else "?"
            chunks = [{"choices": [{"delta": {"content": f"ใช้ `{name}`"}, "finish_reason": "stop"}]}]
        for c in chunks:
            self.wfile.write(b"data: " + json.dumps(c, ensure_ascii=False).encode() + b"\n\n")
        self.wfile.write(b"data: [DONE]\n\n")


class Tools(unittest.TestCase):
    def test_catalog_and_guide(self):
        from assistant import tools as AT
        t = AT.Toolbox(lambda q, k: [{"topic": "D Latch", "source": "Ch_5.pdf", "text": "x"}] * k)
        self.assertIn("seg7_mux4", t.find_parts("7-segment 4 หลัก"))
        self.assertIn("## เลือกขา", t.app_help("เลือกขาบอร์ด"))
        src = [{"n": 1}]
        self.assertTrue(t.search_course("latch", src).startswith("[2] D Latch · Ch_5.pdf"))
        self.assertEqual(len(src), 1 + AT.COURSE_K)
        self.assertEqual([n for n, _ in AT.prefetch("ทำนาฬิกาต้องใช้อะไรในคลังบ้าง")], ["find_parts"])
        self.assertEqual([n for n, _ in AT.prefetch("เลือกขาในโปรแกรมยังไง")], ["app_help"])
        self.assertEqual(AT.prefetch("latch กับ flip-flop ต่างกันยังไง"), [])
        self.assertEqual([n for n, _ in AT.prefetch("7-seg บนบอร์ดต้องส่ง 0 หรือ 1 ถึงติด")], ["board_info", "search_course"])
        self.assertIn("an(i) = 0 = เปิดหลัก i", t.call("board_info", {}, []))
        # every function the question names is covered: a 7-seg part although the counters rank first
        kinds = t.find_parts("ตัวนับ 00-99 แสดงบน 7-seg กดปุ่มนับ ใช้อะไรในคลัง")
        self.assertTrue(any(k in kinds for k in ("seg7_mux4", "seg7_num", "bcd_7seg")))
        self.assertNotIn("- library —", kinds)
        # a lab number reads that lab's sheet (the index ranked "แลป 7" as Lab9)
        src = []
        self.assertIn("ใบงานแลป 7", t.search_course("แลป 7 ให้ทำอะไร", src))
        self.assertEqual(src[0]["source"], "Lab7-2569.pdf")
        self.assertIn("Lab7", AT.expand_query("แลป 7 ปุ่ม SET"))

    def test_proxy_runs_the_calls(self):
        import urllib.request
        from assistant import proxy as AP, tools as AT
        up = ThreadingHTTPServer(("127.0.0.1", 0), ToolModel)
        threading.Thread(target=up.serve_forever, daemon=True).start()
        tb = AT.Toolbox()
        px = AP.serve(AP.Hooks(lambda: f"http://127.0.0.1:{up.server_address[1]}",
                               lambda q: {"system": "SYS", "tools": AT.SCHEMAS, "prefetch": AT.prefetch(q)},
                               call_tool=tb.call), 0)
        try:
            body = {"stream": True, "messages": [{"role": "user", "content": "ปุ่มกดต้องใช้อะไรในคลัง"}]}
            r = urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{px.server_address[1]}/v1/chat/completions",
                                                              json.dumps(body).encode(), {"Content-Type": "application/json"}))
            text, notes, raw_calls = "", "", False
            for line in r:
                line = line.decode("utf-8")
                if line.startswith("data:") and "[DONE]" not in line:
                    for c in json.loads(line[5:]).get("choices") or []:
                        d = c.get("delta") or {}
                        text += d.get("content") or ""
                        notes += d.get("reasoning_content") or ""
                        raw_calls = raw_calls or bool(d.get("tool_calls")) or c.get("finish_reason") == "tool_calls"
            self.assertEqual(text, "ใช้ `debounce`")
            self.assertIn("🔎 ค้นคลังชิ้นส่วน: ปุ่มกดต้องใช้อะไรในคลัง", notes)
            self.assertIn("🔎 ค้นคลังชิ้นส่วน: debounce", notes)
            self.assertFalse(raw_calls)                          # the page never sees a call it would try to run
            last = ToolModel.seen[-1]
            self.assertEqual(last["messages"][0]["content"], "SYS")
            self.assertEqual([m["role"] for m in last["messages"][1:]], ["user", "assistant", "tool", "assistant", "tool"])
            self.assertTrue(last["tools"])
        finally:
            px.shutdown()
            up.shutdown()



class Installer(unittest.TestCase):
    """2.8.x installers shipped without ai/assistant: the proxy never started and Home ▸ ผู้ช่วย AI opened Home again."""

    def test_windows_build_stages_the_assistant(self):
        ps1 = (ROOT / "launcher" / "build_windows.ps1").read_text(encoding="utf-8")
        for pkg in sorted(p.parent.name for p in (ROOT / "ai").glob("*/__init__.py")):
            self.assertIn("ai\\%s\\*.py" % pkg, ps1, "build_windows.ps1 does not stage ai\\%s" % pkg)
        for f in ("catalog.json", "app_guide.md"):
            self.assertTrue((ROOT / "ai" / "assistant" / f).exists())
        self.assertIn('"catalog.json", "app_guide.md"', ps1)
        # every stdlib module the assistant imports is bundled (the frozen app only has what PyInstaller saw)
        import re
        hidden = set(re.findall(r'"([a-z0-9_.]+)"', ps1.split("$hidden =", 1)[1].split("$hiddenArgs", 1)[0]))
        used = set()
        for py in (ROOT / "ai" / "assistant").glob("*.py"):
            for m in re.finditer(r"^(?:import|from) ([a-z0-9_.]+)", py.read_text(encoding="utf-8"), re.M):
                used.add(m.group(1))
        stdlib_needed = {u for u in used if u.split(".")[0] in sys.stdlib_module_names and u not in ("__future__",)}
        bundled_by_app = {"json", "re", "threading", "time", "pathlib", "os", "sys"}      # app.py imports these itself
        self.assertEqual(sorted(stdlib_needed - hidden - bundled_by_app), [])


if __name__ == "__main__":
    unittest.main()
