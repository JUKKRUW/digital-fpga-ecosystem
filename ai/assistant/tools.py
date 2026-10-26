"""
tools.py - what the assistant model may look up itself (the proxy runs the calls; stdlib only).

  search_course(query)  the course notes (the launcher's rag_search), 3 hits, clipped
  find_parts(query)     this app's library: parts, ready-made VHDL blocks, design tools (catalog.json,
                        exported from the editor by tools/assistant/export_catalog.js)
  app_help(topic)       how to do something in the program (app_guide.md, one section per topic)

Results are short on purpose: every token here is context the conversation cannot use. Lexical search
(words + Thai character bigrams), no embedding server needed.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
COURSE_K = 3
COURSE_CHARS = 650
PARTS_K = 7
HELP_K = 2

SCHEMAS = [
    {"type": "function", "function": {
        "name": "search_course",
        "description": "ค้นเนื้อหาวิชาดิจิทัลลอจิก (บทเรียน ใบงานแลป ขาบอร์ด EDGE ตัวอย่าง VHDL ที่ตรวจแล้ว) "
                       "ใช้เมื่อต้องการข้อเท็จจริงเฉพาะของวิชา / แลป / บอร์ด ที่ไม่แน่ใจ",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "คำค้นสั้น ๆ เช่น 'JK flip-flop excitation table' หรือ 'แลป 7 ตัวนับถอยหลัง'"}},
            "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "find_parts",
        "description": "ค้นคลังชิ้นส่วนของโปรแกรม (ชิ้นส่วนสำเร็จ บล็อก VHDL เครื่องมือสร้างวงจร) ได้ชื่อ หน้าที่ ขา และค่าที่ตั้งได้ "
                       "ใช้ทุกครั้งที่ผู้ใช้ถามว่าจะสร้างวงจรนี้ต้องใช้อะไร หรือประกอบระบบจากหลายบล็อก",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "หน้าที่ที่ต้องการ เช่น 'ตัวนับ BCD', 'หารความถี่', '7-segment หลายหลัก', 'debounce ปุ่ม'"}},
            "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "board_info",
        "description": "ข้อเท็จจริงของบอร์ด EDGE Spartan-7 ที่แน่นอน: ขั้วสัญญาณ (active-low/high) ของ 7-segment, an, ปุ่ม, LED, "
                       "ขา clock, ตำแหน่งปุ่ม pb0–pb4 และปุ่มตามใบงานแลป — ใช้ก่อนตอบเรื่องขาหรือขั้วสัญญาณของบอร์ดทุกครั้ง",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "app_help",
        "description": "วิธีใช้โปรแกรม FPGA Ecosystem / Schematic Studio (เมนู ขั้นตอน เลือกขา จำลอง ลงบอร์ด FSM spec รายงาน)",
        "parameters": {"type": "object", "properties": {
            "topic": {"type": "string", "description": "เรื่องที่อยากรู้ เช่น 'เลือกขาบอร์ด', 'ประกอบหลายบล็อก', 'ลงบอร์ด'"}},
            "required": ["topic"]}}},
]
NAMES = {s["function"]["name"] for s in SCHEMAS}

# from ai/board/edge_spartan7.xdc and the lab sheets (pin presets in editor/ux/41-board-fix.js). In the test run
# Qwen3.5 9B answered "an is active-high" with only lab notes in front of it, against its own system prompt:
# a board question now gets this card first, as a tool result.
BOARD_FACTS = """ข้อเท็จจริงบอร์ด EDGE Spartan-7 (XC7S15) — ยืนยันจากไฟล์ขาของบอร์ด ใช้ตามนี้เท่านั้น:
- I/O 3.3 V (LVCMOS33) ไม่ใช่ 5 V · clock 50 MHz ที่ขา H11
- จอ 7-segment 4 หลัก แบบ common anode:
  · ขา a–g และ dp เป็น active-low: ส่ง 0 = ส่วนนั้นติด, 1 = ดับ
  · ขาเลือกหลัก an[3:0] เป็น active-low ด้วย: an(i) = 0 = เปิดหลัก i, 1 = ปิด (เช่น เปิดหลัก 0 อย่างเดียว: an = "1110")
  · แสดงหลายหลักต้องสแกน (time-multiplexing) ทีละหลักเร็วพอให้ตาเห็นติดพร้อมกัน (ราว 1 kHz ต่อรอบสแกน หรือ ≥ 60 Hz ต่อหลัก)
  · ในคลังมี seg7_mux4 / seg7_num ที่ทำทั้งถอดรหัสและสแกนให้แล้ว
