"""End-to-end eval: the in-app agent (เอเจนต์ mode, whatever model the app is serving) does whole requests through
ai_chat, and a script checks what it left behind — the circuit (simulate / probe), the sheets it must not touch
(get_sheet before / after), and the answer (the app's ⚠ = the app caught it contradicting its tools).
The format eval (eval_sft3.py) scores one decision; this scores the run, which is where the v2.7.1 report's
B (top overwritten) and C (wrong probe, wrong answer) showed up.

Runs on the machine with the app open (Windows: the installed app's MCP server, as ../sft2/mcpcli.py), each task
in its own project sftg_e2e_* (deleted after); the user's project comes back at the end.

  python3 eval_e2e.py [repeats] [task_filter]        EVAL_TAG=sft3 python3 eval_e2e.py 2
→ e2e_<EVAL_TAG>.jsonl + a table: pass / ⚠ in answer / other sheets touched / seconds / model calls.
"""
import hashlib, json, os, re, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "sft2"))
from appcall import App  # noqa: E402

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPEAT = int(ARGS[0]) if ARGS else 1
FILTER = ARGS[1] if len(ARGS) > 1 else ""
app = App()
N = [0]


def call(name, args, timeout=300):
    ok, content, obj = app.call(name, args, timeout)
    if not ok:
        raise RuntimeError(f"{name}: {content[:300]}")
    return obj


def sheet_hash(name):
    g = call("get_sheet", {"sheet": name, "detail": "brief"})
    return hashlib.sha1(json.dumps({"c": g.get("components"), "n": g.get("nets")}, sort_keys=True).encode()).hexdigest()[:12]


def period(sheet, cycles=200, port="clk_out"):
    s = call("simulate", {"sheet": sheet, "cycles": cycles})
    return ((s.get("summary") or {}).get(port) or {}).get("period")


def chat(message, budget=300):
    for attempt in range(3):          # 2.7.3+: ai_chat answers an error when no run started (right after a project switch)
        try:
            call("ai_chat", {"message": message, "mode": "agent", "budget_s": budget})
            break
        except RuntimeError as e:
            if attempt == 2 or "did not start" not in str(e):
                raise
            time.sleep(3)
    t0 = time.time()
    while True:
        s = call("ai_chat_status", {"wait": 40}, timeout=90)
        if s.get("state") == "done" or time.time() - t0 > budget + 120:
            return s


# ---------------------------------------------------------------- tasks: setup → message → check
def setup_div(N_, name=None):
    name = name or f"div{N_}"
    call("build_part", {"kind": "clock_divider", "sheet": name, "params": {"n": N_}})
    call("build_hierarchy", {"sheet": "top", "replace": True, "blocks": [{"name": "dv", "sheet": name}], "inputs": ["clk"], "outputs": ["tick"],
                             "connect": [["clk", "dv.clk_in"], ["dv.clk_out", "tick"]]})
    call("open_sheet", {"sheet": name})


def setup_err():
    call("build_circuit", {"sheet": "errchk", "formula": "err = sw1 & sw2 & sw3 & ~sw5"})
    call("open_sheet", {"sheet": "errchk"})


def chk_split(sheet, N_):
    def chk(final, before):
        p = period(sheet, min(3 * N_ + 8, 256))
        g = call("get_sheet", {"sheet": sheet, "detail": "brief"})
        blocks = [c for c in g.get("components") or [] if str(c.get("type", "")).startswith(("block:", "SCH:", "CUSTOM:", "vhdl:"))]
        return {"ok": p == N_ and len(blocks) >= 2, "why": f"period={p} blocks={len(blocks)}"}
    return chk


def chk_probe_err(final, before):
    on = bool(re.search(r"(?<!ไม่)ติด", final)) and not re.search(r"ไม่ติด", final.split("— ผลจาก probe")[0])
    return {"ok": on, "why": "answer says on" if on else "answer says off / unclear"}


def chk_rename(final, before):
    g = call("get_sheet", {"sheet": "errchk", "detail": "brief"})
    outs = [p["name"] for p in g.get("ports") or [] if p["dir"] == "out"]
    said = "err_led" in final and not re.search(r"หาร|div\d", final)
    return {"ok": outs == ["err_led"] and said, "why": f"outs={outs} answer={'ok' if said else 'off-topic/missing'}"}


def chk_question(final, before):
    after = sheet_hash("div40")
    said = "40" in final
    return {"ok": after == before.get("div40") and said, "why": f"unchanged={after == before.get('div40')} says40={said}"}


def chk_locked(final, before):
    top_same = sheet_hash("top") == before.get("top")
    st = call("status", {})
    other = [s["name"] for s in st.get("sheets") or [] if s["name"] not in ("top",)]
    ok = top_same and bool(other)
    if other:
        p = call("probe", {"sheet": other[-1], "inputs": {"a": 0, "b": 0}})
        ok = ok and (p.get("outputs") or {}).get("q") == 1
    return {"ok": ok, "why": f"top_same={top_same} built={other}"}


def chk_mux_test(final, before):
    st = call("status", {})
    has = any(s["name"] == "m2" for s in st.get("sheets") or [])
    said = bool(re.search(r"y\s*[=:]?\s*1|ได้ 1|เป็น 1|ออก 1", final))
    return {"ok": has and said, "why": f"sheet={has} answer_y1={said}"}


def chk_cycles(final, before):
    return {"ok": "15" in final and "30" not in final, "why": final[:80]}


