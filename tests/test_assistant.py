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


if __name__ == "__main__":
    unittest.main()
