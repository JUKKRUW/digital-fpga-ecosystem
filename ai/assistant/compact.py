"""
compact.py - a long chat keeps going: the early part is replaced by a summary before the context fills.

llama-ui sends the whole conversation with every question. When it no longer fits what is left of the
context (llama-server's n_ctx minus room for thinking + the answer + tool results), the early turns are
summarised by the same model and the summary goes into the system message; the recent turns go as they are.
The page still shows every message. Two water marks keep it cheap:
  * compact when the history passes HIGH of the budget, down to LOW (so not on every question);
  * the summary is cached by a hash of the messages it replaced, so the next questions of that chat reuse it
    (and llama-server's prompt cache, which needs the same prefix, keeps working) — a cut only moves forward,
    and a new summary is made from the old summary + the turns after it.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from collections import OrderedDict

RESERVE = 7000          # tokens kept free for thinking, the answer and tool results
FIXED = 2500            # the app's system prompt + tool schemas
HIGH = 0.80             # compact when the history takes more than this share of the budget …
LOW = 0.45              # … down to this share
KEEP_MIN = 2            # always keep at least the last question and the answer before it
SUMMARY_TOKENS = 900

SUMMARY_SYS = (
    "สรุปบทสนทนาระหว่างผู้ใช้กับผู้ช่วย AI (วิชาดิจิทัลลอจิก / VHDL / โปรแกรม FPGA Ecosystem) เพื่อใช้คุยต่อ "
    "เขียนเป็นภาษาไทย กระชับ เป็นข้อ ๆ เก็บให้ครบ: ผู้ใช้กำลังทำอะไรและเป้าหมาย, ข้อเท็จจริงของวงจร/โปรเจกต์ของผู้ใช้ "
    "(ชื่อแผ่น พอร์ต ชิ้นส่วนจากคลังพร้อมค่าที่ตั้ง ขาบอร์ด), สิ่งที่ตกลงหรือสรุปแล้ว, โค้ดที่เขียนไว้ (ชื่อ entity พอร์ต "
    "และหลักการ — ไม่ต้องคัดลอกโค้ดทั้งหมด), คำถามหรือปัญหาที่ยังค้าง "
    "ไม่ต้องเก็บคำทักทาย คำอธิบายความรู้ทั่วไปที่ตอบไปแล้ว หรือรายการที่มาจากเนื้อหาวิชา ห้ามแต่งเรื่องที่ไม่มีในบทสนทนา")


def text_of(m) -> str:
    c = m.get("content")
    if isinstance(c, list):
        c = "\n".join(p.get("text") or "" for p in c if isinstance(p, dict) and p.get("type") == "text")
    c = re.sub(r"<think>.*?</think>", "", c or "", flags=re.S)
    return re.sub(r"\n---\n\*ที่มาจากเนื้อหาวิชา:.*$", "", c, flags=re.S).strip()     # the proxy's own sources line


def estimate(text: str) -> int:
    """Rough tokens when the server cannot count (Thai ~2 characters a token, English ~4)."""
    thai = len(re.findall(r"[฀-๿]", text))
    return int(thai / 2 + (len(text) - thai) / 3.5) + 4


class Compactor:
    def __init__(self, summarize, count=None, n_ctx=None, cache_size=64):
        """summarize(system, text) -> summary; count(text) -> tokens (None: estimate); n_ctx() -> context size."""
        self.summarize = summarize
        self.count = count
        self.n_ctx = n_ctx or (lambda: 24576)
        self.cache = OrderedDict()          # hash of the replaced messages -> summary
        self.counted = OrderedDict()        # text hash -> tokens (each message is counted once)

    def tokens(self, text: str) -> int:
        k = hashlib.sha1(text.encode("utf-8")).hexdigest()
        if k in self.counted:
            return self.counted[k]
        n = None
        if self.count:
            try:
                n = int(self.count(text))
            except Exception:
                n = None
        if n is None:
            return estimate(text)           # not cached: the server may be back next time
        self.counted[k] = n
        while len(self.counted) > 2000:
            self.counted.popitem(last=False)
        return n

    @staticmethod
    def _key(msgs) -> str:
        h = hashlib.sha1()
        for m in msgs:
            h.update((m.get("role", "") + "\x00" + text_of(m) + "\x01").encode("utf-8"))
        return h.hexdigest()

    def budget(self) -> int:
        return max(2000, int(self.n_ctx() or 24576) - RESERVE - FIXED)

    def apply(self, messages: list):
        """(messages to send, note or None). The system message (index 0, if any) stays first; a summary is
        added to it. The conversation must end with the user's question."""
        head = [messages[0]] if messages and messages[0].get("role") == "system" else []
        conv = messages[len(head):]
        if len(conv) <= KEEP_MIN:
            return messages, None
        sizes = [self.tokens(text_of(m)) + 6 for m in conv]
        budget = self.budget()
        cuts = [i for i in range(1, len(conv) - KEEP_MIN + 1) if conv[i].get("role") == "user"]
        known, summary = self._known(conv)
        rest = sum(sizes[known:]) + (self.tokens(summary) if summary else 0)
        note = None
        if rest > HIGH * budget:
            # cut so that the turns kept take at most LOW of the budget (never the last KEEP_MIN messages)
            target = next((i for i in cuts if i > known and sum(sizes[i:]) <= LOW * budget), None)
            if target is None:
                target = max([i for i in cuts if i > known] or [known])
            if target > known:
                new = self._summarise(conv, known, summary, target)
                if new:
                    note = f"🗜 ย่อบทสนทนาช่วงต้น ({target} ข้อความ) เป็นสรุป เพื่อให้คุยต่อได้\n"
                    known, summary = target, new
        if not summary:
            return messages, note
        sysmsg = dict(head[0]) if head else {"role": "system", "content": ""}
        sysmsg["content"] = (text_of(sysmsg) + "\n\n" if text_of(sysmsg) else "") + \
            "[สรุปบทสนทนาก่อนหน้าในแชตนี้ — ข้อความเก่ากว่านี้ไม่ได้ส่งมา]\n" + summary
        return [sysmsg] + conv[known:], note

    def _known(self, conv):
        """(index the kept turns start at, summary) — the furthest cut this chat has a summary for: before a
        user message (automatic), or after a /compact exchange (the command and the app's reply are dropped too)."""
        best = (0, "")
        for i in range(1, len(conv) - 1):
            if conv[i].get("role") != "user":
                continue
            k = self._key(conv[:i])
            s = self.cache.get(k)
            if s is None:
                continue
            start = i + 2 if is_command(text_of(conv[i])) and i + 2 < len(conv) else i
            if start <= len(conv) - 1 and start >= best[0]:
                best = (start, s)
                self.cache.move_to_end(k)
        return best

    def _summarise(self, conv, known, summary, target) -> str:
        part = "\n\n".join(f"{'ผู้ใช้' if m.get('role') == 'user' else 'ผู้ช่วย'}: {text_of(m)}"
                           for m in conv[known:target] if not is_command(text_of(m)))
        src = (f"[สรุปเดิม]\n{summary}\n\n[บทสนทนาต่อจากนั้น]\n{part}" if summary else part)
        new = (self.summarize(SUMMARY_SYS, src) or "").strip()
        if new:
            self.cache[self._key(conv[:target])] = new
            while len(self.cache) > 64:
                self.cache.popitem(last=False)
        return new

    def command(self, messages: list) -> str:
        """The user typed /compact: summarise everything before it now and say so (the reply the page shows).
        The next questions of this chat send the summary + what comes after this exchange."""
        head = 1 if messages and messages[0].get("role") == "system" else 0
        conv = messages[head:]
        j = len(conv) - 1                                   # the command itself
        known, summary = self._known(conv[:j] + [{"role": "user", "content": ""}])
        before = sum(self.tokens(text_of(m)) + 6 for m in conv[known:j])
        if j - known < 2:
            return "ยังไม่มีบทสนทนาให้ย่อครับ คุยต่อได้เลย"
        new = self._summarise(conv, known, summary, j)
        if not new:
            return "⚠ ย่อแชตไม่สำเร็จ (โมเดลไม่ตอบ) ลองใหม่อีกครั้ง หรือเปิดแชตใหม่"
        return (f"🗜 **ย่อแชตแล้ว** — {j} ข้อความ (~{before:,} token{' รวมสรุปเดิม' if summary else ''}) "
                f"เหลือเป็นสรุป ~{self.tokens(new):,} token คุยต่อในแชตนี้ได้เลย\n\n"
                f"**สิ่งที่ผู้ช่วยจำจากช่วงก่อนหน้า:**\n\n{new}")


# the whole message only; "ย่อแชต" without the slash too (llama-ui opens its own command picker on "/",
# which says "No matching command" — Enter still sends the text)
COMMAND = re.compile(r"^\s*(/(compact|ย่อ|ย่อแชต)|ย่อแชต)\s*$", re.I)


def is_command(text: str) -> bool:
    return bool(COMMAND.match(text or ""))


def server_hooks(base: str, timeout: float = 5):
    """count(text) and n_ctx() from llama-server (/tokenize, /props), cached n_ctx."""
    import urllib.request
    state = {}

    def post(path, body):
        r = urllib.request.Request(base() + path, json.dumps(body).encode("utf-8"), {"Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def count(text):
        return len(post("/tokenize", {"content": text}).get("tokens") or [])

    def n_ctx():
        if time.time() - state.get("t", 0) > 60:       # another model / -c may have been started since
            try:
                with urllib.request.urlopen(base() + "/props", timeout=timeout) as resp:
                    d = json.loads(resp.read().decode("utf-8"))
                state["n"] = int((d.get("default_generation_settings") or {}).get("n_ctx") or d.get("n_ctx") or 24576)
                state["t"] = time.time()
            except Exception:
                return state.get("n", 24576)
        return state["n"]
    return count, n_ctx