- ปุ่มกด pb[0]–pb[4] active-high (กด = 1, มี PULLDOWN): pb0 = บน (J13), pb1 = ล่าง (L13), pb2 = ซ้าย (J14), pb3 = ขวา (J11), pb4 = กลาง (J12)
  ปุ่มเด้ง (bounce) ต้องผ่าน debounce / one_pulse ก่อนใช้นับครั้งที่กด
- สวิตช์เลื่อน SW0–SW15: ขึ้น = 1 · LED 0–15: 1 = ติด
- ปุ่มตามใบงาน: แลป 6 ปุ่ม START/STOP = pb4 (กลาง) · แลป 7 SET = pb2 (ซ้าย), START/STOP = pb0 (บน), RESET = pb4 (กลาง),
  เวลาเริ่มต้นจาก SW[15:0], LED0 = error, LED1 = time-up
- จอ LCD 16×2 (HD44780), ADC MCP3208 (SPI), UART, buzzer มีบนบอร์ด — ขาดูได้ในหน้าเลือกขาของโปรแกรม"""

# a Thai question finds English notes too ("แลป 7" → Lab7: the lab sheets are indexed as Lab7-2569)
_EXPAND = [(r"แลป\s*(\d+)", lambda m: f"Lab{m.group(1)} lab {m.group(1)}"), (r"7\s*-?\s*seg|เจ็ดส่วน", lambda m: "7-segment seg an"),
           (r"ปุ่ม", lambda m: "push button pb"), (r"สวิตช์", lambda m: "switch SW"), (r"หารความถี่", lambda m: "frequency divider"),
           (r"ตัวนับ", lambda m: "counter"), (r"นับถอยหลัง", lambda m: "countdown"), (r"ไฟ\s*led|แอลอีดี", lambda m: "LED")]


def expand_query(q: str) -> str:
    extra = []
    for pat, rep in _EXPAND:
        for m in re.finditer(pat, q, re.I):
            extra.append(rep(m))
    return q + (" " + " ".join(dict.fromkeys(extra)) if extra else "")


# the functions a question asks for → the library category each one lives in: find_parts keeps the best part
# of every category the question names (a 00–99 button counter on the 7-seg got counters + buttons only and the
# model then said the library has no 7-seg part)
_NEEDS = [(r"7\s*-?\s*seg|เจ็ดส่วน|segment|ตัวเลขบนจอ", "จอ 7-segment"), (r"นับ|counter", "ตัวนับ"),
          (r"ปุ่ม|button|กดปุ่ม|debounce|เด้ง|ขอบ", "ปุ่มกด / ขอบสัญญาณ"), (r"หารความถี่|divider|\bhz\b|วินาที|นาที|นาฬิกา", "นาฬิกา / หารความถี่"),
          (r"บวก|ลบ|คูณ|หาร(?!ความถี่)|adder|subtract|multipl", "บวก / ลบ / คูณ / หาร"), (r"\bled\b|ไฟวิ่ง|pwm", "ไฟ LED / PWM"),
          (r"lcd|adc|uart|buzzer|เสียง|แสง|ldr", "อุปกรณ์บนบอร์ด (LCD, ADC, UART, เสียง)"), (r"mux|demux|decoder|encoder|ถอดรหัส", "MUX / DEMUX / Decoder / Encoder"),
          (r"bcd|แปลงรหัส|binary|ฐานสิบ", "แปลงรหัส"), (r"เปรียบเทียบ|compar|มากกว่า|น้อยกว่า", "เปรียบเทียบ / ตรวจสอบ"),
          (r"register|shift|เลื่อนบิต|flip.?flop", "Flip-flop / Register"), (r"\balu\b", "ALU"), (r"fsm|state|สถานะ", "เครื่องมือออกแบบ")]
_BOARD_Q = re.compile(r"(บอร์ด|board|edge|7\s*-?\s*seg|เจ็ดส่วน|\ban\b|ขาไหน|ปุ่มไหน|ปุ่ม\s*(set|start|stop|reset)|active.?(low|high)|ติด|ดับ|\bpb\d?|\bsw\d|led)", re.I)

# A question about the program, its library or a lab is looked up BY THE APP first, with the whole question
# as the query, and handed to the model as if it had made that call (it may still search more). Left to
# itself at the chat's temperature, Qwen3.5 9B skipped the call now and then and made up menu names
# ("Assign Pins") and the 7-seg polarity; llama-server ignores tool_choice "required" with its template.
_PARTS_Q = re.compile(r"(คลัง|โมดูล|ชิ้นส่วน|บล็อก|ต้องใช้อะไร|ใช้อะไรบ้าง|ใช้อะไรดี|ประกอบ|ต่อกัน|library|module|part)", re.I)
_APP_Q = re.compile(r"(โปรแกรม|แอป|เมนู|หน้าต่าง|เลือกขา|จำลอง|ลงบอร์ด|รายงาน|ข้อกำหนด|schematic|studio|vivado|\bspec\b)", re.I)
_COURSE_Q = re.compile(r"(แลป|ใบงาน|\blab\b|บอร์ด|ขาไหน|\bpin\b|edge)", re.I)


def lab_sheet(n: str):
    """Lab n's sheet (ai/rag/labs/Lab<n>-*.json) as one hit: title, objectives, what each item asks."""
    labs = HERE.parent / "rag" / "labs"
    f = next((p for p in sorted(labs.glob("Lab*.json")) if re.fullmatch(rf"Lab_?{int(n)}[-_].*", p.stem, re.I)), None)
    if not f:
        return None
    try:
        d = json.loads(f.read_text("utf-8"))
    except Exception:
        return None
    items = " · ".join(re.sub(r"\s+", " ", str(it.get("question") or ""))[:450] for it in (d.get("items") or [])[:3])
    text = f"วัตถุประสงค์: {'; '.join(d.get('objectives') or [])} · งาน: {items}"
    return {"title": d.get("title") or f.stem, "topic": f"ใบงานแลป {int(n)}: {d.get('title') or ''}", "source": f.stem + ".pdf",
            "group": "labs", "text": text}


