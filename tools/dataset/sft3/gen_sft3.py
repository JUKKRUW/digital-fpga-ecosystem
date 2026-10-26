"""SFT3 data for the Schematic Studio agent (plan: PLAN.md §1) — every tool call EXECUTED in the real app,
like SFT2 (../sft2/gen_sft2.py, whose machinery this reuses: Traj, call, fresh_project, project cleanup).

New families, each aimed at what the SFT2 model got wrong in the v2.7.1 report:
  probe_bits   the bits the user names go in as bits / a range, never a worked-out number; the answer quotes the
               probe's own inputs / outputs (replaces SFT2's probe_group, whose answers narrated precomputed bits)
  stop_check   check + simulate once, then answer; a repeated check gets the app's "unchanged — answer now"
               result (what srRecheck answers in the app) and the next turn answers
  edit_report  renames, gate type changes, deletes, adds → the answer says WHAT was done, from the tool results,
               in several wordings (SFT2's answers were one template, copied into unrelated tasks)
  tool_cover   tools SFT2 never showed: verify_truth_table, simulate {vectors}, explain_simulation, get_pins,
               board_check, save_module / use_module, search_course, apply, disconnect
  dup_blocks   several blocks of one part in one composition, each with its own name (d5a / d5b / d5c, m0 / m1 / m2),
               incl. recovering from an unknown block name
  locked       a sheet the user locked: the app's error, then the work goes to <name>_new and the answer says so
  sim_cycles   a divider / counter of N is simulated over ≥ 2N clocks and the answer reads summary.period / duty
  qa_plain     knowledge questions answered without tools (answers written by an open-weight model and judged —
               the qa_mode rows of ../data/train.jsonl.gz), and questions ABOUT a sheet answered by reading /
               simulating only
Plus the SFT2 families again (everything but probe_group), regenerated against this app: replay that sees the
same tools and prompt as everything else.

  FE_APP_ENV=<env.json from ../sft2/serve_app.js> python3 gen_sft3.py <out.jsonl> [--families a,b] [--seed S]
"""
import gzip, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SFT2 = os.path.join(HERE, "..", "sft2")
sys.path.insert(0, SFT2)
OUT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else os.path.join(HERE, "sft3.jsonl")
_argv = sys.argv[:]
sys.argv = [sys.argv[0], OUT]            # gen_sft2 reads its own options at import
import gen_sft2 as G                     # noqa: E402
sys.argv = _argv

# this round's tool schemas / prompt (dump_prompt.js, /api/agent/tools of the app the data is made with)
G.TOOLS = json.load(open(os.path.join(HERE, "tools.json"), encoding="utf-8"))["tools"]
G.SYS_BASE = open(os.path.join(HERE, "sysprompt.txt"), encoding="utf-8").read()