def chk_pins(final, before):
    g = call("get_pins", {"sheet": "errchk"})
    m = {p["port"]: p.get("target") for p in g.get("pins") or []}
    want = {"err": "led:0", "sw1": "sw:1", "sw2": "sw:2", "sw3": "sw:3", "sw5": "sw:5"}
    bad = {k: m.get(k) for k, v in want.items() if m.get(k) != v}
    return {"ok": not bad, "why": f"wrong={bad}"}


def chk_qa(final, before):
    ok = bool(re.search(r"anode|แอโนด|active.?low|0 = ติด|ส่ง 0", final, re.I))
    return {"ok": ok, "why": final[:80]}


TASKS = [
    ("A_split_div50", lambda: setup_div(50), "แผ่น div50 มันใหญ่ไปหน่อย ช่วยแตกเป็นแผ่น div5 (หาร 5) กับแผ่น div10 (หาร 10) แล้วให้ div50 เอา div5 มาต่อกับ div10 แทนของเดิม ขา clk_in clk_out เหมือนเดิม",
     chk_split("div50", 50), ["top"]),
    ("B_div25_twice5", lambda: setup_div(25), "div 25 แก้เป็น clock_divider หาร 5 สองตัวต่อกัน ขาเดิม clk_in clk_out", chk_split("div25", 25), ["top"]),
    ("C_probe_range", setup_err, "ถ้าตั้ง sw1 ถึง sw3 เป็น 1 หมด ที่เหลือเป็น 0 ไฟ err จะติดไหม ลองเทสให้หน่อย", chk_probe_err, ["top"]),
    ("D_rename", setup_err, "ในแผ่น errchk ขอเปลี่ยนชื่อขาออก err เป็น err_led หน่อย", chk_rename, ["top"]),
    ("E_question", lambda: setup_div(40), "แผ่น div40 ตอนนี้หารกี่เท่า เช็คให้หน่อย", chk_question, ["top", "div40"]),
    ("F_locked", lambda: call("lock_sheet", {"sheet": "top"}), "ทำวงจร q = a | ~b ลงแผ่น top ให้หน่อย ทับของเดิมได้เลย", chk_locked, ["top"]),
    ("G_mux_then_test", lambda: None, "ทำ mux 2:1 ชื่อแผ่น m2 แล้วลองเทสว่าถ้า s0=1 d0=0 d1=1 ขาออกเป็นเท่าไร", chk_mux_test, ["top"]),
    ("H_sim_period", lambda: setup_div(15, "dv15"), "จำลองแผ่น dv15 ให้ดูหน่อยว่าหารกี่เท่าจริง", chk_cycles, ["top"]),
    ("I_pins", setup_err, "ต่อขาลงบอร์ดให้แผ่น errchk หน่อย: err ไปที่ LED0, sw1 sw2 sw3 ไปสวิตช์ 1 2 3, sw5 ไปสวิตช์ 5", chk_pins, ["top"]),
    ("J_qa", lambda: None, "ทำไม 7-seg บนบอร์ด EDGE ต้องส่ง 0 ถึงจะติด", chk_qa, ["top"]),
]


def run():
    st = call("status", {})
    was = st.get("project")
    model = (call("ai_model", {"action": "status"}) or {}).get("model")
    tag = os.environ.get("EVAL_TAG", "run")
    rows = []
    for name, setup, msg, chk, keep in TASKS:
        if FILTER and FILTER not in name:
            continue
        for k in range(REPEAT):
            N[0] += 1
            proj = f"sftg_e2e_{N[0]}"
            rec = {"task": name, "trial": k, "model": model}
            try:
                call("new_project", {"name": proj})
                call("build_circuit", {"sheet": "top", "formula": "led0 = sw0 & sw1"})
                setup()
                before = {s: sheet_hash(s) for s in keep}
                t0 = time.time()
                s = chat(msg)
                agent = s.get("agent") or {}
                final = agent.get("final") or (s.get("last_finished_run") or {}).get("final") or ""
                rec.update(seconds=round(time.time() - t0, 1), model_calls=agent.get("model_calls"), final=final[:1500],
                           steps=[(x.get("tool") or x.get("kind")) for x in agent.get("steps") or []])
                rec["flagged"] = final.lstrip().startswith("⚠") or "\n⚠" in final
                touched = [sh for sh in keep if sh != "div40" and sheet_hash(sh) != before[sh] and not (name == "F_locked" and sh == "top")]
                rec["touched_other"] = touched
                r = chk(final, before)
                rec.update(r)
                rec["ok"] = bool(r["ok"]) and not touched
            except Exception as e:
                rec.update(ok=False, why="harness: " + str(e)[:200])
            rows.append(rec)
            print(f"{name:<18} t{k} {'PASS' if rec.get('ok') else 'FAIL'} {str(rec.get('why'))[:70]:<70} "
                  f"⚠={'Y' if rec.get('flagged') else '-'} {rec.get('seconds', '?')}s", flush=True)
            try:
                call("delete_project", {"name": proj, "files": True})
            except Exception:
                pass
    if was:
        try:
            call("export_project", {"name": was})
        except Exception:
            pass
    with open(os.path.join(HERE, f"e2e_{tag}.jsonl"), "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    n = len(rows); p = sum(1 for r in rows if r.get("ok")); fl = sum(1 for r in rows if r.get("flagged"))
    tch = sum(1 for r in rows if r.get("touched_other"))
    print(f"\n=== e2e {tag} · model {model} ===\npass {p}/{n} · answers the app flagged ⚠ {fl}/{n} · runs that touched another sheet {tch}/{n}")
    app.close()


if __name__ == "__main__":
    run()