def prefetch(question: str) -> list:
    """[(tool, args)] the app runs before the model's first round (none for a general question)."""
    q = (question or "").strip()[:300]
    out = []
    if _BOARD_Q.search(q):
        out.append(("board_info", {}))
    if _PARTS_Q.search(q):
        out.append(("find_parts", {"query": q}))
    if _APP_Q.search(q):
        out.append(("app_help", {"topic": q}))
    if _COURSE_Q.search(q) and not any(n in ("find_parts", "app_help") for n, _ in out):
        out.append(("search_course", {"query": q}))
    return out


def _grams(s: str) -> set:
    s = (s or "").lower()
    words = set(re.findall(r"[a-z0-9_]{2,}", s))
    thai = re.sub(r"[^฀-๿]", "", s)
    return words | {thai[i:i + 2] for i in range(len(thai) - 1)}


def _score(q: set, text: str) -> float:
    g = _grams(text)
    return len(q & g) / (len(q) ** 0.5 * max(1, len(g)) ** 0.25) if q and g else 0.0


class Toolbox:
    def __init__(self, rag=None):
        """rag(query, k) -> [{"title","topic","source","group","text"}] (the launcher's rag_search hits)."""
        self.rag = rag
        self._cat = None
        self._guide = None

    # --- data ---
    def catalog(self) -> list:
        if self._cat is None:
            try:
                d = json.loads((HERE / "catalog.json").read_text("utf-8"))
            except Exception:
                d = {}
            rows = [dict(p, source="ชิ้นส่วนสำเร็จ") for p in d.get("parts") or []]
            rows += [dict(v, source="บล็อก VHDL สำเร็จรูป") for v in d.get("vhdl") or []]
            rows += [dict(kind=g["id"], label=g["name"], description=g.get("description") or "", category="เครื่องมือออกแบบ",
                          source="เครื่องมือออกแบบ") for g in d.get("generators") or []]
            self._cat = rows
        return self._cat

    def guide(self) -> list:
        if self._guide is None:
            try:
                txt = (HERE / "app_guide.md").read_text("utf-8")
            except Exception:
                txt = ""
            self._guide = [("## " + s).strip() for s in re.split(r"^## ", txt, flags=re.M)[1:]]
        return self._guide

    # --- calls ---
    def call(self, name: str, args: dict, sources: list) -> str:
        """Run one call; course hits are added to `sources` (numbered on from what is there)."""
        try:
            if name == "search_course":
                return self.search_course(str(args.get("query") or ""), sources)
            if name == "find_parts":
                return self.find_parts(str(args.get("query") or ""))
            if name == "app_help":
                return self.app_help(str(args.get("topic") or args.get("query") or ""))
            if name == "board_info":
                return BOARD_FACTS
            return f"ไม่มีเครื่องมือชื่อ {name} — ใช้ได้: " + ", ".join(sorted(NAMES))
        except Exception as e:
            return f"เครื่องมือ {name} ผิดพลาด: {type(e).__name__}: {e}"

    def search_course(self, query: str, sources: list) -> str:
        hits = (self.rag(expand_query(query), COURSE_K) if self.rag else []) or []
        lab = re.search(r"(?:แลป|lab)\s*(\d+)", query, re.I)
        sheet = lab_sheet(lab.group(1)) if lab else None
        if sheet:
            # a question about one lab: its sheet first, read from the file (the index ranked "แลป 7" as Lab9)
            hits = [sheet] + [h for h in hits if sheet["source"].split("-")[0].lower() not in (h.get("source") or "").lower()][:COURSE_K - 1]
        if not hits:
            return "ไม่พบเนื้อหาวิชาที่ตรง — ตอบจากความรู้ที่แน่ใจ หรือบอกว่าไม่แน่ใจ"
        rows = []
        for h in hits[:COURSE_K]:
            n = len(sources) + 1
            sources.append({"n": n, "title": h.get("title") or "", "topic": h.get("topic") or "", "source": h.get("source") or "",
                            "group": h.get("group") or ""})
            head = " · ".join(x for x in (h.get("topic") or h.get("title") or "", h.get("source") or "") if x)
            txt = re.sub(r"\s+", " ", h.get("text") or "").strip()
            if len(txt) > COURSE_CHARS:
                txt = txt[:COURSE_CHARS].rsplit(" ", 1)[0] + " …"
            rows.append(f"[{n}] {head}\n{txt}")
        return "\n\n".join(rows) + "\n\n(อ้างเลข [n] เมื่อใช้ข้อมูลนี้)"

    def find_parts(self, query: str) -> str:
        q = _grams(query)
        score = lambda r: _score(q, " ".join(str(r.get(k) or "") for k in ("kind", "label", "category", "description")))
        rows = [r for r in self.catalog() if r["kind"] != "library"]     # (the library window itself)
        ranked = sorted(rows, key=score, reverse=True)[:PARTS_K]
        # every function the question names gets its category's best part, if the ranking left it out
        for pat, cat in _NEEDS:
            if re.search(pat, query, re.I):
                # the category's own best match for the function's words (not for the whole question)
                fq = _grams(" ".join(m.group(0) for m in re.finditer(pat, query, re.I)) + " " + cat)
                best = max((r for r in rows if r.get("category") == cat), default=None,
                           key=lambda r: _score(fq, " ".join(str(r.get(k) or "") for k in ("kind", "label", "description"))))
                if best is not None and best not in ranked:
                    ranked.append(best)
        if not ranked:
            return "คลังชิ้นส่วนยังไม่ถูกสร้าง (catalog.json)"
        out = []
        for r in ranked:
            line = f"- {r['kind']} — {r['label']} [{r['source']} · หมวด {r.get('category') or '-'}]: {r.get('description') or ''}"
            pt = r.get("ports") or {}
            if pt:
                line += f"\n  ขาเข้า: {', '.join(pt.get('in') or []) or '-'} · ขาออก: {', '.join(pt.get('out') or []) or '-'}"
            if r.get("params"):
                line += "\n  ตั้งค่าได้: " + "; ".join(f"{k} = {v}" for k, v in r["params"].items())
            if r.get("sequential"):
                line += " · มี clock"
            out.append(line)
        return ("ผลจากคลังของโปรแกรม (Tools ▸ คลังชิ้นส่วนและโมดูล; ขาที่แสดงคือค่าเริ่มต้น):\n" + "\n".join(out)
                + "\n(ถ้าไม่มีตัวที่ตรง ลองค้นด้วยคำอื่น หรือแนะนำให้วาดเอง / เขียนบล็อก VHDL)")

    def app_help(self, topic: str) -> str:
        q = _grams(topic)
        secs = sorted(self.guide(), key=lambda s: _score(q, s), reverse=True)[:HELP_K]
        return "\n\n".join(secs) if secs else "ไม่มีคู่มือ"
