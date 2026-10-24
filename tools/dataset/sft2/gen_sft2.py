"""SFT2 data for the Schematic Studio agent — every tool call EXECUTED in the real app.

Each row is an agent conversation in OpenAI chat format (system / user / assistant+tool_calls /
tool / ... / assistant answer) with the agent's real system prompt and its real tool schemas.
Tool messages carry exactly what the in-app agent shows the model (JSON.stringify(result) clipped
at 6000, or 'ERROR: ...'). The final Thai answer is written from those results only, so it can
never claim a check that did not run.

Rows that teach recovery start with the mistake SFT1 actually makes; that assistant turn has
"weight": 0 (do not train on it) — the model learns what to do AFTER the error, not the error.

Usage:  python gen_sft2.py <out.jsonl> [--families split,probe,...] [--limit N] [--seed S]
Projects are created as sftg_* in the workspace and deleted again (nothing else is touched).
"""
import json, os, random, re, sys, time, traceback
from appcall import App

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = json.load(open(os.path.join(HERE, "tools.json"), encoding="utf-8"))["tools"]
SYS_BASE = open(os.path.join(HERE, "sysprompt.txt"), encoding="utf-8").read()

OUT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else os.path.join(HERE, "sft2.jsonl")
def opt(name, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default
FAMILIES = (opt("--families") or "split,probe,build,pins,multi,compose,spec,edit,qa").split(",")
LIMIT = int(opt("--limit", "0"))
rng = random.Random(int(opt("--seed", "7")))

app = App()
CREATED = []                       # projects this run made (only these are ever deleted)
COUNTER = [0]


# ------------------------------------------------------------------ app helpers
def call(name, args):
    ok, content, obj = app.call(name, args)
    return ok, obj, content


def fresh_project(stem):
    COUNTER[0] += 1
    name = f"sftg_{stem}_{COUNTER[0]}"
    for attempt in range(3):
        ok, obj, c = call("new_project", {"name": name})
        if ok:
            break
        time.sleep(5)
    if not ok:
        raise RuntimeError("new_project failed: " + c)
    # a real project's top sheet is not empty (an empty one makes every check warn about the top entity)
    call("build_circuit", {"sheet": "top", "formula": "led0 = sw0 & sw1"})
    real = obj.get("project", name) if isinstance(obj, dict) else name
    CREATED.append(real)
    # drop the previous generation project (never anything that is not ours)
    while len(CREATED) > 1:
        old = CREATED.pop(0)
        if old.startswith("sftg_"):
            call("delete_project", {"name": old, "files": True})
    return real


def project_line():
    ok, st, _ = call("status", {})
    sheets = "; ".join(f"{s['name']}{' (top)' if s.get('top') else ''}: {s.get('parts', 0)} parts" for s in st["sheets"])
    act = st.get("active_sheet")
    ports = ""
    if act:
        ok, gs, _ = call("get_sheet", {"sheet": act, "detail": "brief"})
        if ok and isinstance(gs, dict):
            ports = ", ".join(f"{p['dir']} {p['name']}" + (f"[{p['width'] - 1}:0]" if (p.get('width') or 1) > 1 else "")
                              for p in gs.get("ports") or [])
    return f"Project: {st['project']}. Sheets: {sheets}. Active sheet: {act or '-'}" + (f" (ports: {ports})" if ports else "") + "."


class Traj:
    def __init__(self, family, meta):
        self.family, self.meta, self.msgs, self.n = family, meta, [], 0

    def start(self, user_text):
        self.msgs = [{"role": "system", "content": SYS_BASE + "\n\n" + project_line()},
                     {"role": "user", "content": user_text}]

    def turn(self, calls, weight=1, content=""):
        tcs = []
        for name, args in calls:
            tcs.append({"id": f"call_{self.n}", "type": "function", "function": {"name": name, "arguments": args}})
            self.n += 1
        msg = {"role": "assistant", "content": content, "tool_calls": tcs}
        if weight != 1:
            msg["weight"] = weight
        self.msgs.append(msg)
        out = []
        for tc in tcs:
            ok, obj, content_str = call(tc["function"]["name"], tc["function"]["arguments"])
            self.msgs.append({"role": "tool", "tool_call_id": tc["id"], "content": content_str})
            out.append((ok, obj, content_str))
        return out

    def final(self, text):
        self.msgs.append({"role": "assistant", "content": text})

    def rows(self, user_variants, final_variants=None):
        """the same executed conversation, once per phrasing of the request (and answer)"""
        rows = []
        for i, u in enumerate(user_variants):
            m = json.loads(json.dumps(self.msgs, ensure_ascii=False))
            m[1]["content"] = u
            if final_variants:
                m[-1]["content"] = final_variants[i % len(final_variants)]
            rows.append({"messages": m, "tools": TOOLS, "meta": dict(self.meta, family=self.family, variant=i)})
        return rows


def pick(*xs):
    return rng.choice(xs)


def thai_num_list(xs):
    return ", ".join(str(x) for x in xs)


# ------------------------------------------------------------------ result readers
def check_line(obj):
    if not isinstance(obj, dict):
        return "check: ไม่ได้ผล"
    s = f"check: error {obj.get('errors', 0)}, warning {obj.get('warnings', 0)}"
    iss = [i.get("message") for i in (obj.get("issues") or []) if i.get("message")]
    if iss:
        s += " (" + "; ".join(iss[:2]) + ")"
    return s


def visible_period(sim_obj, sim_content, port="clk_out"):
    """period of `port` from the simulation — only if the cycles that show it fit in what the model sees"""
    try:
        vals = [v.get(port) for v in sim_obj.get("values") or []]
    except Exception:
        return None
    rises = [i for i in range(1, len(vals)) if vals[i] == 1 and vals[i - 1] == 0]
    if len(rises) < 2:
        return None
    p = rises[1] - rises[0]
    last = rises[1]
    if f'"cycle":{last},' not in sim_content:     # the model never saw it (result clipped at 6000)
        return None
    return p


# ------------------------------------------------------------------ family: split a divider into a cascade
FACTORS_ALL = [(50, 5, 10), (40, 4, 10), (25, 5, 5), (20, 4, 5), (60, 6, 10), (12, 3, 4), (30, 3, 10), (36, 6, 6),
           (16, 4, 4), (64, 8, 8), (45, 5, 9), (24, 4, 6), (15, 3, 5), (100, 10, 10), (80, 8, 10), (18, 3, 6),
           (32, 4, 8), (48, 6, 8), (21, 3, 7), (35, 5, 7), (28, 4, 7), (42, 6, 7), (56, 7, 8), (27, 3, 9)]

FACTORS = FACTORS_ALL[:16]

U_SPLIT = [
    "แผ่น div{N} มันใหญ่ไป ช่วยแตกเป็น div{a} ต่อกับ div{b} ให้หน่อย ขาเข้าออกขอ clk_in กับ clk_out เหมือนเดิม",
    "div {N} แก้เป็น clock_divider หาร {a} กับหาร {b} ต่อกัน",
    "อยากให้ div{N} ไม่เป็นก้อนเดียว แยกเป็นตัวหาร {a} แล้วต่อเข้าตัวหาร {b} แทนของเดิม ขาเดิมนะเพราะ top เรียกอยู่",
    "แตก div{N} เป็น div{a} → div{b} ทีครับ",
    "ช่วยทำ div{N} ใหม่ เอาตัวหาร {a} ต่อตัวหาร {b} แบบเรียงกัน (sync นะ ไม่ต้องคิดเอง) ขา clk_in clk_out เหมือนเดิม",
    "div{N} ใช้ FF เยอะ เปลี่ยนเป็นหาร {a} ต่อหาร {b} ได้ไหม",
]
U_SPLIT_NAMED = [
    "แผ่น div{N} มันใหญ่ไปหน่อย ช่วยทำแผ่น div{a} (หารความถี่ {a}) กับแผ่น div{b} (หาร {b}) แยกไว้ แล้วให้ div{N} เอา div{a} มาต่อกับ div{b} แทนของเดิม ขาเข้าออกชื่อ clk_in กับ clk_out เหมือนเดิมนะ เพราะ top มันเรียกอยู่",
    "ทำแผ่น div{a} กับ div{b} ให้หน่อย แล้วเปลี่ยน div{N} ให้เป็น div{a} ต่อ div{b}",
    "อยากได้แผ่นตัวหาร {a} ชื่อ div{a} กับตัวหาร {b} ชื่อ div{b} แล้วประกอบ div{N} ใหม่จากสองแผ่นนั้น",
]
U_SPLIT_SAME_NAMED = [
    "ทำแผ่น div{a} หาร {a} แล้วให้ div{N} เป็น div{a} สองตัวต่อกัน ขาเดิม",
    "div{N} แก้เป็นแผ่น div{a} สองตัวต่อกันให้หน่อย (ทำแผ่น div{a} ก่อนก็ได้)",
]


def setup_divider(N):
    fresh_project("div")
    kind = "jk_counter" if N <= 64 else "clock_divider"
    ok, o, c = call("build_part", {"kind": kind, "n": N, "sheet": f"div{N}"})
    if not ok:
        raise RuntimeError("setup " + c)
    call("build_hierarchy", {"sheet": "top", "replace": True, "blocks": [{"name": "dv", "sheet": f"div{N}"}],
                             "inputs": ["clk"], "outputs": ["tick"], "connect": [["clk", "dv.clk_in"], ["dv.clk_out", "tick"]]})
    call("open_sheet", {"sheet": f"div{N}"})


def split_answer(N, a, b, hres, cres, sres, scontent, named, note=""):
    blocks = (hres or {}).get("blocks") or []
    ver = all(bk.get("verified") for bk in blocks) if blocks else False
    und = (hres or {}).get("undriven_outputs") or []
    unc = (hres or {}).get("unconnected_block_inputs") or []
    leaf = f"div{a} → div{b}" if named else f"ตัวหาร {a} → ตัวหาร {b}"
    lines = [pick(f"แตก div{N} เป็น {leaf} แทนของเดิมแล้วครับ", f"เปลี่ยน div{N} เป็น {leaf} เรียบร้อย",
                  f"div{N} ตอนนี้เป็น {leaf} ต่อกันเป็นทอดแล้ว")]
    if note:
        lines.append(note)
    lines.append("- ขายังเป็น clk_in / clk_out เหมือนเดิม แผ่นที่เรียกใช้อยู่ (top) เลยไม่ต้องแก้")
    lines.append(f"- ต่อสายครบ {hres.get('connected_bits')} จุด" + ("" if not (und or unc) else f" แต่ยังมีขาค้าง: {', '.join(und + unc)}")
                 + ("" if (und or unc) else " ไม่มีขาลอย"))
    lines.append("- " + check_line(cres))
    if ver:
        lines.append("- บล็อกย่อยทั้งสองผ่านการตรวจ (verified)")
    p = visible_period(sres, scontent) if sres else None
    if p:
        lines.append(f"- จำลองแล้ว clk_out กลับมาขึ้นทุก {p} clock = หาร {p}")
    else:
        lines.append(f"- หารรวม {a} × {b} = {N}")
    return "\n".join(lines)


def fam_split(N, a, b, variant):
    setup_divider(N)
    named = variant in ("named", "named_same")
    meta = {"N": N, "a": a, "b": b, "variant": variant}
    T = Traj("split", meta)
    if variant == "named":
        users = [u.format(N=N, a=a, b=b) for u in rng.sample(U_SPLIT_NAMED, min(2, len(U_SPLIT_NAMED)))]
    elif variant == "named_same":
        users = [u.format(N=N, a=a, b=b) for u in U_SPLIT_SAME_NAMED]
    else:
        users = [u.format(N=N, a=a, b=b) for u in rng.sample(U_SPLIT, 3)]
    T.start(users[0])
    T.turn([("get_sheet", {"sheet": f"div{N}", "detail": "brief"})])
    na, nb = (f"d{a}", f"d{b}") if a != b else (f"d{a}a", f"d{a}b")
    if variant == "named":
        T.turn([("build_part", {"kind": "clock_divider", "n": a, "sheet": f"div{a}"}),
                ("build_part", {"kind": "clock_divider", "n": b, "sheet": f"div{b}"})])
        blocks = [{"name": na, "sheet": f"div{a}"}, {"name": nb, "sheet": f"div{b}"}]
    elif variant == "named_same":
        T.turn([("build_part", {"kind": "clock_divider", "n": a, "sheet": f"div{a}"})])
        blocks = [{"name": na, "sheet": f"div{a}"}, {"name": nb, "sheet": f"div{a}"}]
    else:
        blocks = [{"name": na, "part": "clock_divider", "params": {"n": a}}, {"name": nb, "part": "clock_divider", "params": {"n": b}}]
    connect = [["clk_in", f"{na}.clk_in"], [f"{na}.clk_out", f"{nb}.clk_in"], [f"{nb}.clk_out", "clk_out"]]
    good = {"sheet": f"div{N}", "replace": True, "blocks": blocks, "inputs": ["clk_in"], "outputs": ["clk_out"], "connect": connect}
    note = ""
    if variant == "rec_replace":            # SFT1: forgets replace on a sheet that has parts
        bad = dict(good); bad.pop("replace")
        T.turn([("build_hierarchy", bad)], weight=0)
    elif variant == "rec_connect":          # SFT1: no connect -> auto joins clk_in to both blocks
        bad = dict(good); bad.pop("connect")
        r = T.turn([("build_hierarchy", bad)], weight=0)
        note = "- รอบแรกให้ต่ออัตโนมัติ clk_in เลยเข้าทั้งสองบล็อกพร้อมกันและ clk_out ลอย จึงสร้างใหม่โดยระบุ connect ให้ต่อเป็นทอด"
    elif variant == "rec_buildpart":        # SFT1's usual opening move
        T.turn([("build_part", {"kind": "clock_divider", "n": a, "sheet": f"div{N}"})], weight=0)
    (ok, hres, _), = T.turn([("build_hierarchy", good)])
    if not ok:
        raise RuntimeError("good build_hierarchy failed")
    cyc = min(2 * N + 2, 256)
    (ok1, cres, _), (ok2, sres, scont) = T.turn([("check", {"sheet": f"div{N}"}), ("simulate", {"sheet": f"div{N}", "cycles": cyc})])
    T.final(split_answer(N, a, b, hres, cres, sres, scont, named, note))
    return T.rows(users)


def gen_split():
    rows = []
    variants = ["parts", "parts", "named", "rec_replace", "rec_connect", "rec_buildpart"]
    for (N, a, b) in FACTORS:
        for v in variants:
            if v == "named" and a == b:
                v = "named_same"
            try:
                rows += fam_split(N, a, b, v)
            except Exception as e:
                print("  split fail", N, a, b, v, e)
            yield_rows(rows); rows = []
    return rows


# ------------------------------------------------------------------ family: "if inputs X, does Y happen?" -> probe
PROBE_SHEETS = [
    ("chk", "err = sw3&(sw2|sw1)", ["sw3", "sw2", "sw1"], "err", "ไฟ err"),
    ("alarm", "alarm = door&armed | smoke", ["door", "armed", "smoke"], "alarm", "สัญญาณ alarm"),
    ("eq2", "eq = ~(a1^b1) & ~(a0^b0)", ["a1", "a0", "b1", "b0"], "eq", "eq"),
    ("maj", "y = a&b | b&c | a&c", ["a", "b", "c"], "y", "y"),
    ("gt2", "gt = a1&~b1 | ~(a1^b1)&a0&~b0", ["a1", "a0", "b1", "b0"], "gt", "gt"),
    ("bad7", "err = sw6&sw5 | sw6&sw4", ["sw6", "sw5", "sw4"], "err", "ไฟ error"),
]


def probe_question(name, ins, out, label, assign):
    on = [k for k in ins if assign[k] == 1]
    off = [k for k in ins if assign[k] == 0]
    sw = all(re.match(r"sw\d+$", k) for k in ins)
    forms = []
    if on and off:
        forms.append(f"ถ้า {' '.join(on)} เป็น 1 ที่เหลือเป็น 0 {label} จะติดไหม")
        forms.append(f"ลองเทสหน่อย {', '.join(f'{k}={assign[k]}' for k in ins)} แล้ว {out} ออกเท่าไร")
    elif on:
        forms.append(f"ถ้าทุกขาเป็น 1 หมด {label} ติดไหม")
        forms.append(f"เปิด {' '.join(on)} หมดเลย {out} เป็นอะไร")
    else:
        forms.append(f"ถ้าทุกขาเป็น 0 {label} ติดไหม")
        forms.append(f"ปิดหมดทุกขา {out} ออกมาเป็นเท่าไร")
    forms.append(f"แผ่น {name}: ถ้า {', '.join(f'{k}={assign[k]}' for k in ins)} {out} จะเป็น 1 ไหม")
    return forms


def fam_probe(sheet, formula, ins, out, label, assign):
    fresh_project("probe")
    ok, o, c = call("build_circuit", {"sheet": sheet, "formula": formula})
    if not ok:
        raise RuntimeError(c)
    call("open_sheet", {"sheet": sheet})
    T = Traj("probe", {"sheet": sheet, "assign": assign})
    users = probe_question(sheet, ins, out, label, assign)
    T.start(users[0])
    (ok, res, _), = T.turn([("probe", {"sheet": sheet, "inputs": dict(assign)})])
    v = (res or {}).get("outputs", {}).get(out)
    yes = v == 1
    ans = [pick(f"{'ติด' if yes else 'ไม่ติด'}ครับ — probe ด้วย {', '.join(f'{k}={assign[k]}' for k in ins)} ได้ {out} = {v}",
                f"ลองป้อนจริงแล้ว: {', '.join(f'{k}={assign[k]}' for k in ins)} → {out} = {v} ({'ติด' if yes else 'ไม่ติด'})")]
    T.final(ans[0])
    return T.rows(users)


def gen_probe():
    for (sheet, formula, ins, out, label) in PROBE_SHEETS:
        combos = set()
        while len(combos) < min(8, 2 ** len(ins)):
            combos.add(tuple(rng.randint(0, 1) for _ in ins))
        for cmb in combos:
            try:
                yield_rows(fam_probe(sheet, formula, ins, out, label, dict(zip(ins, cmb))))
            except Exception as e:
                print("  probe fail", sheet, cmb, e)


# ------------------------------------------------------------------ family: build, then check + simulate before answering
BUILDS = [
    ("clock_divider", {"n": 3}, "div3", "ทำแผ่นชื่อ div3 เป็นตัวหารความถี่ 3"),
    ("clock_divider", {"n": 6}, "div6", "ขอตัวหารความถี่ 6 ชื่อแผ่น div6"),
    ("clock_divider", {"n": 7}, "tick7", "ทำแผ่นชื่อ tick7 เป็นตัวหารความถี่ 7 ให้หน่อย"),
    ("clock_divider", {"n": 12}, "div12", "สร้าง div12 หารความถี่ 12"),
    ("mod_counter", {"n": 6}, "cnt6", "ทำตัวนับ mod 6 แผ่นชื่อ cnt6"),
    ("mod_counter", {"n": 10}, "cnt10", "อยากได้ตัวนับ 0-9 ชื่อ cnt10"),
    ("mod_counter", {"n": 12}, "cnt12", "ตัวนับ mod-12 ให้หน่อย ตั้งชื่อ cnt12"),
    ("jk_counter", {"n": 5}, "jk5", "ทำตัวนับ JK mod 5 ชื่อ jk5 แบบในแลป"),
    ("comparator", {"n": 4}, "cmp4", "ทำตัวเปรียบเทียบ 4 บิต ชื่อแผ่น cmp4"),
    ("comparator", {"n": 2}, "cmp2", "ขอ comparator 2 บิต แผ่น cmp2"),
    ("adder", {"n": 4}, "add4", "ทำตัวบวก 4 บิต ชื่อ add4"),
    ("adder", {"n": 2, "cin": False}, "add2", "ตัวบวก 2 บิตไม่มี cin ชื่อ add2"),
    ("mux", {"n": 4}, "mux4", "ทำ mux 4:1 ชื่อ mux4"),
    ("decoder", {"n": 2}, "dec2", "ทำ decoder 2 to 4 ชื่อ dec2"),
    ("decoder", {"n": 3}, "dec3", "decoder 3 เป็น 8 ชื่อแผ่น dec3"),
    ("bcd_7seg", {"active_low": True}, "seg", "ทำตัวแปลง BCD เป็น 7-seg สำหรับบอร์ด EDGE ชื่อ seg"),
    ("parity", {"n": 4}, "par4", "ทำ parity generator 4 บิต ชื่อ par4"),
    ("majority", {}, "maj", "ทำวงจร majority 3 อินพุต ชื่อ maj"),
    ("full_adder", {}, "fa", "ขอ full adder ชื่อแผ่น fa"),
    ("half_subtractor", {}, "hs", "ทำ half subtractor ชื่อ hs"),
    ("edge_detector", {}, "edge", "ทำตัวจับขอบขาขึ้น ชื่อ edge"),
    ("toggle", {}, "tog", "ทำ toggle flip-flop ชื่อ tog กดปุ่มแล้วสลับ"),
    ("bcd_valid", {}, "bcdchk", "ทำวงจรเช็คเลข BCD ว่าเกิน 9 ไหม ชื่อ bcdchk"),
    ("counter_digit", {"m": 10}, "dig10", "ทำตัวนับ 1 หลัก 0-9 มี en ชื่อ dig10"),
]
SEQ = {"clock_divider", "mod_counter", "jk_counter", "edge_detector", "toggle", "counter_digit", "bcd_counter", "debounce"}


def build_answer(kind, sheet, bres, cres, sres, scont):
    lines = [f"สร้าง {kind} ลงแผ่น {sheet} แล้วครับ"]
    ports = (bres or {}).get("ports") or []
    if ports:
        ins = [p["name"] for p in ports if p["dir"] == "in"]
        outs = [p["name"] for p in ports if p["dir"] == "out"]
        lines.append(f"- ขาเข้า: {', '.join(ins)} · ขาออก: {', '.join(outs)}")
    v = (bres or {}).get("verified") or {}
    if isinstance(v, dict) and v.get("pass"):
        lines.append(f"- ตรวจกับโมเดลอ้างอิงผ่าน ({v.get('method')})")
    lines.append("- " + check_line(cres))
    if sres and isinstance(sres, dict):
        if kind == "clock_divider":
            p = visible_period(sres, scont)
            if p:
                lines.append(f"- จำลองแล้ว clk_out ขึ้นทุก {p} clock")
            else:
                lines.append("- จำลองแล้ว (ผลยาว ดูคาบเต็มไม่ได้ในหน้าจอนี้)")
        else:
            lines.append(f"- จำลองแล้ว {len(sres.get('rows') or sres.get('values') or [])} แถว")
    return "\n".join(lines)


def fam_build(kind, params, sheet, user, recover=False):
    fresh_project("build")
    T = Traj("build", {"kind": kind, "params": params, "recover": recover})
    variants = [user, user.replace("ทำ", "ช่วยทำ", 1) if "ทำ" in user else user + " หน่อย"]
    T.start(variants[0])
    args = dict(params, kind=kind, sheet=sheet)
    (ok, bres, _), = T.turn([("build_part", args)])
    if not ok:
        raise RuntimeError("build fail")
    sim = {"sheet": sheet}
    if kind in SEQ:
        sim["cycles"] = min(2 * int(params.get("n", params.get("m", 8))) + 4, 40)
    (ok1, cres, _), (ok2, sres, scont) = T.turn([("check", {"sheet": sheet}), ("simulate", sim)])
    T.final(build_answer(kind, sheet, bres, cres, sres, scont))
    return T.rows(variants)


def gen_build():
    for (kind, params, sheet, user) in BUILDS:
        try:
            yield_rows(fam_build(kind, params, sheet, user))
        except Exception as e:
            print("  build fail", kind, e)


# ------------------------------------------------------------------ family: board pins in everyday words
PIN_WORDS = [
    ("led_err", "ไฟ led_err ไปที่ LED0", "led:0"), ("led_ok", "led_ok ไปที่ LED ดวงที่ 1", "led:1"),
    ("led_run", "led_run ไป LED 2", "led:2"), ("btn", "btn ไปปุ่มกลาง", "pb:4"), ("start", "start ไปปุ่มบน", "pb:0"),
    ("stop", "stop เป็นปุ่มล่าง", "pb:1"), ("set", "set ไปปุ่มซ้าย", "pb:2"), ("reset", "reset ไปปุ่มขวา", "pb:3"),
    ("sw_a", "sw_a ไปสวิตช์ 0", "sw:0"), ("sw_b", "sw_b ไปสวิตช์ตัวที่ 1", "sw:1"), ("en", "en ไป SW 7", "sw:7"),
    ("clk", "clk ไปนาฬิกา 50 MHz", "clk"), ("buzz", "buzz ไปที่ buzzer", "buzzer"),
]


def fam_pins(sel):
    fresh_project("pins")
    ins = [p for p in sel if p[2].startswith(("sw", "pb", "clk"))]
    outs = [p for p in sel if not p[2].startswith(("sw", "pb", "clk"))]
    if not ins or not outs:
        raise RuntimeError("need in and out")
    formula = [f"{o[0]} = " + " & ".join(i[0] for i in ins) for o in outs]
    ok, o, c = call("build_circuit", {"sheet": "top", "formula": formula, "replace": True})
    if not ok:
        raise RuntimeError(c)
    call("open_sheet", {"sheet": "top"})
    T = Traj("pins", {"sel": [s[0] for s in sel]})
    words = " · ".join(s[1] for s in sel)
    users = [f"ต่อขาให้หน่อย: {words}", f"เลือกขาลงบอร์ด {words}"]
    T.start(users[0])
    (ok, res, _), = T.turn([("set_pins", {"sheet": "top", "map": {s[0]: s[2] for s in sel}})])
    if not ok:
        raise RuntimeError("set_pins")
    pins = {p["port"]: (p.get("target"), p.get("pin")) for p in res.get("pins") or []}
    lines = ["ต่อขาให้แล้วครับ"] + [f"- {k} → {pins[k][0]} (ขา {pins[k][1]})" for k in [s[0] for s in sel] if k in pins]
    un = res.get("unassigned") or []
    if un:
        lines.append(f"- ยังไม่ได้เลือก: {', '.join(un)}")
    T.final("\n".join(lines))
    return T.rows(users)


def gen_pins():
    for _ in range(30):
        k = rng.randint(2, 4)
        sel = rng.sample(PIN_WORDS, k)
        try:
            yield_rows(fam_pins(sel))
        except Exception as e:
            print("  pins fail", e)


# ------------------------------------------------------------------ family: several things in one message
MULTI = [
    [("clock_divider", {"n": 4}, "div4"), ("clock_divider", {"n": 10}, "div10")],
    [("mod_counter", {"n": 6}, "cnt6"), ("mod_counter", {"n": 10}, "cnt10")],
    [("comparator", {"n": 4}, "cmp"), ("bcd_7seg", {"active_low": True}, "seg")],
    [("clock_divider", {"n": 5}, "div5"), ("clock_divider", {"n": 2}, "div2"), ("clock_divider", {"n": 3}, "div3")],
    [("full_adder", {}, "fa"), ("half_adder", {}, "ha")],
    [("decoder", {"n": 2}, "dec2"), ("mux", {"n": 2}, "mux2")],
]
KIND_TH = {"clock_divider": "ตัวหารความถี่ {n}", "mod_counter": "ตัวนับ mod {n}", "comparator": "ตัวเปรียบเทียบ {n} บิต",
           "bcd_7seg": "BCD เป็น 7-seg", "full_adder": "full adder", "half_adder": "half adder", "decoder": "decoder {n} บิต",
           "mux": "mux {n}:1"}


def fam_multi(items):
    fresh_project("multi")
    T = Traj("multi", {"items": [i[2] for i in items]})
    desc = [f"แผ่น {s} เป็น{KIND_TH[k].format(**p)}" for k, p, s in items]
    users = ["ทำ" + " กับ".join(desc) + " ให้หน่อย", "ขอ " + ", ".join(desc)]
    T.start(users[0])
    res = T.turn([("build_part", dict(p, kind=k, sheet=s)) for k, p, s in items])
    if not all(r[0] for r in res):
        raise RuntimeError("multi build")
    chk = []
    for k, p, s in items:
        chk.append(("check", {"sheet": s}))
    cres = T.turn(chk)
    lines = ["ทำให้ครบแล้วครับ"]
    for (k, p, s), (okb, b, _), (okc, c, _) in zip(items, res, cres):
        v = (b or {}).get("verified") or {}
        lines.append(f"- {s}: {KIND_TH[k].format(**p)} · {'ตรวจผ่าน' if isinstance(v, dict) and v.get('pass') else 'สร้างแล้ว'} · {check_line(c)}")
    T.final("\n".join(lines))
    return T.rows(users)


def gen_multi():
    for items in MULTI:
        try:
            yield_rows(fam_multi(items))
        except Exception as e:
            print("  multi fail", e)


# ------------------------------------------------------------------ family: put existing sheets together (blocks: sheet)
def ports_of(res):
    return [(p["name"], p["dir"]) for p in (res or {}).get("ports") or []]


def fam_compose(k_div, use_dp):
    fresh_project("comp")
    ok, rdv, c1 = call("build_part", {"kind": "clock_divider", "n": k_div, "sheet": "clkdiv"})
    ok2, rcn, c2 = call("build_part", {"kind": "mod_counter", "n": 10, "sheet": "cnt10"})
    ok3, rsg, c3 = call("build_part", {"kind": "bcd_7seg", "active_low": True, "sheet": "seg"})
    if not (ok and ok2 and ok3):
        raise RuntimeError("compose setup")
    call("open_sheet", {"sheet": "top"})
    cn_out = [n for n, d in ports_of(rcn) if d == "out"]
    sg_in = [n for n, d in ports_of(rsg) if d == "in"]
    sg_out = [n for n, d in ports_of(rsg) if d == "out"]
    cn_in = [n for n, d in ports_of(rcn) if d == "in"]
    if len(cn_out) != len(sg_in):
        raise RuntimeError(f"widths {cn_out} {sg_in}")
    T = Traj("compose", {"k": k_div})
    users = [f"ประกอบแผ่น sys จากแผ่น clkdiv cnt10 กับ seg ที่มีอยู่ ให้ clk เข้า clkdiv แล้ว clkdiv ออกไปเป็น clock ของ cnt10 ค่าที่นับไปแสดงที่ seg ออกขา {' '.join(sg_out)}",
             f"ต่อ clkdiv → cnt10 → seg เป็นแผ่นใหม่ชื่อ sys หน่อย ขาเข้า clk ขาออกเป็นขา 7-seg",
             f"สร้าง sys: clk → clkdiv.clk_in, clkdiv.clk_out → cnt10, ค่านับเข้า seg, ออก {sg_out[0]}..{sg_out[-1]}"]
    T.start(users[0])
    cn_clk = cn_in[0]
    connect = [["clk", "dv.clk_in"], ["dv.clk_out", f"cn.{cn_clk}"]]
    for qo, bi in zip(sorted(cn_out), sorted(sg_in)):
        connect.append([f"cn.{qo}", f"sg.{bi}"])
    for so in sg_out:
        connect.append([f"sg.{so}", so])
    (ok, hres, _), = T.turn([("build_hierarchy", {"sheet": "sys", "blocks": [{"name": "dv", "sheet": "clkdiv"}, {"name": "cn", "sheet": "cnt10"}, {"name": "sg", "sheet": "seg"}],
                                                  "inputs": ["clk"], "outputs": sg_out, "connect": connect})])
    if not ok:
        raise RuntimeError("compose bh")
    (ok, cres, _), = T.turn([("check", {"sheet": "sys"})])
    und = (hres or {}).get("undriven_outputs") or []
    T.final("\n".join([f"สร้างแผ่น sys จาก clkdiv → cnt10 → seg แล้วครับ",
                       f"- ต่อสายครบ {hres.get('connected_bits')} จุด" + (f" ยังค้าง: {', '.join(und)}" if und else " ไม่มีขาลอย"),
                       "- " + check_line(cres),
                       f"- clkdiv หาร {k_div} ก่อนเข้า cnt10 แล้วค่าที่นับ (0-9) ไปแสดงบน 7-seg"]))
    return T.rows(users)


def gen_compose():
    for k in [2, 3, 4, 5, 8, 10]:
        try:
            yield_rows(fam_compose(k, False))
        except Exception as e:
            print("  compose fail", e)


# ------------------------------------------------------------------ family: write the spec from the REQUEST, build, check_spec
SPECS = [
    ("prime3", ["x2", "x1", "x0"], [2, 3, 5, 7], "p", "ทำวงจร 3 บิต x2 x1 x0 ให้ p = 1 เมื่อเป็นจำนวนเฉพาะ (2 3 5 7) ชื่อแผ่น prime3"),
    ("div3", ["x2", "x1", "x0"], [0, 3, 6], "y", "ทำวงจร y = 1 เมื่อ x (3 บิต) หารด้วย 3 ลงตัว แผ่น div3chk"),
    ("ge5", ["x2", "x1", "x0"], [5, 6, 7], "big", "big = 1 เมื่อค่า x2x1x0 มากกว่าหรือเท่ากับ 5 ชื่อ ge5"),
    ("odd4", ["x3", "x2", "x1", "x0"], [1, 3, 5, 7, 9, 11, 13, 15], "odd", "odd = 1 เมื่อเลข 4 บิตเป็นเลขคี่ แผ่น odd4"),
    ("sq4", ["x3", "x2", "x1", "x0"], [0, 1, 4, 9], "sq", "sq = 1 เมื่อ x (4 บิต) เป็นเลขยกกำลังสอง (0 1 4 9) ชื่อ sq4"),
]


def fam_spec(name, ins, ones, out, user):
    fresh_project("spec")
    sheet = re.search(r"(?:แผ่น|ชื่อ)\s*([A-Za-z_][A-Za-z0-9_]*)\s*$", user).group(1)
    T = Traj("spec", {"sheet": sheet})
    users = [user, user + " แล้วเช็คให้ด้วยว่าถูก"]
    T.start(users[0])
    table = {"inputs": ins, "ones": {out: ones}}
    (ok, r1, _), = T.turn([("set_spec", {"sheet": sheet, "table": table})])
    (ok2, r2, _), = T.turn([("build_circuit", {"sheet": sheet, "truth_table": table})])
    if not ok2:
        raise RuntimeError("spec build")
    (ok3, r3, c3), (ok4, r4, _) = T.turn([("check_spec", {"sheet": sheet}), ("check", {"sheet": sheet})])
    passed = isinstance(r3, dict) and (r3.get("pass") is True or (r3.get("ok") and r3.get("pass") is not False))
    T.final("\n".join([f"สร้างแผ่น {sheet} แล้วครับ ({out} = 1 เมื่อ {', '.join(map(str, ones))})",
                       "- ตั้งข้อกำหนดจากโจทย์ก่อน แล้วค่อยสร้าง",
                       f"- check_spec: {'ผ่าน' if passed else 'ไม่ผ่าน'} ({json.dumps({k: r3.get(k) for k in ('pass', 'rows', 'checked') if isinstance(r3, dict) and k in r3}, ensure_ascii=False)})",
                       "- " + check_line(r4)]))
    return T.rows(users)


def gen_spec():
    for s in SPECS:
        try:
            yield_rows(fam_spec(*s))
        except Exception as e:
            print("  spec fail", s[0], e)


# ------------------------------------------------------------------ family: small edits (delete refs, update) + report what broke
def fam_edit_delete(N):
    fresh_project("edit")
    call("build_part", {"kind": "jk_counter", "n": N, "sheet": f"cnt{N}"})
    call("open_sheet", {"sheet": f"cnt{N}"})
    T = Traj("edit", {"N": N})
    users = ["ลบ ff0 กับ ff1 ออกจากแผ่นนี้หน่อย", "เอา ff0 ff1 ออกไปที"]
    T.start(users[0])
    (ok, r, _), = T.turn([("delete", {"sheet": f"cnt{N}", "refs": ["ff0", "ff1"]})])
    (okc, c, _), = T.turn([("check", {"sheet": f"cnt{N}"})])
    nu = (r or {}).get("now_unconnected") or []
    T.final("\n".join([f"ลบ {', '.join((r or {}).get('deleted') or [])} ออกแล้วครับ",
                       (f"- ขาที่ตอนนี้ไม่มีอะไรต่อ: {', '.join(nu[:8])}" + (" …" if len(nu) > 8 else "")) if nu else "- ไม่มีขาลอยเพิ่ม",
                       "- " + check_line(c) + (" — วงจรยังใช้งานไม่ได้จนกว่าจะต่อส่วนที่หายไปใหม่" if (c or {}).get("errors") else "")]))
    return T.rows(users)


def gen_edit():
    for N in [5, 6, 10, 12]:
        try:
            yield_rows(fam_edit_delete(N))
        except Exception as e:
            print("  edit fail", e)


# ------------------------------------------------------------------ family: plain questions (no tools)
QA = [
    ("7-seg บนบอร์ด EDGE ติดเมื่อเป็น 0 หรือ 1", "บนบอร์ด EDGE เป็น 7-seg แบบ common anode ครับ ทุกเซกเมนต์ a..g, dp และขาเลือกหลัก an[3:0] เป็น active-low — ส่ง 0 = ติด, 1 = ดับ"),
    ("ปุ่มบนบอร์ดกดแล้วเป็น 0 หรือ 1", "ปุ่มบนบอร์ด EDGE กดแล้วได้ 1 ครับ ปล่อยเป็น 0"),
    ("ทำไมตัวนับต้องมีตัวหารความถี่", "เพราะนาฬิกาบนบอร์ดเป็น 50 MHz ครับ ถ้าป้อนตรงๆ ตัวนับจะเปลี่ยนค่า 50 ล้านครั้งต่อวินาที ตาคนมองไม่ทัน จึงหารให้ช้าลงก่อน (เช่นหาร 50,000,000 ได้ 1 Hz) หรือใช้พัลส์ enable 1 Hz คุมตัวนับที่ยังใช้นาฬิกา 50 MHz"),
    ("JK flip-flop ต่างจาก D flip-flop ยังไง", "D flip-flop เก็บค่า D ตอนขอบนาฬิกา (Q ← D) ส่วน JK มีสองขา: J=K=0 ค้างค่า, J=1 K=0 เซต, J=0 K=1 รีเซต, J=K=1 สลับค่า — JK จึงใช้ทำตัวนับ/ตัวหารได้สะดวกเพราะสลับค่าได้เอง"),
    ("synchronous counter กับ ripple counter ต่างกันยังไง", "แบบ synchronous ทุก flip-flop ใช้นาฬิกาเดียวกัน เปลี่ยนค่าพร้อมกัน ไม่มีหน่วงสะสม ส่วน ripple เอา Q ของตัวก่อนไปเป็นนาฬิกาตัวถัดไป ทำง่ายแต่ค่าจะเปลี่ยนไล่กันทีละตัว (มีช่วงค่าผิดชั่วคราว) — บน FPGA ควรใช้แบบ synchronous"),
    ("หาร 50 แบบต่อ หาร 5 กับ หาร 10 ได้ duty 50% ไหม", "ได้ครับถ้าเอาหาร 5 ไว้ก่อนแล้วหาร 10 ปิดท้าย เพราะขาออกสุดท้ายมาจากตัวหารคู่ (10) ซึ่งให้ 50% — ถ้าสลับเอาหาร 5 ไว้ท้าย duty จะไม่ 50% เพราะหารเลขคี่"),
    ("BCD คืออะไร", "BCD (Binary-Coded Decimal) คือเก็บเลขฐานสิบทีละหลักด้วย 4 บิต ค่า 0000–1001 (0–9) ใช้ได้ ส่วน 1010–1111 (10–15) ไม่ใช่ BCD ที่ถูกต้อง"),
    ("debounce ปุ่มทำไปทำไม", "เพราะหน้าสัมผัสปุ่มเด้งตอนกด สัญญาณจะกระพริบ 0/1 หลายครั้งในไม่กี่มิลลิวินาที วงจรจะนึกว่ากดหลายที debounce คือรอให้ค่านิ่งก่อน (เช่นต้องเป็น 1 ติดกันหลาย clock ที่ ~100 Hz) แล้วค่อยนับเป็นการกด 1 ครั้ง"),
]


def gen_qa():
    fresh_project("qa")
    for q, a in QA:
        T = Traj("qa", {})
        T.start(q)
        T.final(a)
        yield_rows(T.rows([q]))


# ------------------------------------------------------------------ driver
# ------------------------------------------------------------------ extra: switches as ONE number (sw:'0x..')
GROUP_SHEETS = [("err8", "err = sw3&(sw2|sw1) | sw7&(sw6|sw5)", "err", "ไฟ error"),
                ("odd8", "odd = sw0 ^ sw1 ^ sw2 ^ sw3 ^ sw4 ^ sw5 ^ sw6 ^ sw7", "odd", "odd"),
                ("big8", "big = sw7 | sw6&sw5", "big", "ไฟ big")]


def fam_probe_group(sheet, formula, out, label, v):
    fresh_project("pgrp")
    ok, o, c = call("build_circuit", {"sheet": sheet, "formula": formula})
    if not ok:
        raise RuntimeError(c)
    call("open_sheet", {"sheet": sheet})
    T = Traj("probe_group", {"sheet": sheet, "v": v})
    on = [k for k in range(8) if v >> k & 1]
    users = [f"ถ้าตั้ง sw เป็น 0x{v:02X} {label} จะติดไหม", f"ลองเทสหน่อย สวิตช์ทั้ง 8 ตัวเป็นค่า {v} แล้ว {out} ออกเท่าไร"]
    if on and on == list(range(on[0], on[-1] + 1)):
        users.append(f"ถ้า sw{on[0]} ถึง sw{on[-1]} เป็น 1 หมด ที่เหลือเป็น 0 {label} ติดไหม")
    T.start(users[0])
    (ok, res, cont), = T.turn([("probe", {"sheet": sheet, "inputs": {"sw": f"0x{v:02X}"}})])
    if not ok:
        raise RuntimeError(cont)
    r = (res or {}).get("outputs", {}).get(out)
    T.final(f"{'ติด' if r == 1 else 'ไม่ติด'}ครับ — probe ด้วย sw = 0x{v:02X} (" + (" ".join(f"sw{k}" for k in on) + " เป็น 1" if on else "ทุกตัวเป็น 0") + f") ได้ {out} = {r}")
    return T.rows(users)


def gen_probe_group():
    for (sheet, formula, out, label) in GROUP_SHEETS:
        vals = {0x0F, 0xF0, 0x00, 0xFF} | {rng.randint(0, 255) for _ in range(6)}
        for v in sorted(vals):
            try:
                yield_rows(fam_probe_group(sheet, formula, out, label, v))
            except Exception as e:
                print("  probe_group fail", sheet, v, e)


# ------------------------------------------------------------------ extra: compose without connect -> read the result -> fix
def fam_compose_rec(k_div):
    fresh_project("comprec")
    ok, rdv, _ = call("build_part", {"kind": "clock_divider", "n": k_div, "sheet": "clkdiv"})
    ok2, rcn, _ = call("build_part", {"kind": "clock_divider", "n": 10, "sheet": "div10"})
    if not (ok and ok2):
        raise RuntimeError("setup")
    call("open_sheet", {"sheet": "top"})
    T = Traj("compose_rec", {"k": k_div})
    users = [f"ทำแผ่นใหม่ชื่อ slow ประกอบจากแผ่น clkdiv กับ div10 ที่มีอยู่ ให้ clk เข้า clkdiv แล้วขาออกของ clkdiv ไปเข้า div10 ออกเป็น tick",
             f"ต่อ clkdiv แล้วตามด้วย div10 เป็นแผ่น slow หน่อย ขาเข้า clk ขาออก tick"]
    T.start(users[0])
    base = {"sheet": "slow", "blocks": [{"name": "a", "sheet": "clkdiv"}, {"name": "b", "sheet": "div10"}], "inputs": ["clk"], "outputs": ["tick"]}
    T.turn([("build_hierarchy", dict(base))], weight=0)            # SFT1: leaves the wiring to auto
    good = dict(base, replace=True, connect=[["clk", "a.clk_in"], ["a.clk_out", "b.clk_in"], ["b.clk_out", "tick"]])
    (ok, h, _), = T.turn([("build_hierarchy", good)])
    if not ok:
        raise RuntimeError("good")
    (okc, c, _), = T.turn([("check", {"sheet": "slow"})])
    und = h.get("undriven_outputs") or []
    T.final("\n".join(["สร้างแผ่น slow แล้วครับ: clk → clkdiv → div10 → tick",
                       "- รอบแรกไม่ได้ระบุ connect ขาจึงต่อไม่ครบ เลยสร้างใหม่ (replace) พร้อมบอกทุกเส้น",
                       f"- ต่อสายครบ {h.get('connected_bits')} จุด" + (f" ยังค้าง {', '.join(und)}" if und else " ไม่มีขาลอย"),
                       "- " + check_line(c), f"- หารรวม {k_div} × 10 = {k_div * 10}"]))
    return T.rows(users)


def gen_compose_rec():
    for k in [2, 3, 4, 5, 6, 8]:
        try:
            yield_rows(fam_compose_rec(k))
        except Exception as e:
            print("  compose_rec fail", e)


def gen_pins_more():
    ins_w = [p for p in PIN_WORDS if p[2].startswith(("sw", "pb", "clk"))]
    outs_w = [p for p in PIN_WORDS if not p[2].startswith(("sw", "pb", "clk"))]
    for _ in range(20):
        sel = rng.sample(ins_w, rng.randint(1, 3)) + rng.sample(outs_w, rng.randint(1, 2))
        rng.shuffle(sel)
        try:
            yield_rows(fam_pins(sel))
        except Exception as e:
            print("  pins fail", e)


class Limit(BaseException):
    pass


_out = None
_count = [0]


def yield_rows(rows):
    for r in rows:
        _out.write(json.dumps(r, ensure_ascii=False) + "\n")
        _count[0] += 1
    _out.flush()
    if LIMIT and _count[0] >= LIMIT:
        raise Limit()


GENS = {"split": gen_split, "probe": gen_probe, "build": gen_build, "pins": gen_pins, "multi": gen_multi,
        "compose": gen_compose, "spec": gen_spec, "edit": gen_edit, "qa": gen_qa,
        "probe_group": gen_probe_group, "compose_rec": gen_compose_rec, "pins_more": gen_pins_more}
# VHDL blocks (vhdl_block): vhdl, vhdl_fix, vhdl_sem — see vhdl_families.py
import vhdl_families  # noqa: E402
GENS.update(vhdl_families.install(globals()))

if __name__ == "__main__":
    ok, st, _ = call("status", {})
    was = st.get("project") if isinstance(st, dict) else None
    print("user project was:", was)
    t0 = time.time()
    with open(OUT, "w", encoding="utf-8") as f:
        _out = f
        try:
            for fam in FAMILIES:
                n0 = _count[0]; t1 = time.time()
                try:
                    GENS[fam]()
                except Limit:
                    raise
                except Exception:
                    traceback.print_exc()
                print(f"[{fam}] +{_count[0] - n0} rows in {time.time() - t1:.0f}s", flush=True)
        except Limit:
            print("limit reached")
    # back to the user's project FROM MEMORY (export_project switches to it; open_project would
    # reload it from disk and drop unsaved edits), then delete only our own sftg_* projects
    if was:
        call("export_project", {"name": was})
    for p in list(CREATED):
        if p.startswith("sftg_"):
            call("delete_project", {"name": p, "files": True})
    ok, st, _ = call("status", {})
    print("editor is back on:", (st or {}).get("project") if isinstance(st, dict) else st)
    print(f"wrote {_count[0]} rows to {OUT} in {time.time() - t0:.0f}s")
    app.close()