def opt(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


rng = random.Random(int(opt("--seed", "11")))
G.rng = rng
call, Traj, fresh_project, check_line, yield_rows = G.call, G.Traj, G.fresh_project, G.check_line, G.yield_rows
pick = lambda *xs: rng.choice(xs)
UNCHANGED = ("(system) Nothing on this sheet changed since you last ran {tool} with these arguments — this is the same "
             "result. Do not run it again: answer the user now.")


def fake_turn(T, name, args, content, weight=1):
    """a call whose tool message is what the in-app agent's wrappers answer (not reachable over MCP)"""
    tc = {"id": f"call_{T.n}", "type": "function", "function": {"name": name, "arguments": args}}
    T.n += 1
    msg = {"role": "assistant", "content": "", "tool_calls": [tc]}
    if weight != 1:
        msg["weight"] = weight
    T.msgs.append(msg)
    T.msgs.append({"role": "tool", "tool_call_id": tc["id"], "content": content})


def cycles_for(n):
    """enough clocks for simulate's summary to name the period: it skips the first quarter as start-up and
    needs two whole periods after that — about 3N (2N, what SFT2 taught, often showed period null)"""
    return min(3 * n + 8, 256)


def one(v):
    return v.get("value") if isinstance(v, dict) else v


def on_off(v):
    return "ติด" if v == 1 else "ไม่ติด"


# ------------------------------------------------------------------ probe_bits
SW_SHEETS = [
    ("errchk", "err = sw1 & sw2 & sw3 & ~sw5", "err", "ไฟ err"),
    ("err8", "err = sw3&(sw2|sw1) | sw7&(sw6|sw5)", "err", "ไฟ error"),
    ("odd4", "odd = sw0 ^ sw1 ^ sw2 ^ sw3", "odd", "ไฟ odd"),
    ("win6", "win = sw2 & sw3 & sw4 | sw6 & ~sw2", "win", "ไฟ win"),
    ("pass5", "ok = sw0 & sw1 & ~sw2 | sw4 & sw5", "ok", "ไฟ ok"),
    ("big8", "big = sw7 | sw6&sw5", "big", "ไฟ big"),
    ("lock4", "unlock = sw0 & ~sw1 & sw2 & sw3", "unlock", "ไฟ unlock"),
    ("any8", "alarm = sw0|sw1|sw2|sw3|sw4|sw5|sw6|sw7", "alarm", "สัญญาณ alarm"),
]


def sw_inputs(formula):
    return sorted({int(x) for x in re.findall(r"sw(\d+)", formula)})


def probe_answer(res, out, label, style):
    ins = res.get("inputs") or {}
    v = one((res.get("outputs") or {}).get(out))
    ones = [k for k, x in ins.items() if one(x) == 1]
    given = ", ".join(f"{k}={one(x)}" for k, x in ins.items()) or "ทุกขาเป็น 0"
    if style == 0:
        return f"{on_off(v)}ครับ — probe ด้วย {given} (ขาที่ไม่ได้ใส่เป็น 0) ได้ {out} = {v}"
    if style == 1:
        return f"ลองป้อนจริงแล้ว: {given} → {out} = {v} ดังนั้น{label}{on_off(v)}"
    if style == 2:
        return f"{label}{on_off(v)} ({out} = {v})\n- ขาที่เป็น 1: {', '.join(ones) if ones else 'ไม่มี'}\n- ที่เหลือเป็น 0"
    return f"ผล probe: {out} = {v} → {on_off(v)}ครับ (ป้อน {given})"


def fam_probe_bits(sheet, formula, out, label, kind, sel):
    fresh_project("pbit")
    ok, o, c = call("build_circuit", {"sheet": sheet, "formula": formula})
    if not ok:
        raise RuntimeError(c)
    call("open_sheet", {"sheet": sheet})
    T = Traj("probe_bits", {"sheet": sheet, "kind": kind, "sel": sel})
    if kind == "range":
        lo, hi = sel
        users = [f"ถ้าตั้ง sw{lo} ถึง sw{hi} เป็น 1 หมด ที่เหลือเป็น 0 {label}จะติดไหม ลองเทสให้หน่อย",
                 f"sw{lo}-sw{hi} เป็น 1 ที่เหลือ 0 {out} ออกเท่าไร",
                 f"เปิดสวิตช์ {lo} ถึง {hi} แล้ว{label}ติดหรือเปล่า"]
        args = {f"sw[{hi}:{lo}]": "1" * (hi - lo + 1)}
    elif kind == "list":
        users = [f"เปิด {' กับ '.join(f'sw{k}' for k in sel)} ที่เหลือปิด {label}ติดไหม",
                 f"ถ้า {', '.join(f'sw{k}=1' for k in sel)} {out} เป็นอะไร",
                 f"ลองดูหน่อยถ้า {' '.join(f'sw{k}' for k in sel)} เป็น 1 {label}จะติดหรือไม่"]
        args = {f"sw{k}": 1 for k in sel}
    elif kind == "gap":
        lo, hi = sel
        users = [f"เปิด sw{lo} ถึง sw{hi} หมดเลย {label}ติดไหม", f"ถ้า sw{lo}-sw{hi} เป็น 1 ทั้งหมด {out} ออกเท่าไร"]
        args = {f"sw[{hi}:{lo}]": "1" * (hi - lo + 1)}
    else:                                   # the user gave the number
        v = sel
        users = [f"ถ้าตั้ง sw เป็น 0x{v:02X} {label}จะติดไหม", f"สวิตช์ทั้ง 8 ตัวเป็นค่า {v} (ฐานสิบ) {out} ออกเท่าไร"]
        args = {"sw": f"0x{v:02X}"}
    T.start(users[0])
    note = ""
    if kind == "gap":                       # the range hits a missing switch: the app names it → the bits that exist
        (ok, res, cont), = T.turn([("probe", {"sheet": sheet, "inputs": args})], weight=0)
        if ok:
            raise RuntimeError("gap probe passed")
        have = [k for k in sw_inputs(formula) if lo <= k <= hi]
        missing = [k for k in range(lo, hi + 1) if k not in have]
        args = {f"sw{k}": 1 for k in have}
        note = f"\n(แผ่นนี้ไม่มี {', '.join(f'sw{k}' for k in missing)} เลยป้อนเฉพาะสวิตช์ที่มี)"
    (ok, res, cont), = T.turn([("probe", {"sheet": sheet, "inputs": args})])
    if not ok:
        raise RuntimeError(cont)
    T.final(probe_answer(res, out, label, rng.randrange(4)) + note)
    return T.rows(users)


def gen_probe_bits():
    for (sheet, f, out, label) in SW_SHEETS:
        bits = sw_inputs(f)
        cases = set()
        runs, cur = [], [bits[0]]
        for b in bits[1:]:
            if b == cur[-1] + 1: cur.append(b)
            else: runs.append(cur); cur = [b]
        runs.append(cur)
        for _ in range(5):
            r = rng.choice(runs); lo = rng.choice(r); hi = rng.choice([b for b in r if b >= lo])
            cases.add(("range", (lo, hi)))
        if len(runs) > 1:                    # a range over a switch the sheet does not have
            cases.add(("gap", (runs[0][0], runs[1][-1])))
        for _ in range(3):
            cases.add(("list", tuple(sorted(rng.sample(bits, rng.randint(1, min(3, len(bits))))))))
        if max(bits) == 7:
            for _ in range(2):
                cases.add(("number", rng.randrange(256)))
        for kind, sel in sorted(cases, key=str):
            try:
                yield_rows(fam_probe_bits(sheet, f, out, label, kind, sel))
            except Exception as e:
                print("  probe_bits fail", sheet, kind, sel, e)


# ------------------------------------------------------------------ stop_check
STOP_BUILDS = [("clock_divider", {"n": 4}, "div4", "ทำตัวหารความถี่ 4 แผ่นชื่อ div4"),
               ("clock_divider", {"n": 9}, "div9", "ขอตัวหาร 9 ชื่อแผ่น div9"),
               ("mod_counter", {"n": 7}, "cnt7", "ทำตัวนับ mod 7 ชื่อ cnt7"),
               ("mod_counter", {"n": 5}, "cnt5", "ตัวนับ 0 ถึง 4 แผ่น cnt5"),
               ("adder", {"n": 3}, "add3", "ตัวบวก 3 บิตชื่อ add3"),
               ("comparator", {"n": 3}, "cmp3", "ตัวเปรียบเทียบ 3 บิต แผ่น cmp3"),
               ("mux", {"n": 2}, "mx2", "mux 2:1 แผ่น mx2"),
               ("decoder", {"n": 2}, "dc2", "decoder 2-to-4 ชื่อ dc2"),
               ("parity", {"n": 3}, "par3", "parity 3 บิต ชื่อ par3"),
               ("full_subtractor", {}, "fs", "full subtractor ชื่อแผ่น fs")]


def build_summary(kind, sheet, b, c, s):
    ports = (b or {}).get("ports") or []
    ins = ", ".join(p["name"] for p in ports if p["dir"] == "in")
    outs = ", ".join(p["name"] for p in ports if p["dir"] == "out")
    per = None
    if isinstance(s, dict) and s.get("summary"):
        per = {k: v.get("period") for k, v in s["summary"].items() if v.get("period")}
    rows = len((s or {}).get("rows") or []) if isinstance(s, dict) else 0
    if per:
        sim = f"จำลอง {s.get('clocks')} clock: " + ", ".join(f"{k} คาบ {p}" for k, p in per.items())
    elif isinstance(s, dict) and s.get("kind") == "sequential":
        sim = f"จำลอง {s.get('clocks')} clock (ยังไม่ครบสองคาบ จึงยังบอกคาบไม่ได้)"
    else:
        sim = f"จำลองครบ {rows} แถว"
    v = (b or {}).get("verified") or {}
    forms = [
        f"สร้าง {kind} ลงแผ่น {sheet} แล้วครับ\n- ขาเข้า {ins} · ขาออก {outs}\n- {check_line(c)}\n- {sim}",
        f"แผ่น {sheet} เสร็จแล้ว: {kind} (ขาเข้า {ins}; ขาออก {outs}) — {check_line(c)}, {sim}",
        f"ทำ {sheet} ให้แล้ว\n{check_line(c)}\n{sim}" + (f"\nตรวจกับโมเดลอ้างอิงผ่าน ({v.get('method')})" if isinstance(v, dict) and v.get("pass") else ""),
        f"เรียบร้อยครับ {sheet} = {kind}\n- {sim}\n- {check_line(c)}",
    ]
    return rng.choice(forms)


def fam_stop_check(kind, params, sheet, user, repeat):
    fresh_project("stop")
    T = Traj("stop_check", {"kind": kind, "repeat": repeat})
    users = [user, user + " หน่อย", "ช่วย" + user]
    T.start(users[0])
    (ok, b, cont), = T.turn([("build_part", dict(params, kind=kind, sheet=sheet))])
    if not ok:
        raise RuntimeError(cont)
    sim = {"sheet": sheet}
    if "n" in params and kind in G.SEQ:
        sim["cycles"] = cycles_for(params["n"])
    (ok1, c, ccont), (ok2, s, _) = T.turn([("check", {"sheet": sheet}), ("simulate", sim)])
    if repeat:                               # SFT2's habit: check again with nothing changed → the app's answer
        o = dict(c) if isinstance(c, dict) else {}
        o["unchanged"] = UNCHANGED.format(tool="check")
        fake_turn(T, "check", {"sheet": sheet}, json.dumps(o, ensure_ascii=False, separators=(",", ":")), weight=0)
    T.final(build_summary(kind, sheet, b, c, s))
    return T.rows(users)


def gen_stop_check():
    for (kind, params, sheet, user) in STOP_BUILDS:
        for repeat in (False, True):
            try:
                yield_rows(fam_stop_check(kind, params, sheet, user, repeat))
            except Exception as e:
                print("  stop_check fail", kind, e)


# ------------------------------------------------------------------ edit_report
EDIT_BASE = [("errchk", "err = sw1 & sw2 & sw3", ["sw1", "sw2", "sw3"], ["err"]),
             ("door", "unlock = key & ~lock; beep = key & lock", ["key", "lock"], ["unlock", "beep"]),
             ("vote", "pass = a&b | a&c | b&c", ["a", "b", "c"], ["pass"]),
             ("cmpx", "eq = ~(a ^ b); gt = a & ~b", ["a", "b"], ["eq", "gt"]),
             ("pump", "motor = low & ~full | manual; alarm = full & low", ["low", "full", "manual"], ["motor", "alarm"]),
             ("alarm", "alarm = door & armed | smoke", ["door", "armed", "smoke"], ["alarm"]),
             ("sel", "y = s & b | ~s & a; yn = ~(s & b | ~s & a)", ["a", "b", "s"], ["y", "yn"])]


def comp_of(sheet, typ):
    ok, g, _ = call("get_sheet", {"sheet": sheet, "detail": "brief"})
    return [x for x in (g or {}).get("components") or [] if x.get("type") == typ]


def fam_rename(sheet, formula, ins, outs, which):
    fresh_project("ren")
    call("build_circuit", {"sheet": sheet, "formula": formula}); call("open_sheet", {"sheet": sheet})
    old = rng.choice(outs if which == "out" else ins)
    new = old + pick("_led", "_out", "_n2", "_sig", "_in") if which == "out" else pick("in_", "x_", "btn_") + old
    T = Traj("edit_report", {"op": "rename", "which": which})
    word = "ขาออก" if which == "out" else "ขาเข้า"
    users = [f"ในแผ่น {sheet} ขอเปลี่ยนชื่อ{word} {old} เป็น {new} หน่อย", f"rename {old} → {new} ที่แผ่น {sheet}",
             f"{sheet}: เปลี่ยนชื่อ {old} ให้เป็น {new}"]
    T.start(users[0])
    (ok, r, cont), = T.turn([("update_component", {"sheet": sheet, "ref": old, "name": new})])
    if not ok:
        raise RuntimeError(cont)
    (okc, c, _), = T.turn([("check", {"sheet": sheet})])
    T.final(pick(f"เปลี่ยนชื่อ{word} {old} เป็น {new} แล้วครับ — {check_line(c)}",
                 f"เรียบร้อย: {old} → {new} (แผ่น {sheet})\n{check_line(c)}",
                 f"ตอนนี้{word}ชื่อ {new} แล้ว (เดิม {old}) วงจรเหมือนเดิมทุกอย่าง — {check_line(c)}"))
    return T.rows(users)


def fam_gate_type(sheet, formula, ins, outs, to):
    fresh_project("gate")
    call("build_circuit", {"sheet": sheet, "formula": formula}); call("open_sheet", {"sheet": sheet})
    g = comp_of(sheet, "AND") or comp_of(sheet, "OR")
    if not g:
        raise RuntimeError("no gate")
    g = g[0]
    to = "OR" if g["type"] == "AND" else "AND"
    T = Traj("edit_report", {"op": "type", "to": to})
    users = [f"แผ่น {sheet} เปลี่ยนเกต {g['name']} จาก {g['type']} เป็น {to} ให้หน่อย แล้วดูผลด้วย",
             f"{sheet}: {g['name']} ขอเป็น {to} แทน {g['type']}"]
    T.start(users[0])
    (ok, r, cont), = T.turn([("update_component", {"sheet": sheet, "ref": g["name"], "type": to})])
    if not ok:
        raise RuntimeError(cont)
    (okc, c, _), (oks, s, _) = T.turn([("check", {"sheet": sheet}), ("simulate", {"sheet": sheet})])
    eq = (s or {}).get("equations") if isinstance(s, dict) else None
    rows = len((s or {}).get("rows") or []) if isinstance(s, dict) else 0
    T.final(pick(f"เปลี่ยน {g['name']} จาก {g['type']} เป็น {to} แล้วครับ\n- {check_line(c)}\n- จำลองใหม่ครบ {rows} แถว",
                 f"แก้แล้ว: เกต {g['name']} เป็น {to} (เดิม {g['type']}) · {check_line(c)} · ตารางความจริงใหม่ {rows} แถว") +
            (f"\n- สมการตอนนี้: " + "; ".join(f"{k} = {v}" for k, v in eq.items()) if isinstance(eq, dict) else ""))
    return T.rows(users)


def fam_delete_out(sheet, formula, ins, outs):
    if len(outs) < 2:
        raise RuntimeError("one output")
    fresh_project("del")
    call("build_circuit", {"sheet": sheet, "formula": formula}); call("open_sheet", {"sheet": sheet})
    x = outs[-1]
    T = Traj("edit_report", {"op": "delete"})
    users = [f"ลบขาออก {x} ในแผ่น {sheet} ออกไป ไม่ใช้แล้ว", f"{sheet} เอา {x} ออกที"]
    T.start(users[0])
    (ok, r, cont), = T.turn([("delete", {"sheet": sheet, "refs": [x]})])
    if not ok:
        raise RuntimeError(cont)
    (okc, c, _), = T.turn([("check", {"sheet": sheet})])
    T.final(pick(f"ลบขาออก {x} ออกจากแผ่น {sheet} แล้วครับ — {check_line(c)}",
                 f"เอา {x} ออกแล้ว เหลือขาออก {', '.join(outs[:-1])}\n{check_line(c)}"))
    return T.rows(users)


def fam_add_not(sheet, formula, ins, outs):
    fresh_project("addn")
    call("build_circuit", {"sheet": sheet, "formula": formula}); call("open_sheet", {"sheet": sheet})
    x = outs[0]; nx = x + "_n"
    ok, g, _ = call("get_sheet", {"sheet": sheet, "detail": "brief"})
    drv = next((n["driver"] for n in (g or {}).get("nets") or [] if f"{x}.i" in n.get("sinks", [])), None)
    if not drv:
        raise RuntimeError("no driver")
    T = Traj("edit_report", {"op": "add_not"})
    users = [f"แผ่น {sheet} เพิ่มขาออก {nx} ที่เป็นค่ากลับของ {x} ให้หน่อย", f"{sheet}: อยากได้ {nx} = not {x} เพิ่มอีกขา"]
    T.start(users[0])
    (ok1, a1, c1), (ok2, a2, c2) = T.turn([("add_component", {"sheet": sheet, "type": "NOT", "name": "inv_" + x}),
                                           ("add_component", {"sheet": sheet, "type": "OUT", "name": nx})])
    if not (ok1 and ok2):
        raise RuntimeError(c1 + c2)
    (ok3, _, c3), (ok4, _, c4) = T.turn([("connect", {"sheet": sheet, "from": drv, "to": f"inv_{x}.i0"}),
                                         ("connect", {"sheet": sheet, "from": f"inv_{x}.o", "to": f"{nx}.i"})])
    if not (ok3 and ok4):
        raise RuntimeError(c3 + c4)
    (okv, v, _), = T.turn([("verify_truth_table", {"sheet": sheet, "formula": f"{nx} = ~({formula.split(';')[0].split('=', 1)[1].strip()})"})])
    T.final(pick(f"เพิ่มขาออก {nx} (NOT ของ {x}) ในแผ่น {sheet} แล้วครับ\n- ต่อจาก {drv} ผ่าน NOT inv_{x}\n- ตรวจทุกแถว: " + ("ผ่าน" if (v or {}).get("pass") else "ไม่ผ่าน"),
                 f"{nx} = not {x} เพิ่มให้แล้ว — วาง NOT inv_{x} กับ OUTPUT {nx} ต่อสาย 2 เส้น · ตรวจกับสมการ" + (" ผ่านทุกแถว" if (v or {}).get("pass") else " ไม่ผ่าน")))
    return T.rows(users)


def gen_edit_report():
    for (sheet, f, ins, outs) in EDIT_BASE:
        for which in ("out", "in", "out"):
            try:
                yield_rows(fam_rename(sheet, f, ins, outs, which))
            except Exception as e:
                print("  rename fail", sheet, e)
        try:
            yield_rows(fam_add_not(sheet, f, ins, outs))
        except Exception as e:
            print("  add_not fail", sheet, e)
        try:
            yield_rows(fam_gate_type(sheet, f, ins, outs, None))
        except Exception as e:
            print("  gate fail", sheet, e)
        try:
            yield_rows(fam_delete_out(sheet, f, ins, outs))
        except Exception as e:
            if "one output" not in str(e):
                print("  delete fail", sheet, e)


# ------------------------------------------------------------------ tool_cover
COVER = [("maj", "y = a&b | b&c | a&c", "y = a&b | b&c | a&c", "majority"),
         ("xr", "y = a ^ b ^ c", "y = a ^ b ^ c", "XOR 3 ขา"),
         ("bug", "y = a&b | c", "y = a&b | ~c", "y = a·b + c'")]


def fam_verify(sheet, built, claimed, what):
    fresh_project("ver")
    call("build_circuit", {"sheet": sheet, "formula": built}); call("open_sheet", {"sheet": sheet})
    T = Traj("tool_cover", {"tool": "verify_truth_table"})
    users = [f"ตรวจให้หน่อยว่าแผ่น {sheet} ทำงานตาม {claimed} จริงไหม", f"{sheet} ตรงกับสมการ {claimed} หรือเปล่า เช็คทุกแถว"]
    T.start(users[0])
    (ok, r, cont), = T.turn([("verify_truth_table", {"sheet": sheet, "formula": claimed})])
    if not ok:
        raise RuntimeError(cont)
    mm = r.get("mismatches") or []
    if r.get("pass"):
        T.final(pick(f"ตรงครับ — ตรวจทุกแถวกับ {claimed} ไม่มีแถวไหนผิด", f"ผ่าน: แผ่น {sheet} ให้ผลตาม {claimed} ครบทุกแถว"))
    else:
        names = r.get("inputs") or []
        rows = "; ".join(", ".join(f"{n}={b}" for n, b in zip(names, str(m.get("inputs", "")))) + f" → {m.get('output')} ควรเป็น {m.get('expected')} แต่ได้ {m.get('got')}"
                         for m in mm[:3])
        T.final(f"ไม่ตรงครับ — ผิด {len(mm)} แถว เช่น {rows}\nวงจรในแผ่น {sheet} ไม่ได้ทำ {claimed} (ถ้าต้องการให้แก้ บอกได้)")
    return T.rows(users)


def fam_vectors(sheet, formula, vecs):
    fresh_project("vec")
    call("build_circuit", {"sheet": sheet, "formula": formula}); call("open_sheet", {"sheet": sheet})
    T = Traj("tool_cover", {"tool": "simulate.vectors"})
    desc = " แล้ว ".join(", ".join(f"{k}={v}" for k, v in x.items()) for x in vecs)
    users = [f"ลองป้อน {desc} ในแผ่น {sheet} ให้ดูผลทีละชุด", f"จำลอง {sheet} เฉพาะ {desc}"]
    T.start(users[0])
    (ok, r, cont), = T.turn([("simulate", {"sheet": sheet, "vectors": vecs})])
    if not ok:
        raise RuntimeError(cont)
    lines = [f"- {', '.join(f'{k}={v}' for k, v in row['inputs'].items())} → " + ", ".join(f"{k}={one(v)}" for k, v in row["outputs"].items())
             for row in r.get("rows") or []]
    T.final("ผลจำลองครับ\n" + "\n".join(lines))
    return T.rows(users)


def fam_pins_read(sheet, formula, pins):
    fresh_project("gp")
    call("build_circuit", {"sheet": sheet, "formula": formula}); call("open_sheet", {"sheet": sheet})
    if pins:
        call("set_pins", {"sheet": sheet, "map": pins})
    T = Traj("tool_cover", {"tool": "get_pins"})
    users = [f"แผ่น {sheet} ตอนนี้ขาไหนต่อไปที่ไหนบนบอร์ดบ้าง", f"ขอดูขาบอร์ดของ {sheet} หน่อย"]
    T.start(users[0])
    (ok, r, cont), = T.turn([("get_pins", {"sheet": sheet})])
    rows = [f"- {p['port']} → {p['target']} (ขา {p['pin']})" if p.get("target") else f"- {p['port']} → ยังไม่ได้เลือก" for p in r.get("pins") or []]
    T.final("ขาบนบอร์ดของแผ่น " + sheet + "\n" + "\n".join(rows) + (f"\nยังไม่ได้เลือก {len(r.get('unassigned') or [])} ขา" if r.get("unassigned") else ""))
    return T.rows(users)


def fam_board(sheet, formula, pins):
    fresh_project("bd")
    call("build_circuit", {"sheet": sheet, "formula": formula}); call("open_sheet", {"sheet": sheet})
    if pins:
        call("set_pins", {"sheet": sheet, "map": pins})
    T = Traj("tool_cover", {"tool": "board_check"})
    users = [f"แผ่น {sheet} พร้อมลงบอร์ดหรือยัง", f"เช็คก่อนลงบอร์ดให้หน่อย แผ่น {sheet}"]
    T.start(users[0])
    (ok, r, cont), = T.turn([("board_check", {"sheet": sheet})])
    F = r.get("findings") or []
    errs = [f for f in F if f.get("level") == "err"]
    if errs:
        T.final(f"ยังไม่พร้อมครับ — ต้องแก้ {len(errs)} เรื่อง\n" + "\n".join(f"- {f['title']}: {f.get('fix', '')}" for f in errs))
    else:
        T.final("พร้อมลงบอร์ดครับ ไม่พบเรื่องที่ต้องแก้" + ("\nข้อสังเกต: " + "; ".join(f["title"] for f in F) if F else ""))
    return T.rows(users)


def fam_course(query, user):
    fresh_project("rag")
    T = Traj("tool_cover", {"tool": "search_course"})
    T.start(user)
    (ok, r, cont), = T.turn([("search_course", {"query": query})])
    hits = (r or {}).get("hits") or []
    if not hits:
        raise RuntimeError("no hits")
    T.final("เจอในเนื้อหาวิชาครับ\n" + "\n".join(f"- {h['title']} ({h.get('source', h.get('group'))})" for h in hits[:3])
            + "\nเปิดอ่านหัวข้อแรกก่อนได้เลย")
    return T.rows([user])


def fam_module(kind, params, sheet):
    fresh_project("mod")
    ok, b, c = call("build_part", dict(params, kind=kind, sheet=sheet))
    if not ok:
        raise RuntimeError(c)
    T = Traj("tool_cover", {"tool": "save_module+use_module"})
    users = [f"เก็บแผ่น {sheet} ไว้เป็นโมดูล แล้ววางมันลงในแผ่น top ให้หน่อย", f"save {sheet} เป็นโมดูลแล้วเอามาใช้ใน top"]
    T.start(users[0])
    (ok1, s, sc), = T.turn([("save_module", {"sheet": sheet})])
    if not ok1:
        raise RuntimeError(sc)
    name = (s or {}).get("module") or (s or {}).get("name") or sheet
    (ok2, u, uc), = T.turn([("use_module", {"module": name, "sheet": "top"})])
    if not ok2:
        raise RuntimeError(uc)
    T.final(pick(f"เก็บ {sheet} เป็นโมดูล {name} แล้ว และวางลงแผ่น top ให้แล้วครับ (ยังไม่ได้ต่อสาย)",
                 f"บันทึกโมดูล {name} แล้ว · วางในแผ่น top แล้ว — ต่อสายเข้าออกต่อได้เลย"))
    call("delete_module", {"module": name})          # the library is shared by every project: leave it as it was
    return T.rows(users)


def fam_explain_fix(sheet, formula, cut, val):
    fresh_project("expl")
    call("build_circuit", {"sheet": sheet, "formula": formula}); call("open_sheet", {"sheet": sheet})
    ok, g, _ = call("get_sheet", {"sheet": sheet, "detail": "brief"})
    sink = next((n["sinks"][0] for n in (g or {}).get("nets") or [] if n["driver"] == f"{cut}.o"), None)
    call("disconnect", {"sheet": sheet, "pin": f"{cut}.o"})
    T = Traj("tool_cover", {"tool": "explain_simulation"})
    users = [f"ทำไมแผ่น {sheet} ใส่ {cut}=1 แล้วผลไม่เปลี่ยนเลย", f"{sheet} เหมือน {cut} ไม่มีผล ช่วยดูหน่อย แล้วแก้ให้ด้วย"]
    T.start(users[0])
    (ok, e, _), = T.turn([("explain_simulation", {"sheet": sheet})])
    (okc, cc, ccont), = T.turn([("connect", {"sheet": sheet, "from": f"{cut}.o", "to": sink})])
    if not okc:
        raise RuntimeError(ccont)
    (okp, p, _), = T.turn([("probe", {"sheet": sheet, "inputs": val})])
    F = [f["title"] for f in (e or {}).get("findings") or [] if f.get("level") in ("err", "warn")]
    T.final(f"สาเหตุ: {F[0] if F else 'สายจาก ' + cut + ' ขาด'}\n- ต่อ {cut}.o เข้า {sink} ใหม่แล้ว\n- ลอง probe "
            + ", ".join(f"{k}={v}" for k, v in (p or {}).get("inputs", {}).items()) + " → "
            + ", ".join(f"{k}={one(v)}" for k, v in (p or {}).get("outputs", {}).items()))
    return T.rows(users)


def gen_tool_cover():
    for args in [("al", "alarm = door & armed | smoke", "smoke", {"smoke": 1}), ("chk", "err = sw3&(sw2|sw1)", "sw1", {"sw3": 1, "sw1": 1}),
                 ("vt", "y = a&b | c", "c", {"c": 1}), ("lk", "unlock = key & ~lock", "key", {"key": 1})]:
        try:
            yield_rows(fam_explain_fix(*args))
        except Exception as e:
            print("  explain fail", e)
    for args in COVER:
        try:
            yield_rows(fam_verify(*args))
        except Exception as e:
            print("  verify fail", e)
    for sheet, f, vecs in [("an3", "y = a & b & c", [{"a": 1, "b": 1, "c": 0}, {"a": 1, "b": 1, "c": 1}]),
                           ("orx", "y = a | b; z = a ^ b", [{"a": 0, "b": 1}, {"a": 1, "b": 1}, {"a": 0, "b": 0}]),
                           ("chk", "err = sw3&(sw2|sw1)", [{"sw3": 1, "sw1": 1}, {"sw3": 0, "sw2": 1}])]:
        try:
            yield_rows(fam_vectors(sheet, f, vecs))
        except Exception as e:
            print("  vectors fail", e)
    for sheet, f, pins in [("lamp", "led = sw0 & sw1", {"sw0": "sw:0", "sw1": "sw:1", "led": "led:0"}),
                           ("lamp2", "led = sw0 | sw1", {"sw0": "sw:0"}), ("gate3", "y = a & b", {})]:
        for fam in (fam_pins_read, fam_board):
            try:
                yield_rows(fam(sheet, f, pins))
            except Exception as e:
                print("  pins/board fail", e)
    for q, u in [("JK flip-flop", "หาเรื่อง JK flip-flop ในเนื้อหาวิชาให้หน่อย"), ("7-segment common anode", "ในชีทเรียนพูดเรื่อง 7-seg common anode ไว้ตรงไหน"),
                 ("clock divider", "มีแลปไหนสอนเรื่องหารความถี่บ้าง"), ("full adder", "เปิดเนื้อหาเรื่อง full adder ให้ดูหน่อย"),
                 ("debounce", "เรื่อง debounce ปุ่มอยู่ในบทไหน"), ("two's complement", "หาเรื่อง 2's complement ในเนื้อหาวิชา")]:
        try:
            yield_rows(fam_course(q, u))
        except Exception as e:
            print("  course fail", e)
    for kind, params, sheet in [("full_adder", {}, "fa"), ("comparator", {"n": 2}, "cmp2"), ("mux", {"n": 2}, "mx")]:
        try:
            yield_rows(fam_module(kind, params, sheet))
        except Exception as e:
            print("  module fail", e)


# ------------------------------------------------------------------ dup_blocks
def fam_chain(ns, rec):
    N = 1
    for n in ns:
        N *= n
    fresh_project("dup")
    sheet = f"div{N}"
    T = Traj("dup_blocks", {"ns": ns, "rec": rec})
    same = len(set(ns)) == 1
    desc = " ต่อ ".join(f"หาร {n}" for n in ns)
    users = [f"ทำแผ่น {sheet} เป็นตัวหาร {N} โดยเอา {desc} ต่อกัน ขา clk_in / clk_out",
             f"ขอ {sheet}: clock_divider {' → '.join(str(n) for n in ns)} เรียงกัน เข้า clk_in ออก clk_out"]
    T.start(users[0])
    names = [f"d{n}{chr(97 + i)}" if same or ns.count(n) > 1 else f"d{n}" for i, n in enumerate(ns)]
    blocks = [{"name": nm, "part": "clock_divider", "params": {"n": n}} for nm, n in zip(names, ns)]
    conn = [["clk_in", f"{names[0]}.clk_in"]] + [[f"{a}.clk_out", f"{b}.clk_in"] for a, b in zip(names, names[1:])] + [[f"{names[-1]}.clk_out", "clk_out"]]
    good = {"sheet": sheet, "blocks": blocks, "inputs": ["clk_in"], "outputs": ["clk_out"], "connect": conn}
    if rec:                                  # the v2.7.1 div25 mistake: blocks named one way, connect another
        bad = dict(good, connect=[["clk_in", "d0.clk_in"], ["d0.clk_out", "d1.clk_in"], ["d1.clk_out", "clk_out"]])
        T.turn([("build_hierarchy", bad)], weight=0)
    (ok, h, cont), = T.turn([("build_hierarchy", good)])
    if not ok:
        raise RuntimeError(cont)
    cyc = cycles_for(N)
    (okc, c, _), (oks, s, _) = T.turn([("check", {"sheet": sheet}), ("simulate", {"sheet": sheet, "cycles": cyc})])
    per = ((s or {}).get("summary") or {}).get("clk_out", {}).get("period") if isinstance(s, dict) else None
    lines = [f"ทำ {sheet} แล้วครับ: clk_in → " + " → ".join(names) + " → clk_out"]
    if rec:
        lines.append("- รอบแรกอ้างชื่อบล็อก d0 / d1 ที่ไม่มีอยู่ เลยต่อใหม่ด้วยชื่อที่ตั้งไว้")
    lines.append(f"- ต่อสายครบ {(h or {}).get('connected_bits')} จุด")
    lines.append("- " + check_line(c))
    lines.append(f"- จำลอง {cyc} clock: clk_out คาบ {per} clock" if per else f"- คาบรวมควรเป็น {N} (ยาวเกินกว่าจะเห็นใน {cyc} clock)")
    T.final("\n".join(lines))
    return T.rows(users)


def fam_mux4(rec):
    fresh_project("mux4")
    T = Traj("dup_blocks", {"what": "mux4", "rec": rec})
    users = ["ประกอบ mux 4:1 จาก mux 2:1 สามตัว ลงแผ่น mux4 ขาเข้า d0..d3 s0 s1 ขาออก y",
             "ทำแผ่น mux4 จาก mux 2:1 3 ตัว (d0-d3, s0, s1 → y)"]
    T.start(users[0])
    blocks = [{"name": n, "part": "mux", "params": {"n": 2}} for n in ("m0", "m1", "m2")]
    conn = [["d0", "m0.d0"], ["d1", "m0.d1"], ["d2", "m1.d0"], ["d3", "m1.d1"], ["s0", "m0.s0"], ["s0", "m1.s0"],
            ["m0.y", "m2.d0"], ["m1.y", "m2.d1"], ["s1", "m2.s0"], ["m2.y", "y"]]
    good = {"sheet": "mux4", "blocks": blocks, "inputs": ["d0", "d1", "d2", "d3", "s0", "s1"], "outputs": ["y"], "connect": conn}
    if rec:
        bad = dict(good, connect=[c if not c[1].startswith("m2.") else [c[0], c[1].replace("m2", "mux2")] for c in conn])
        T.turn([("build_hierarchy", bad)], weight=0)
    (ok, h, cont), = T.turn([("build_hierarchy", good)])
    if not ok:
        raise RuntimeError(cont)
    f = "y = ~s1&~s0&d0 | ~s1&s0&d1 | s1&~s0&d2 | s1&s0&d3"
    (okv, v, _), = T.turn([("verify_truth_table", {"sheet": "mux4", "formula": f})])
    T.final("ทำ mux4 แล้วครับ: m0 (d0,d1) และ m1 (d2,d3) เลือกด้วย s0 แล้ว m2 เลือกด้วย s1"
            + ("\n- รอบแรกอ้างบล็อก mux2 ที่ไม่มี เลยแก้เป็น m2" if rec else "")
            + f"\n- ตรวจกับ {f}: " + ("ผ่านทุกแถว" if (v or {}).get("pass") else f"ไม่ผ่าน ({len((v or {}).get('mismatches') or [])} แถว)"))
    return T.rows(users)


def gen_dup_blocks():
    for ns in [(5, 5), (3, 3), (4, 4), (2, 2, 2), (3, 3, 3), (5, 5, 2), (2, 5, 5), (6, 6)]:
        for rec in (False, True):
            try:
                yield_rows(fam_chain(list(ns), rec))
            except Exception as e:
                print("  chain fail", ns, e)
    for rec in (False, True):
        try:
            yield_rows(fam_mux4(rec))
        except Exception as e:
            print("  mux4 fail", e)


# ------------------------------------------------------------------ locked
def fam_locked(formula, users):
    fresh_project("lock")
    T = Traj("locked", {})
    T.start(users[0])
    fake_turn(T, "build_circuit", {"sheet": "top", "formula": formula, "replace": True},
              "ERROR: sheet 'top' is locked for the agent (the user locked it) — do not change it; build into a new sheet instead, e.g. sheet:'top_new'",
              weight=1)
    (ok, r, cont), = T.turn([("build_circuit", {"sheet": "top_new", "formula": formula})])
    if not ok:
        raise RuntimeError(cont)
    (okc, c, _), = T.turn([("check", {"sheet": "top_new"})])
    T.final(pick(f"แผ่น top ถูกล็อกไว้ เลยไม่แตะครับ — สร้าง {formula} ลงแผ่นใหม่ top_new แทน\n- {check_line(c)}\nถ้าจะใช้แทน top ให้ปลดล็อก (🔒) ก่อน แล้วสั่งใหม่",
                 f"top ล็อกอยู่ (ผู้ใช้ล็อกไว้) จึงทำไว้ที่ top_new: {formula}\n{check_line(c)}\ntop ยังเหมือนเดิม"))
    return T.rows(users)


def gen_locked():
    for f, us in [("y = a & ~b", ["เขียน y = a and not b ลงแผ่น top", "top ให้เป็น y = a & ~b"]),
                  ("err = sw0 & sw1", ["แผ่น top เอา err = sw0 & sw1 ทับไปเลย", "ทำ err = sw0 and sw1 ใน top"]),
                  ("f = a ^ b ^ c", ["top: f = a xor b xor c", "แทน top ด้วย f = a ^ b ^ c"]),
                  ("y = ~a", ["ทำ NOT ตัวเดียวลงแผ่น top: y = ~a"]),
                  ("out1 = a | b | c", ["ใส่ OR 3 ขาใน top ทับของเดิม"]),
                  ("y = a & b | c", ["ทำวงจร y = a & b | c ลงแผ่น top ทับของเดิมได้เลย", "เขียน y = a&b|c ใส่ top ให้หน่อย"]),
                  ("z = a ^ b", ["ใส่ z = a xor b ในแผ่น top แทนของเดิม"]),
                  ("led = sw0 & ~sw1", ["แก้ top ให้เป็น led = sw0 & ~sw1"]),
                  ("y = ~(a | b)", ["ทำ NOR สองขาใน top: y = ~(a | b)"])]:
        try:
            yield_rows(fam_locked(f, us))
        except Exception as e:
            print("  locked fail", e)


# ------------------------------------------------------------------ sim_cycles
def fam_sim_cycles(kind, n, sheet):
    fresh_project("cyc")
    ok, b, c = call("build_part", {"kind": kind, "n": n, "sheet": sheet})
    if not ok:
        raise RuntimeError(c)
    call("open_sheet", {"sheet": sheet})
    T = Traj("sim_cycles", {"kind": kind, "n": n})
    users = [f"จำลองแผ่น {sheet} ให้ดูหน่อยว่าหารกี่เท่าจริง", f"{sheet} คาบออกมาเท่าไร ลองจำลองดู"] if kind == "clock_divider" else \
            [f"จำลอง {sheet} ให้ดูว่านับวนกี่ค่า", f"{sheet} นับถึงเท่าไรแล้ววนกลับ ลองจำลอง"]
    T.start(users[0])
    cyc = cycles_for(n)
    (ok, s, cont), = T.turn([("simulate", {"sheet": sheet, "cycles": cyc})])
    if not ok:
        raise RuntimeError(cont)
    S = (s or {}).get("summary") or {}
    if kind == "clock_divider":
        o = S.get("clk_out") or {}
        if not o.get("period"):
            raise RuntimeError("no period in %d clocks" % cyc)
        T.final(f"จำลอง {s.get('clocks')} clock: clk_out คาบ {o.get('period')} clock = หาร {o.get('period')}"
                + (f" · duty {round(o['duty'] * 100)} %" if o.get("duty") is not None else ""))
    else:
        q = S.get("q") or next(iter(S.values()), {})
        vals = q.get("values") or []
        if not q.get("period"):
            raise RuntimeError("no period in %d clocks" % cyc)
        T.final(f"จำลอง {s.get('clocks')} clock: นับ {', '.join(str(v) for v in vals[:16])} แล้ววนกลับ — คาบ {q.get('period')} ค่า")
    return T.rows(users)


def gen_sim_cycles():
    for n in [3, 5, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60]:
        try:
            yield_rows(fam_sim_cycles("clock_divider", n, f"dv{n}"))
        except Exception as e:
            print("  cyc fail", n, e)
    for n in [3, 4, 6, 8, 9, 11, 13]:
        try:
            yield_rows(fam_sim_cycles("mod_counter", n, f"cn{n}"))
        except Exception as e:
            print("  cyc fail", n, e)


# ------------------------------------------------------------------ qa_plain
def qa_mode_pairs(k):
    src = os.path.join(HERE, "..", "data", "train.jsonl.gz")
    out = []
    for line in gzip.open(src, "rt", encoding="utf-8"):
        r = json.loads(line)
        if r.get("cat") != "qa_mode":
            continue
        u = [m for m in r["messages"] if m["role"] == "user"][-1]["content"]
        q = u.rsplit("[คำถาม/คำสั่งล่าสุด]\n", 1)[-1].strip()
        a = [m for m in r["messages"] if m["role"] == "assistant"][-1]["content"].strip()
        if 6 < len(q) < 200 and 20 < len(a) < 1200:
            out.append((q, a, r.get("source")))
    rng.shuffle(out)
    return out[:k]


def fam_sheet_question(N):
    fresh_project("ask")
    G.setup_divider(N)
    T = Traj("qa_plain", {"ask": "divider", "N": N})
    users = [f"แผ่น div{N} ตอนนี้หารกี่เท่า เช็คให้หน่อย", f"div{N} หารได้เท่าไรจริงๆ", f"อธิบายแผ่น div{N} หน่อยว่าทำอะไร"]
    T.start(users[0])
    cyc = cycles_for(N)
    (ok, s, cont), = T.turn([("simulate", {"sheet": f"div{N}", "cycles": cyc})])
    per = (((s or {}).get("summary") or {}).get("clk_out") or {}).get("period")
    T.final(f"div{N} หาร {per} ครับ — จำลอง {s.get('clocks')} clock เห็น clk_out คาบ {per} clock (ไม่ได้แก้อะไรในแผ่น)" if per
            else f"จำลอง {s.get('clocks')} clock ยังไม่เห็นคาบเต็มของ clk_out (ไม่ได้แก้อะไรในแผ่น)")
    return T.rows(users)


def gen_qa_plain():
    fresh_project("qa")
    for q, a, src in qa_mode_pairs(70):
        T = Traj("qa_plain", {"source": src})
        T.start(q)
        T.final(a)
        yield_rows(T.rows([q]))
    for N in [6, 10, 15, 24]:
        try:
            yield_rows(fam_sheet_question(N))
        except Exception as e:
            print("  ask fail", N, e)


GENS = {"probe_bits": gen_probe_bits, "stop_check": gen_stop_check, "edit_report": gen_edit_report,
        "tool_cover": gen_tool_cover, "dup_blocks": gen_dup_blocks, "locked": gen_locked,
        "sim_cycles": gen_sim_cycles, "qa_plain": gen_qa_plain}
SFT2_FAMS = [k for k in G.GENS if k != "probe_group"]

if __name__ == "__main__":
    import time, traceback
    fams = (opt("--families") or ",".join(list(GENS) + ["sft2:" + k for k in SFT2_FAMS])).split(",")
    ok, st, _ = call("status", {})
    was = st.get("project") if isinstance(st, dict) else None
    t0 = time.time()
    with open(OUT, "w", encoding="utf-8") as f:
        G._out = f
        for fam in fams:
            n0 = G._count[0]; t1 = time.time()
            try:
                (G.GENS[fam[5:]] if fam.startswith("sft2:") else GENS[fam])()
            except G.Limit:
                break
            except Exception:
                traceback.print_exc()
            print(f"[{fam}] +{G._count[0] - n0} rows in {time.time() - t1:.0f}s", flush=True)
    if was:
        call("export_project", {"name": was})
    for p in list(G.CREATED):
        if p.startswith("sftg_"):
            call("delete_project", {"name": p, "files": True})
    print(f"wrote {G._count[0]} rows to {OUT} in {time.time() - t0:.0f}s")
    G.app.close()
