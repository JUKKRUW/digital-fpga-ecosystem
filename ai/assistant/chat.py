"""
chat.py - what the assistant (the chat's ถาม-ตอบ mode, /api/assistant/chat) sends to the model.

One place decides the prompt and how much of each part goes in. The parts have their own budgets so
the context (llama-server -c 24576, shared with thinking and the answer) cannot be filled by one of
them: course notes, the open sheet (only when the question is about it), and the recent turns.
The old /ask (chat_server.ask_messages) stays as it is: the dataset and the eval call it.
"""
from __future__ import annotations

import re

SYSTEM = (
    "คุณคือผู้ช่วยในโปรแกรม Schematic Studio (FPGA Ecosystem) สำหรับวิชาดิจิทัลลอจิก "
    "ตอบเป็นภาษาไทยทั้งคำตอบ ใช้ศัพท์เทคนิคภาษาอังกฤษได้ (flip-flop, clock, entity) "
    "แต่ห้ามใช้อักษรจีน ญี่ปุ่น หรือเกาหลี และอย่าสลับไปตอบภาษาอื่นกลางประโยค\n\n"
    "สิ่งที่ช่วยได้: ความรู้ digital logic (พีชคณิตบูลีน, K-map, combinational, flip-flop, ตัวนับ, FSM), "
    "VHDL, FPGA Spartan-7 และวิธีใช้โปรแกรมนี้ เขียนและอธิบายโค้ด VHDL ได้ Python / C ทั่วไปก็ตอบได้\n\n"
    "วิธีตอบ:\n"
    "- คำถามสั้นตอบสั้น คำถามที่ขอให้อธิบายหรือเขียนโค้ด ตอบให้ครบเป็นขั้น ๆ\n"
    "- ใช้ markdown ได้: หัวข้อ, รายการ, **ตัวหนา**, ตาราง และโค้ดในบล็อก ``` พร้อมชื่อภาษา (```vhdl, ```python)\n"
    "- โค้ด VHDL เขียนให้ครบ entity + architecture ใช้ ieee.std_logic_1164 และ ieee.numeric_std "
    "เขียนแบบที่สังเคราะห์ใน Vivado ได้\n"
    "- อย่าบอกว่าโค้ด \"ตรวจแล้ว\" หรือ \"จำลองผ่านแล้ว\" เพราะคุณรันโค้ดเองไม่ได้ โปรแกรมจะตรวจให้ต่างหาก\n"
    "- ถ้ามีบันทึกจากเนื้อหาวิชาแนบมา ใช้เฉพาะส่วนที่ตรงกับคำถาม และอ้างเลขบันทึกในวงเล็บเหลี่ยม เช่น [1] "
    "ถ้าบันทึกไม่ตรงคำถาม ตอบจากความรู้ที่ถูกต้อง อย่าแต่งข้อเท็จจริงขึ้นเอง ไม่แน่ใจให้บอกว่าไม่แน่ใจ\n"
    "- ไม่ต้องสร้างหรือวาดวงจรเอง ถ้าผู้ใช้อยากให้วาด บอกให้ใช้ Schematic Studio (โหมด 'วาดวงจร' ในแชตของโปรแกรม)\n"
    "- ถ้ามี [สิ่งที่ผู้ใช้เคยบอกไว้] แนบมา ใช้ปรับคำตอบให้เข้ากับผู้ใช้ (เช่น วิธีที่ชอบให้อธิบาย) ไม่ต้องทวนให้ฟัง\n\n"
    "ข้อเท็จจริงของบอร์ด EDGE Spartan-7 (XC7S15) ที่ใช้ในวิชา: I/O 3.3 V (ไม่ใช่ 5 V), clock 50 MHz ที่ขา H11, "
    "7-segment 4 หลักแบบ common anode ขา a..g, dp และ an[3:0] เป็น active-low (0 = ติด), "
    "ปุ่มกด กด = 1 (active-high) pb[0]..pb[4] = บน ล่าง ซ้าย ขวา กลาง, สวิตช์เลื่อน 16 ตัว, LED 16 ดวง (1 = ติด)"
)

# budgets, in characters (Thai is ~1 token per 2-3 characters with Qwen's tokenizer)
NOTES_K = 4
NOTE_CHARS = 900
SHEET_CHARS = 2500
HISTORY_TURNS = 8
HISTORY_CHARS = 6000
TURN_CHARS = 1500

# the question is about the user's own work: only then does the open sheet go in
_MINE = re.compile(r"(วงจร|แผ่น|โค้ด|บล็อก|code|circuit|sheet)\s*(นี้|นี่|ของ(ผม|ฉัน|หนู|เรา|กู))|"
                   r"ของ(ผม|ฉัน|หนู|เรา)|ที่(ผม|ฉัน|หนู|เรา)(ทำ|วาด|เขียน)|ที่วาดอยู่|ที่เปิดอยู่|\bthis (circuit|sheet|code)\b|\bmy (circuit|sheet|code|design)\b",
                   re.I)


def about_my_work(question: str) -> bool:
    return bool(_MINE.search(question or ""))


def _clip(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[:n].rsplit(" ", 1)[0] + " …"


def notes_block(hits) -> str:
    rows = []
    for i, h in enumerate(hits or [], 1):
        head = " · ".join(x for x in (h.get("topic") or h.get("title") or "", h.get("source") or "") if x)
        txt = _clip(re.sub(r"[ \t]+", " ", h.get("text") or ""), NOTE_CHARS)
        rows.append(f"[{i}] {head}\n{txt}")
    if not rows:
        return ""
    return "[บันทึกจากเนื้อหาวิชา — อาจไม่ตรงคำถาม ใช้เฉพาะส่วนที่เกี่ยวข้อง]\n" + "\n\n".join(rows)


def sources(hits) -> list:
    """What the chat shows under the answer: the same numbers as in the prompt."""
    return [{"n": i, "title": h.get("title") or "", "topic": h.get("topic") or "", "source": h.get("source") or "",
             "group": h.get("group") or ""} for i, h in enumerate(hits or [], 1)]


def _history(history) -> list:
    """Last turns, newest kept first when the budget runs out; answers flagged ⚠ by the app are left out."""
    keep, used = [], 0
    for h in reversed([h for h in history or [] if h.get("role") in ("user", "assistant")][-HISTORY_TURNS:]):
        c = _clip(re.sub(r"<think>.*?</think>", "", str(h.get("content") or ""), flags=re.S), TURN_CHARS)
        if not c or c.startswith("⚠") or used + len(c) > HISTORY_CHARS:
            continue
        keep.append({"role": h["role"], "content": c})
        used += len(c)
    keep.reverse()
    while keep and keep[0]["role"] != "user":      # the template wants user first after system
        keep.pop(0)
    return keep


def messages(question: str, hits=None, sheet: str = "", history=None, mems: str = "") -> list:
    parts = []
    nb = notes_block(hits)
    if nb:
        parts.append(nb)
    if mems:
        parts.append(mems)
    if sheet and about_my_work(question):
        parts.append("[วงจรบนแผ่นที่ผู้ใช้เปิดอยู่]\n" + _clip(sheet, SHEET_CHARS))
    parts.append(question.strip())
    return [{"role": "system", "content": SYSTEM}] + _history(history) + \
        [{"role": "user", "content": "\n\n".join(parts)}]
