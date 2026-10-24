"""SFT3 format eval = the SFT2 cases (../sft2/eval_format.py, 17) + 15 new ones for what SFT3 is meant to fix,
with this round's tools.json. Wording, sheet names and numbers of the new cases are NOT in the training data
(hold-out). Same scoring and output as eval_format.py (eval_<EVAL_TAG>.jsonl in this folder).

  python3 eval_sft3.py [N_trials] [case_filter] [--url http://127.0.0.1:8770]
  EVAL_TAG=sft2_base python3 eval_sft3.py 4        # the baseline, before training
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "sft2"))
import eval_format as E  # noqa: E402

E.TOOLS = json.load(open(os.path.join(HERE, "tools.json"), encoding="utf-8"))["tools"]
E.TOOLMAP = {t["function"]["name"]: t["function"] for t in E.TOOLS}
E.SYS_BASE = open(os.path.join(HERE, "sysprompt.txt"), encoding="utf-8").read()
E.HERE = HERE
case, call1, result1, calls_n, results_n = E.case, E.assistant_call, E.tool_result, E.assistant_calls, E.tool_results

WRITE = re.compile(r"^(build_|vhdl_block$|delete|disconnect$|connect$|add_component$|update_component$|apply$|set_pins$|set_spec$|undo$|new_sheet$)")
SW8 = "Project: t. Sheets: top (top): 21 parts. Active sheet: top (ports: in sw0, in sw1, in sw2, in sw3, in sw4, in sw5, in sw6, in sw7, out alarm, out ok)."


def names(calls):
    return ",".join(c["name"] for c in calls) or "none"


def probe_bits(want_on, all_bits=range(8)):
    """the probe got exactly these switches at 1 — as bits, a range, or (allowed, flagged) one number"""
    def chk(calls, text):
        p = [c for c in calls if c["name"] == "probe"]
        if not p:
            return {"ok": False, "why": "tool=" + names(calls)}
        i = p[0]["args"].get("inputs") or {}
        got, form = {}, "bits"
        for k, v in i.items():
            m = re.fullmatch(r"\s*sw\s*\[\s*(\d+)\s*(?::\s*(\d+))?\s*\]\s*", str(k))
            if m:
                hi, lo = int(m.group(1)), int(m.group(2) or m.group(1))
                hi, lo = max(hi, lo), min(hi, lo)
                s = str(v).replace("0b", "")
                try:
                    x = int(s, 2) if re.fullmatch(r"[01]+", s) and len(s) == hi - lo + 1 else int(str(v), 0)
                except Exception:
                    return {"ok": False, "why": "range value " + str(v)}
                for b in range(lo, hi + 1):
                    got[b] = (x >> (b - lo)) & 1
                form = "range"
            elif str(k) == "sw":
                try:
                    x = int(str(v), 0)
                except Exception:
                    return {"ok": False, "why": "sw=" + str(v)}
                for b in all_bits:
                    got[b] = (x >> b) & 1
                form = "number"
            elif re.fullmatch(r"sw\d+", str(k)):
                got[int(k[2:])] = int(v) if str(v) in ("0", "1") else -1
        on = sorted(b for b, v in got.items() if v == 1)
        return {"ok": on == sorted(want_on), "why": f"{form} on={on}"}
    return chk


case("probe_bits_range", SW8, [{"role": "user", "content": "ลองดูว่าถ้าเปิดสวิตช์ 4 ถึง 6 ที่เหลือปิด ไฟ alarm ติดไหม"}], probe_bits([4, 5, 6]), wants_change=False)
case("probe_bits_list", SW8, [{"role": "user", "content": "ถ้า sw2 กับ sw7 เป็น 1 นอกนั้น 0 ok ออกเท่าไร"}], probe_bits([2, 7]), wants_change=False)
case("probe_bits_all", SW8, [{"role": "user", "content": "เปิดสวิตช์ทั้งหมดทุกตัว alarm เป็นอะไร"}], probe_bits(list(range(8))), wants_change=False)

DIV40 = "Project: t. Sheets: top (top): 5 parts; div40: 14 parts. Active sheet: div40 (ports: in clk_in, out clk_out)."
case("question_readonly", DIV40, [{"role": "user", "content": "แผ่น div40 ตอนนี้หารได้กี่เท่าครับ ช่วยดูที"}],
     lambda calls, text: {"ok": bool(calls) and not any(WRITE.match(c["name"]) for c in calls)
                          and any(c["name"] in ("simulate", "get_sheet", "probe", "explain_simulation") for c in calls),
                          "why": "tool=" + names(calls)}, wants_change=False)

SIM_OK = {"sheet": "dv12", "kind": "sequential", "clocks": 44, "summary": {"clk_out": {"changes": 7, "period": 12, "last": 1, "high": 0.5, "duty": 0.5, "high_clocks": 6, "values": [0, 1]}}}
BUILT12 = {"sheet": "dv12", "kind": "clock_divider", "params": {"n": 12}, "ports": [{"name": "clk_in", "dir": "in", "width": 1}, {"name": "clk_out", "dir": "out", "width": 1}],
           "verified": {"pass": True, "method": "40 clock เทียบกับโมเดลสถานะ"}}
CHK_OK = {"sheet": "dv12", "errors": 0, "warnings": 0, "ok": True, "issues": []}
P12 = "Project: t. Sheets: top (top): 3 parts; dv12: 9 parts. Active sheet: dv12 (ports: in clk_in, out clk_out)."
case("stop_after_check", P12,
     [{"role": "user", "content": "ขอตัวหาร 12 ชื่อแผ่น dv12"}, call1("build_part", {"kind": "clock_divider", "sheet": "dv12", "params": {"n": 12}}),
      result1("build_part", BUILT12), calls_n([("check", {"sheet": "dv12"}), ("simulate", {"sheet": "dv12", "cycles": 44})]), *results_n([CHK_OK, SIM_OK])],
     lambda calls, text: {"ok": not calls and "12" in text, "why": ("tool=" + names(calls)) if calls else ("text-ok" if "12" in text else "no-period")}, wants_change=False)
case("stop_on_unchanged", P12,
     [{"role": "user", "content": "ขอตัวหาร 12 ชื่อแผ่น dv12"}, call1("build_part", {"kind": "clock_divider", "sheet": "dv12", "params": {"n": 12}}),
      result1("build_part", BUILT12), calls_n([("check", {"sheet": "dv12"}), ("simulate", {"sheet": "dv12", "cycles": 44})]), *results_n([CHK_OK, SIM_OK]),
      call1("check", {"sheet": "dv12"}),
      {"role": "tool", "tool_call_id": "c1", "content": json.dumps(dict(CHK_OK, unchanged="(system) Nothing on this sheet changed since you last ran check with these arguments — this is the same result. Do not run it again: answer the user now."), ensure_ascii=False)}],
     lambda calls, text: {"ok": not calls and bool(text.strip()), "why": "tool=" + names(calls) if calls else "answered"}, wants_change=False)

ALARM = "Project: t. Sheets: top (top): 3 parts; siren: 7 parts. Active sheet: siren (ports: in door, in armed, in smoke, out alarm)."
case("rename_call", ALARM, [{"role": "user", "content": "แผ่น siren ขอเปลี่ยนชื่อขาออก alarm เป็น buzzer"}],
     lambda calls, text: (lambda u: {"ok": bool(u) and u[0]["args"].get("ref") == "alarm" and u[0]["args"].get("name") == "buzzer", "why": json.dumps(u[0]["args"] if u else names(calls), ensure_ascii=False)[:120]})
     ([c for c in calls if c["name"] == "update_component"]))
case("rename_report", ALARM,
     [{"role": "user", "content": "แผ่น siren ขอเปลี่ยนชื่อขาออก alarm เป็น buzzer"}, call1("update_component", {"sheet": "siren", "ref": "alarm", "name": "buzzer"}),
      result1("update_component", {"changed": ["name"], "id": "out_0", "type": "OUT", "name": "buzzer", "width": 1}),
      call1("check", {"sheet": "siren"}), result1("check", {"sheet": "siren", "errors": 0, "warnings": 0, "ok": True, "issues": []})],
     lambda calls, text: {"ok": not calls and "buzzer" in text and not re.search(r"หาร|div\d|clock_divider|ตัวนับ", text),
                          "why": ("tool=" + names(calls)) if calls else ("ok" if "buzzer" in text else "no-name") + ("+OFF-TOPIC" if re.search(r"หาร|div\d|clock_divider|ตัวนับ", text) else "")},
     wants_change=False)
case("gate_type_call", "Project: t. Sheets: top (top): 3 parts; g1: 6 parts (and_0 AND, in a, in b, out y). Active sheet: g1 (ports: in a, in b, out y).",
     [{"role": "user", "content": "ในแผ่น g1 เปลี่ยนเกต and_0 เป็น OR ให้หน่อย"}],
     lambda calls, text: (lambda u: {"ok": bool(u) and u[0]["args"].get("ref") == "and_0" and str(u[0]["args"].get("type")).upper() == "OR", "why": json.dumps(u[0]["args"] if u else names(calls))[:120]})
     ([c for c in calls if c["name"] == "update_component"]))


def dup_chk(sheet, part, k):
    def chk(calls, text):
        bh = [c for c in calls if c["name"] == "build_hierarchy"]
        if not bh:
            return {"ok": False, "why": "tool=" + names(calls)}
        a = bh[0]["args"]; bl = [b for b in a.get("blocks") or [] if isinstance(b, dict)]
        nm = [b.get("name") for b in bl]
        if len(bl) != k or len(set(nm)) != k:
            return {"ok": False, "why": f"blocks={nm}"}
        used = {p.split(".")[0] for e in E.edges_of(a.get("connect")) for p in e if "." in p}
        stray = sorted(used - set(nm))
        if stray:
            return {"ok": False, "why": f"unknown blocks in connect {stray}"}
        if part == "clock_divider":
            ok, why = E.chain_ok(a, [3] * k)
            return {"ok": ok and a.get("sheet") == sheet, "why": why}
        return {"ok": a.get("sheet") == sheet, "why": "ok"}
    return chk


TOP0 = "Project: t. Sheets: top (top): 3 parts. Active sheet: top."
case("dup_chain3", TOP0, [{"role": "user", "content": "ทำแผ่น div27 เป็นตัวหาร 27 จากตัวหาร 3 สามตัวต่อกัน ขา clk_in clk_out"}], dup_chk("div27", "clock_divider", 3))
case("dup_mux", TOP0, [{"role": "user", "content": "ประกอบ mux 4:1 จาก mux 2:1 สามตัว ลงแผ่น sel4 (เข้า d0 d1 d2 d3 s0 s1 ออก y)"}], dup_chk("sel4", "mux", 3))
case("locked_retry", TOP0,
     [{"role": "user", "content": "ใส่ q = a | ~b ในแผ่น top ทับไปเลย"}, call1("build_circuit", {"sheet": "top", "formula": "q = a | ~b", "replace": True}),
      {"role": "tool", "tool_call_id": "c1", "content": "ERROR: sheet 'top' is locked for the agent (the user locked it) — do not change it; build into a new sheet instead, e.g. sheet:'top_new'"}],
     lambda calls, text: (lambda b: {"ok": bool(b) and b[0]["args"].get("sheet") not in (None, "top"), "why": json.dumps(b[0]["args"].get("sheet") if b else names(calls))})
     ([c for c in calls if c["name"].startswith("build_")]))
case("sim_cycles", "Project: t. Sheets: top (top): 3 parts; dv20: 12 parts. Active sheet: dv20 (ports: in clk_in, out clk_out).",
     [{"role": "user", "content": "จำลอง dv20 ให้ดูหน่อยว่าคาบออกมาเท่าไร"}],
     lambda calls, text: (lambda s: {"ok": bool(s) and int(s[0]["args"].get("cycles") or 0) >= 50, "why": "cycles=" + str(s[0]["args"].get("cycles") if s else names(calls))})
     ([c for c in calls if c["name"] == "simulate"]), wants_change=False)
case("verify_call", "Project: t. Sheets: top (top): 3 parts; vote: 8 parts. Active sheet: vote (ports: in a, in b, in c, out y).",
     [{"role": "user", "content": "เช็คว่าแผ่น vote ตรงกับ y = a&b | b&c | a&c ทุกแถวไหม"}],
     lambda calls, text: (lambda v: {"ok": bool(v) and "a" in str(v[0]["args"].get("formula", "")), "why": names(calls)})
     ([c for c in calls if c["name"] in ("verify_truth_table", "compare_sheets")]), wants_change=False)
case("qa_no_tool", TOP0, [{"role": "user", "content": "ทำไม 7-seg บนบอร์ด EDGE ต้องส่ง 0 ถึงจะติด"}],
     lambda calls, text: {"ok": not calls and bool(re.search(r"anode|แอโนด|active.?low|ลอจิกต่ำ|0 = ติด|0 คือติด", text, re.I)), "why": ("tool=" + names(calls)) if calls else text[:60]},
     wants_change=False)
SIM25 = {"sheet": "div25", "kind": "sequential", "clocks": 83, "summary": {"clk_out": {"changes": 6, "period": 25, "last": 0, "high": 0.47, "duty": 0.48, "values": [0, 1]}}}
case("period_answer", "Project: t. Sheets: top (top): 3 parts; div25: 6 parts. Active sheet: div25 (ports: in clk_in, out clk_out).",
     [{"role": "user", "content": "div 25 แก้เป็นหาร 5 สองตัวต่อกัน ขาเดิม"},
      call1("build_hierarchy", {"sheet": "div25", "replace": True, "blocks": [{"name": "d5a", "part": "clock_divider", "params": {"n": 5}}, {"name": "d5b", "part": "clock_divider", "params": {"n": 5}}],
                                "inputs": ["clk_in"], "outputs": ["clk_out"], "connect": [["clk_in", "d5a.clk_in"], ["d5a.clk_out", "d5b.clk_in"], ["d5b.clk_out", "clk_out"]]}),
      result1("build_hierarchy", {"sheet": "div25", "connected_bits": 3, "undriven_outputs": [], "unconnected_block_inputs": []}),
      calls_n([("check", {"sheet": "div25"}), ("simulate", {"sheet": "div25", "cycles": 83})]),
      *results_n([{"sheet": "div25", "errors": 0, "warnings": 0, "ok": True, "issues": []}, SIM25])],
     lambda calls, text: {"ok": not calls and "25" in text and "50" not in text, "why": ("tool=" + names(calls)) if calls else ("ok" if "25" in text and "50" not in text else "wrong-number")},
     wants_change=False)

if __name__ == "__main__":
    E.run()
