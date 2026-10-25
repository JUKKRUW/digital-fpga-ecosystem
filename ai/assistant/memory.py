"""
memory.py - what the assistant remembers about the user across conversations (stdlib only).

One sqlite file in the user's data folder (<data>/assistant.sqlite), never sent anywhere:
  memories(id, text, kind fact|preference|todo, created, last_used, pinned, uses)
Written when the user says "จำไว้ว่า …" (at once) or by the extractor after an answer (the same model,
held to a JSON schema). A new memory close to an old one (character-bigram overlap) replaces it, so a
changed fact ("ตอนนี้อยู่กลุ่ม 3") does not sit beside the old one. Read back by overlap with the question;
pinned ones always. Search is lexical on purpose: Thai has no spaces, bigrams work without a tokenizer
and need no embedding server running.
"""
from __future__ import annotations

import re
import sqlite3
import threading
import time
from pathlib import Path

KINDS = ("fact", "preference", "todo")
SIMILAR = 0.55          # bigram overlap above which a new memory replaces an old one
MAX_CHARS = 300

_EXPLICIT = re.compile(r"^\s*(?:ช่วย)?(?:จำ(?:ไว้)?(?:ด้วย)?(?:นะ)?(?:ว่า)?|remember(?: that)?)\s*[:：,]?\s*(.+)$", re.I | re.S)


def explicit(text: str) -> str:
    """'จำไว้ว่า ผมใช้บอร์ด EDGE' → 'ผมใช้บอร์ด EDGE' ('' when the message is not a request to remember)."""
    m = _EXPLICIT.match(text or "")
    return m.group(1).strip()[:MAX_CHARS] if m and len(m.group(1).strip()) >= 3 else ""


def _grams(s: str) -> set:
    s = re.sub(r"\s+", " ", (s or "").lower())
    words = set(re.findall(r"[a-z0-9_]{2,}", s))
    thai = re.sub(r"[^฀-๿]", "", s)
    return words | {thai[i:i + 2] for i in range(len(thai) - 1)}


def overlap(a: str, b: str) -> float:
    ga, gb = _grams(a), _grams(b)
    return len(ga & gb) / max(1, min(len(ga), len(gb))) if ga and gb else 0.0


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, text TEXT NOT NULL, "
                       "kind TEXT NOT NULL DEFAULT 'fact', created REAL, last_used REAL, pinned INTEGER DEFAULT 0, "
                       "uses INTEGER DEFAULT 0)")

    def _db(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def all(self) -> list:
        with self.lock, self._db() as db:
            return [dict(r) for r in db.execute("SELECT * FROM memories ORDER BY pinned DESC, created DESC")]

    def add(self, text: str, kind: str = "fact") -> dict:
        """Store (or replace the near-duplicate of) one memory; returns it."""
        text = re.sub(r"\s+", " ", text or "").strip()[:MAX_CHARS]
        if not text:
            return {}
        kind = kind if kind in KINDS else "fact"
        now = time.time()
        with self.lock, self._db() as db:
            for r in db.execute("SELECT id, text FROM memories"):
                if overlap(r["text"], text) >= SIMILAR:
                    db.execute("UPDATE memories SET text=?, kind=?, created=? WHERE id=?", (text, kind, now, r["id"]))
                    return {"id": r["id"], "text": text, "kind": kind, "replaced": r["text"]}
            cur = db.execute("INSERT INTO memories (text, kind, created, last_used) VALUES (?,?,?,?)", (text, kind, now, now))
            return {"id": cur.lastrowid, "text": text, "kind": kind}

    def update(self, mid: int, text: str = None, kind: str = None, pinned: bool = None) -> bool:
        sets, args = [], []
        if text is not None:
            sets.append("text=?"); args.append(re.sub(r"\s+", " ", text).strip()[:MAX_CHARS])
        if kind in KINDS:
            sets.append("kind=?"); args.append(kind)
        if pinned is not None:
            sets.append("pinned=?"); args.append(1 if pinned else 0)
        if not sets:
            return False
        with self.lock, self._db() as db:
            return db.execute(f"UPDATE memories SET {', '.join(sets)} WHERE id=?", args + [int(mid)]).rowcount > 0

    def delete(self, mid: int) -> bool:
        with self.lock, self._db() as db:
            return db.execute("DELETE FROM memories WHERE id=?", (int(mid),)).rowcount > 0

    def clear(self) -> int:
        with self.lock, self._db() as db:
            return db.execute("DELETE FROM memories").rowcount

    def search(self, query: str, k: int = 5) -> list:
        """Pinned memories, then the ones that share the most with the question (ties: most recent)."""
        rows = self.all()
        pinned = [r for r in rows if r["pinned"]]
        rest = sorted((r for r in rows if not r["pinned"]),
                      key=lambda r: (overlap(r["text"], query), r["created"] or 0), reverse=True)
        hits = pinned + [r for r in rest if overlap(r["text"], query) > 0.08]
        hits = hits[:k]
        if hits:
            with self.lock, self._db() as db:
                db.executemany("UPDATE memories SET last_used=?, uses=uses+1 WHERE id=?",
                               [(time.time(), r["id"]) for r in hits])
        return hits


def block(mems) -> str:
    if not mems:
        return ""
    return "[สิ่งที่ผู้ใช้เคยบอกไว้ (ความจำของผู้ช่วย) — ใช้เมื่อเกี่ยวข้อง]\n" + "\n".join(f"- {m['text']}" for m in mems)


# --- extraction: after an answer, the same model picks what is worth remembering ---------------------
# only for a message that says something about the user (a model call per turn would compete with the chat)
CUES = re.compile(r"(ผม|ฉัน|หนู|เรา|กู|ชื่อ|เรียน|กลุ่ม|เซค|sec|ปี\s*\d|บอร์ด|ชอบ|ไม่ชอบ|ไม่เข้าใจ|งง|อยากให้|ช่วยอธิบายแบบ|"
                  r"\bI am\b|\bI'm\b|\bmy name\b|\bI prefer\b|\bI don't understand\b)", re.I)

SCHEMA = {"name": "memories", "strict": True, "schema": {
    "type": "object", "additionalProperties": False, "required": ["items"],
    "properties": {"items": {"type": "array", "maxItems": 3, "items": {
        "type": "object", "additionalProperties": False, "required": ["text", "kind"],
        "properties": {"text": {"type": "string", "maxLength": 200}, "kind": {"type": "string", "enum": list(KINDS)}}}}}}}

EXTRACT_SYS = (
    "งานของคุณ: อ่านข้อความล่าสุดของผู้ใช้ แล้วดึงเฉพาะข้อมูลเกี่ยวกับตัวผู้ใช้ที่ควรจำไว้ใช้ในบทสนทนาครั้งต่อ ๆ ไป "
    "เช่น ชื่อ กลุ่มแลป บอร์ดที่ใช้ เรื่องที่ยังไม่เข้าใจ วิธีที่ชอบให้อธิบาย หรือสิ่งที่ตั้งใจจะทำ "
    "เขียนแต่ละข้อเป็นประโยคภาษาไทยสั้น ๆ ในรูปบุคคลที่สาม เช่น \"ผู้ใช้ชื่อเก่ง อยู่กลุ่มแลป 3\" "
    "kind: fact = ข้อเท็จจริง, preference = ความชอบ / วิธีที่อยากให้ตอบ, todo = สิ่งที่ตั้งใจจะทำหรือยังไม่เข้าใจ "
    "ห้ามจดความรู้ทั่วไป คำถามเรื่องวิชา หรือสิ่งที่ผู้ช่วยตอบ ถ้าไม่มีอะไรควรจำ ตอบ items เป็นรายการว่าง")


def should_extract(user_text: str) -> bool:
    return bool(CUES.search(user_text or "")) and not explicit(user_text)


def extract(backend, user_text: str) -> list:
    """[{text, kind}] the model found worth remembering in the user's message ([] on any failure)."""
    import json
    try:
        out = backend.complete([{"role": "system", "content": EXTRACT_SYS},
                                {"role": "user", "content": user_text[:2000]}],
                               think=False, temperature=0.2, max_tokens=300,
                               response_format={"type": "json_schema", "json_schema": SCHEMA}, timeout=120)
        items = json.loads(out["text"] or "{}").get("items") or []
        return [i for i in items if isinstance(i, dict) and str(i.get("text") or "").strip()][:3]
    except Exception:
        return []
