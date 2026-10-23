"""Format / tool-use eval for the FPGA Ecosystem agent model.

Replays the agent's FIRST decision of each case straight against the model through the app's
/api/llm/chat proxy, with the agent's real system prompt and its real tool schemas (41 with vhdl_block).
Modes:
  native  - exactly the agent's normal call (tools=..., temp from profile, thinking off)
  struct  - native, and when no tool call came back, the agent's constrained-decoding fallback:
            pick a tool from an enum, then fill that tool's own JSON schema (response_format)
Usage: python eval_format.py [N_trials] [case_filter] [--url http://127.0.0.1:8770]
"""
import json, re, sys, time, urllib.request, collections, os

URL = "http://127.0.0.1:8770/api/llm/chat"
for i, a in enumerate(sys.argv):
    if a == "--url": URL = sys.argv[i + 1]
ARGS = [a for a in sys.argv[1:] if not a.startswith("--") and not a.startswith("http")]
N = int(ARGS[0]) if ARGS else 3
FILTER = ARGS[1] if len(ARGS) > 1 else ""
TEMP = float(os.environ.get("EVAL_TEMP", "0.3"))
HERE = os.path.dirname(os.path.abspath(__file__))

TOOLS = json.load(open(os.path.join(HERE, "tools.json"), encoding="utf-8"))["tools"]
TOOLMAP = {t["function"]["name"]: t["function"] for t in TOOLS}
SYS_BASE = open(os.path.join(HERE, "sysprompt.txt"), encoding="utf-8").read()


def sysprompt(project_line):
    return SYS_BASE + "\n\n" + project_line


def post(body, timeout=600):
    req = urllib.request.Request(URL, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        j = json.loads(r.read().decode("utf-8"))
    j["_elapsed"] = time.time() - t0
    return j


# ---- the agent's text-call recovery (aiagTextCalls), simplified ----
def text_calls(content):
    out = []
    for m in re.finditer(r"<tool_call>\s*(\{[\s\S]*?\})\s*</tool_call>", content or ""):
        try:
            o = json.loads(m.group(1))
            if o.get("name") in TOOLMAP:
                out.append({"name": o["name"], "args": o.get("arguments") or {}})
        except Exception:
            pass
    for m in re.finditer(r"<function=([\w.-]+)>([\s\S]*?)(?:</function>|$)", content or ""):
        name, body, args = m.group(1), m.group(2), {}
        for q in re.finditer(r"<parameter=([\w.-]+)>\s*([\s\S]*?)\s*</parameter>", body):
            v = q.group(2)
            try: v = json.loads(v)
            except Exception: pass
            args[q.group(1)] = v
        if name in TOOLMAP:
            out.append({"name": name, "args": args})
    return out


def native(messages):
    j = post({"messages": messages, "tools": TOOLS, "temperature": TEMP, "top_p": 0.95, "top_k": 20,
              "parallel_tool_calls": True, "chat_template_kwargs": {"enable_thinking": os.environ.get("EVAL_THINK") == "1"}})
    m = ((j.get("choices") or [{}])[0]).get("message") or {}
    calls = []
    for c in (m.get("tool_calls") or []):
        f = c.get("function") or {}
        a = f.get("arguments")
        try: a = json.loads(a) if isinstance(a, str) else (a or {})
        except Exception: a = {"_unparsed": a}
        calls.append({"name": f.get("name"), "args": a})
    how = "native"
    if not calls:
        tc = text_calls(m.get("content"))
        if tc: calls, how = tc, "text"
    plan = (m.get("content") or "") + ("\n" + m["reasoning_content"] if m.get("reasoning_content") else "")
    return calls, plan, j["_elapsed"], how


def structured(messages, plan):
    names = [t["function"]["name"] for t in TOOLS]
    opt = {"temperature": 0, "top_p": 1, "chat_template_kwargs": {"enable_thinking": False}}
    base = messages + [{"role": "assistant", "content": plan[:3000]},
                       {"role": "user", "content": "(system) You wrote the plan but made no tool call, so nothing happened. Which ONE tool does the next step of that plan? Tools: "
                        + " | ".join(f"{t['function']['name']} — {str(t['function']['description']).split('. ')[0]}" for t in TOOLS)}]
    t = 0.0
    j = post(dict(messages=base, max_tokens=40, response_format={"type": "json_schema", "json_schema": {"name": "pick", "schema": {"type": "object", "properties": {"tool": {"type": "string", "enum": names}}, "required": ["tool"]}}}, **opt))
    t += j["_elapsed"]
    try: tool = json.loads(j["choices"][0]["message"]["content"])["tool"]
    except Exception: return None, t
    d = TOOLMAP[tool]
    j = post(dict(messages=base + [{"role": "assistant", "content": json.dumps({"tool": tool})},
                                   {"role": "user", "content": f"(system) Now the arguments of {tool}, filled from your plan and the user's request (sheet names, blocks, every connection). {d['description']}"}],
                  max_tokens=2000, response_format={"type": "json_schema", "json_schema": {"name": tool, "schema": d["parameters"]}}, **opt))
    t += j["_elapsed"]
    try: args = json.loads(j["choices"][0]["message"]["content"])
    except Exception: return None, t
    return {"name": tool, "args": args}, t


# ---------------- helpers for the checks ----------------
def edges_of(connect):
    """connect: [[drv, rcv, ...], ...] or ['a -> b', ...] or a single string -> set of (drv, rcv)"""
    E = set()
    if isinstance(connect, str): connect = re.split(r"[;\n,](?![^\[]*\])", connect)
    for c in connect or []:
        if isinstance(c, str):
            parts = [p.strip() for p in re.split(r"->|→|=>", c) if p.strip()]
        elif isinstance(c, list):
            parts = [str(p).strip() for p in c]
        elif isinstance(c, dict):
            parts = [str(c.get("from", "")).strip(), str(c.get("to", "")).strip()]
        else:
            continue
        for r in parts[1:]: E.add((parts[0], r))
    return E


def block_n(b):
    p = b.get("params") or {}
    try: return int(p.get("n"))
    except Exception: pass
    m = re.search(r"(\d+)$", str(b.get("sheet") or ""))
    return int(m.group(1)) if m else None


def chain_ok(args, ns_wanted):
    """blocks form clk_in -> b1 -> b2 -> clk_out with the n's (as a multiset) == ns_wanted"""
    blocks = args.get("blocks") or []
    names = {b.get("name"): b for b in blocks if isinstance(b, dict)}
    if sorted([block_n(b) or 0 for b in names.values()]) != sorted(ns_wanted): return False, "blocks"
    E = edges_of(args.get("connect"))
    if not E: return False, "no-connect"
    # walk from clk_in
    cur, seen = "clk_in", []
    for _ in range(len(names) + 1):
        nxt = [r for (d, r) in E if d == cur]
        if cur != "clk_in" and not nxt: break
        hit = None
        for r in nxt:
            if r == "clk_out": hit = "clk_out"; break
            blk = r.split(".")[0]
            if blk in names and blk not in seen: hit = blk; break
        if hit is None: return False, "broken@" + cur
        if hit == "clk_out": return (len(seen) == len(names)), "len" if len(seen) != len(names) else "ok"
        seen.append(hit); cur = hit + ".clk_out"
    return False, "no-out"


def tool_result(name, obj):
    return {"role": "tool", "tool_call_id": "c1", "content": json.dumps(obj, ensure_ascii=False)}


def assistant_call(name, args):
    return {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function",
            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}


LAB6 = ("Project: lab6. Sheets: top (top): 24 parts; div50: 19 parts; div40: 14 parts; div25: 13 parts; clkgen: 10 parts; "
        "counter2: 37 parts; disp: 24 parts. Active sheet: div50 (ports: in clk_in, out clk_out).")
GS_DIV = lambda s, n: {"sheet": s, "top": False, "ports": [{"name": "clk_in", "dir": "in", "width": 1}, {"name": "clk_out", "dir": "out", "width": 1}],
                       "components": [{"id": "clk", "type": "IN", "name": "clk_in"}] + [{"id": f"ff{i}", "type": "JKFF", "name": f"ff{i}"} for i in range(n)]
                       + [{"id": "out", "type": "OUT", "name": "clk_out"}], "note": "brief"}


def assistant_calls(pairs):
    return {"role": "assistant", "content": "", "tool_calls": [{"id": f"c{i}", "type": "function",
            "function": {"name": n, "arguments": json.dumps(a, ensure_ascii=False)}} for i, (n, a) in enumerate(pairs)]}


def tool_results(objs):
    return [{"role": "tool", "tool_call_id": f"c{i}", "content": json.dumps(o, ensure_ascii=False)} for i, o in enumerate(objs)]


def built_leaf(sheet, n):
    return {"sheet": sheet, "kind": "clock_divider", "params": {"n": n}, "ports": [{"name": "clk_in", "dir": "in", "width": 1}, {"name": "clk_out", "dir": "out", "width": 1}],
            "verified": {"pass": True, "method": f"{3*n} clock เทียบกับโมเดลสถานะ"}}


def seen_sheet(sheet, n_ff=6):
    return [assistant_call("get_sheet", {"sheet": sheet, "detail": "brief"}), tool_result("get_sheet", GS_DIV(sheet, n_ff))]


# ---------------- the cases ----------------
CASES = []


def case(name, project, msgs, check, wants_change=True):
    CASES.append(dict(name=name, project=project, msgs=msgs, check=check, wants_change=wants_change))


def split_check(sheet, ns):
    def chk(calls, text):
        bh = [c for c in calls if c["name"] == "build_hierarchy"]
        if not bh: return {"ok": False, "why": "tool=" + ",".join(c["name"] for c in calls) if calls else "no-call"}
        a = bh[0]["args"]
        ch, why = chain_ok(a, ns)
        if a.get("sheet") != sheet: return {"ok": False, "chain": ch, "why": "sheet=" + str(a.get("sheet"))}
        if not a.get("replace"): return {"ok": False, "chain": ch, "why": "no-replace" + ("" if ch else "+" + why)}
        return {"ok": ch, "chain": ch, "why": why}
    return chk


U_DIV50 = "แผ่น div50 มันใหญ่ไปหน่อย FF เยอะ ช่วยแตกเป็นก้อนเล็กให้ได้ไหม คือทำแผ่น div5 (หารความถี่ 5) กับแผ่น div10 (หาร 10) แยกไว้ แล้วให้แผ่น div50 เอา div5 มาต่อกับ div10 แทนของเดิม ขาเข้าออกขอชื่อ clk_in กับ clk_out เหมือนเดิมนะ เพราะแผ่น clkgen มันเรียกอยู่"
LAB6B = LAB6.replace("div25: 13 parts;", "div25: 13 parts; div5: 13 parts; div10: 15 parts;")
case("split_div50", LAB6B, seen_sheet("div50") + [{"role": "user", "content": U_DIV50},
     assistant_calls([("build_part", {"kind": "clock_divider", "n": 5, "sheet": "div5"}), ("build_part", {"kind": "clock_divider", "n": 10, "sheet": "div10"})])]
     + tool_results([built_leaf("div5", 5), built_leaf("div10", 10)]), split_check("div50", [5, 10]))
case("split_div25", LAB6.replace("Active sheet: div50", "Active sheet: div25"),
     seen_sheet("div25", 5) + [{"role": "user", "content": "div 25 แก้เป็น clock_divider_n5 สองตัวต่อกัน"}], split_check("div25", [5, 5]))
case("split_div40", LAB6.replace("Active sheet: div50", "Active sheet: div40"),
     seen_sheet("div40", 6) + [{"role": "user", "content": "แตก div40 เป็น div4 ต่อกับ div10 ให้หน่อย ขาเดิม clk_in clk_out"}], split_check("div40", [4, 10]))

# error recovery: the SFT1 opening move, then its error
case("recover_has_parts", LAB6,
     seen_sheet("div50") + [{"role": "user", "content": U_DIV50}, assistant_call("build_part", {"kind": "clock_divider", "n": 5, "sheet": "div50"}),
      {"role": "tool", "tool_call_id": "c1", "content": "ERROR: sheet 'div50' already has parts\nhint: give a new sheet name (it is created), or an empty sheet — or delete_sheet it first to rebuild it"}],
     lambda calls, text: (lambda r: r if r["ok"] or not calls or calls[0]["name"] != "build_part" or calls[0]["args"].get("sheet") != "div50"
                          else {"ok": False, "why": "repeated-failing-call"})(split_check("div50", [5, 10])(calls, text)))

# reading a result: build_hierarchy without connect -> parallel + undriven
BAD = {"sheet": "div50", "blocks": [{"name": "div5", "sheet": "clock_divider_n5", "verified": True}, {"name": "div10", "sheet": "clock_divider_n10", "verified": True}],
       "connected_bits": 2, "auto_connected": ["clk_in → div5.clk_in", "clk_in → div10.clk_in"], "unconnected_block_inputs": [],
       "undriven_outputs": ["clk_out"], "check": {"errors": 1, "warnings": 2}, "note": "draw the rest with another build_hierarchy {replace:true} (whole plan) or connect"}
case("read_result_fix", LAB6,
     seen_sheet("div50") + [{"role": "user", "content": U_DIV50},
      assistant_call("build_hierarchy", {"sheet": "div50", "replace": True, "blocks": [{"name": "div5", "part": "clock_divider", "params": {"n": 5}}, {"name": "div10", "part": "clock_divider", "params": {"n": 10}}], "inputs": ["clk_in"], "outputs": ["clk_out"]}),
      tool_result("build_hierarchy", BAD)],
     lambda calls, text: ({"ok": False, "why": "final-text" + ("+CLAIMS" if re.search(r"ผ่าน|เรียบร้อย|เสร็จ", text) else "")} if not calls else
                          (split_check("div50", [5, 10])(calls, text) if any(c["name"] == "build_hierarchy" for c in calls) else
                           {"ok": any(c["name"] == "connect" for c in calls), "why": "tool=" + ",".join(c["name"] for c in calls)})))

# verification routing
TOP6 = "Project: lab6. Sheets: top (top): 24 parts; counter2: 37 parts. Active sheet: top (ports: in clk, in btn, in sw0, in sw1, in sw2, in sw3, in sw4, in sw5, in sw6, in sw7, out err_led, out sa, out sb, out sc, out sd, out se, out sf, out sg, out dig1, out dig2)."
def probe_chk(calls, text):
    p = [c for c in calls if c["name"] == "probe"]
    if not p: return {"ok": False, "why": "tool=" + (",".join(c["name"] for c in calls) or "none")}
    i = p[0]["args"].get("inputs") or {}
    if "sw" in i:                                   # the group form the system prompt allows: sw:'0x0F'
        try: v = int(str(i["sw"]), 0)
        except Exception: v = -1
        return {"ok": v == 15, "why": "group sw=" + str(i["sw"])}
    try: ok = all(int(i.get(f"sw{k}", -1)) == 1 for k in range(4)) and all(int(i.get(f"sw{k}", 0)) == 0 for k in range(4, 8))
    except Exception: ok = False
    return {"ok": ok, "why": "inputs" if not ok else "ok"}
case("probe_route", TOP6, [{"role": "user", "content": "ถ้าตั้ง sw0 ถึง sw3 เป็น 1 หมด ที่เหลือเป็น 0 ไฟ err_led จะติดไหม ลองเทสให้หน่อย"}], probe_chk, wants_change=False)

# after a build: must check / simulate before answering
case("verify_after_build", "Project: t. Sheets: tick7: 9 parts. Active sheet: tick7 (ports: in clk_in, out clk_out).",
     [{"role": "user", "content": "ทำแผ่นชื่อ tick7 เป็นตัวหารความถี่ 7"}, assistant_call("build_part", {"kind": "clock_divider", "n": 7, "sheet": "tick7"}),
      tool_result("build_part", {"sheet": "tick7", "kind": "clock_divider", "params": {"n": 7}, "ports": [{"name": "clk_in", "dir": "in"}, {"name": "clk_out", "dir": "out"}], "verified": None})],
     lambda calls, text: {"ok": any(c["name"] in ("check", "simulate", "verify_truth_table", "check_spec") and c["args"].get("sheet", "tick7") == "tick7" for c in calls),
                          "why": ("tool=" + ",".join(c["name"] for c in calls)) if calls else ("final-text" + ("+CLAIMS" if re.search(r"ผ่าน|ตรวจแล้ว|ถูกต้อง", text) else ""))})

# keep the name the user gave
def name_chk(calls, text):
    for c in calls:
        a = c["args"]
        if c["name"] in ("build_part", "build_circuit") and a.get("sheet") == "tick7":
            n = a.get("n") or (a.get("params") or {}).get("n") or (a.get("generator") or {}).get("n")
            return {"ok": str(n) == "7", "why": "n=" + str(n)}
    return {"ok": False, "why": "calls=" + json.dumps([(c["name"], c["args"].get("sheet")) for c in calls], ensure_ascii=False)}
case("name_respect", "Project: t. Sheets: top (top): 3 parts. Active sheet: top.", [{"role": "user", "content": "ทำแผ่นชื่อ tick7 เป็นตัวหารความถี่ 7 ให้หน่อย"}], name_chk)

# two things in one message
def multi_chk(calls, text):
    sheets = {(c["args"].get("sheet"), str(c["args"].get("n") or (c["args"].get("params") or {}).get("n"))) for c in calls}
    ok = ("div4", "4") in sheets and ("div10", "10") in sheets
    return {"ok": ok, "why": "got=" + json.dumps(sorted(map(str, sheets)))}
case("multi_goal", "Project: t. Sheets: top (top): 3 parts. Active sheet: top.", [{"role": "user", "content": "ทำแผ่น div4 หารความถี่ 4 กับแผ่น div10 หาร 10 ให้หน่อย"}], multi_chk)

# array<string>
case("delete_refs", "Project: t. Sheets: div50: 19 parts. Active sheet: div50 (ports: in clk_in, out clk_out).",
     seen_sheet("div50") + [{"role": "user", "content": "ลบ ff0 ff1 กับ ff2 ออกจากแผ่นนี้"}],
     lambda calls, text: (lambda d: {"ok": bool(d) and sorted(d[0]["args"].get("refs") or []) == ["ff0", "ff1", "ff2"], "why": json.dumps(d[0]["args"] if d else [c["name"] for c in calls], ensure_ascii=False)[:120]})
     ([c for c in calls if c["name"] == "delete"]))

# object map
case("set_pins_map", "Project: t. Sheets: top (top): 6 parts. Active sheet: top (ports: in clk, in btn, out led_err).",
     [{"role": "user", "content": "ต่อขา led_err ไปที่ LED0 แล้วก็ btn ไปปุ่มกลาง"}],
     lambda calls, text: (lambda s: {"ok": bool(s) and str((s[0]["args"].get("map") or {}).get("led_err")).lower().replace(" ", "") in ("led:0", "led0") and str((s[0]["args"].get("map") or {}).get("btn")).lower() in ("pb:4", "center", "pb4"),
                                     "why": json.dumps(s[0]["args"] if s else [c["name"] for c in calls], ensure_ascii=False)[:120]})
     ([c for c in calls if c["name"] == "set_pins"]))

# blocks that are existing sheets + connect lists
def sheets_chk(calls, text):
    bh = [c for c in calls if c["name"] == "build_hierarchy"]
    if not bh: return {"ok": False, "why": "tool=" + (",".join(c["name"] for c in calls) or "none")}
    a = bh[0]["args"]; blocks = a.get("blocks") or []
    shs = sorted(str(b.get("sheet")) for b in blocks if isinstance(b, dict))
    E = edges_of(a.get("connect"))
    nm = {str(b.get("sheet")): b.get("name") for b in blocks if isinstance(b, dict)}
    cg, ds = nm.get("clkgen"), nm.get("disp")
    ok = shs == ["clkgen", "disp"] and a.get("sheet") == "top2" and ("clk", f"{cg}.clk") in E and (f"{cg}.dsel", f"{ds}.dsel") in E
    return {"ok": ok, "why": json.dumps({"blocks": shs, "E": sorted(E)[:4]}, ensure_ascii=False)[:160]}
case("blocks_from_sheets", "Project: lab6. Sheets: top (top): 24 parts; clkgen: 10 parts (ports: in clk, out clk20, out dsel); disp: 24 parts (ports: in dsel, in u0, in u1, in u2, in u3, in t0, in t1, in t2, in t3, out sa, out sb, out sc, out sd, out se, out sf, out sg, out dig1, out dig2). Active sheet: top.",
     [{"role": "user", "content": "สร้างแผ่นใหม่ชื่อ top2 ประกอบจากแผ่น clkgen กับแผ่น disp ที่มีอยู่แล้ว ให้ขา clk ข้างนอกเข้า clkgen.clk แล้ว clkgen.dsel ไปเข้า disp.dsel"}], sheets_chk)


# ---------------- VHDL blocks (vhdl_block) ----------------
# the text the model writes is compiled and run by the app's own VHDL simulator (vhdl_check.js, needs node);
# without node only the call's shape is checked
import shutil, subprocess


def vhdl_runs(vhdl, spec):
    if not shutil.which("node"):
        return ("entity" in str(vhdl).lower()), "no-node: shape only"
    try:
        r = subprocess.run(["node", os.path.join(HERE, "vhdl_check.js")], input=json.dumps(dict(spec, vhdl=vhdl)),
                           capture_output=True, text=True, encoding="utf-8", timeout=30)
        j = json.loads(r.stdout or "{}")
        return bool(j.get("ok")), str(j.get("why"))[:120]
    except Exception as e:
        return False, "checker: " + str(e)[:80]


def vhdl_chk(sheet, spec):
    def chk(calls, text):
        v = [c for c in calls if c["name"] == "vhdl_block"]
        if not v: return {"ok": False, "why": "tool=" + (",".join(c["name"] for c in calls) or "none")}
        a = v[0]["args"]
        if str(a.get("sheet", "")).lower() != sheet: return {"ok": False, "why": "sheet=" + str(a.get("sheet"))}
        ok, why = vhdl_runs(a.get("vhdl", ""), spec)
        return {"ok": ok, "why": why}
    return chk


ROM_T = [9, 33, 17, 60, 0, 45, 12, 63]
case("vhdl_rom", "Project: t. Sheets: top (top): 3 parts. Active sheet: top.",
     [{"role": "user", "content": "แผ่น seg_tab: ทำตารางค้นหา code 3 บิต → pat 6 บิต ค่าตามนี้ " + ", ".join(f"{i}→{v}" for i, v in enumerate(ROM_T))}],
     vhdl_chk("seg_tab", {"kind": "rom", "x": "code", "y": "pat", "table": ROM_T}))
STOP_V = [{"clr": 1 if i == 16 else 0} for i in range(20)]
STOP_Q = []
_c = 0
for _v in STOP_V:
    STOP_Q.append(_c); _c = 0 if _v["clr"] else min(_c + 1, 12)
case("vhdl_stop", "Project: t. Sheets: top (top): 3 parts. Active sheet: top.",
     [{"role": "user", "content": "ขอตัวนับ 0 ถึง 12 แล้วหยุดค้างที่ 12 ขาเข้า clk กับ clr (ล้างเป็น 0 แบบซิงโครนัส) ขาออก q 4 บิต เขียนเป็น VHDL ลงแผ่น c12"}],
     vhdl_chk("c12", {"kind": "seq", "clk": "clk", "vectors": STOP_V, "expect": {"q": STOP_Q}}))
BAD_ROM = ('library ieee;\nuse ieee.std_logic_1164.all;\nuse ieee.numeric_std.all;\n\nentity pat8 is\n  port ( code : in  std_logic_vector(2 downto 0);\n'
           '         pat  : out std_logic_vector(5 downto 0) );\nend pat8;\n\narchitecture rtl of pat8 is\n'
           '  type rom_t is array (0 to 7) of std_logic_vector(5 downto 0);\n  constant ROM : rom_t := ("001001", "100001", "10001", "111100", "000000", "101101", "001100", "111111");\n'
           'begin\n  pat <= ROM(to_integer(unsigned(code)));\nend rtl;\n').encode().decode("unicode_escape")
case("vhdl_fix_error", "Project: t. Sheets: top (top): 3 parts. Active sheet: top.",
     [{"role": "user", "content": "แผ่น seg_tab: ทำตารางค้นหา code 3 บิต → pat 6 บิต ค่าตามนี้ " + ", ".join(f"{i}→{v}" for i, v in enumerate(ROM_T))},
      assistant_call("vhdl_block", {"vhdl": BAD_ROM, "sheet": "seg_tab"}),
      {"role": "tool", "tool_call_id": "c1", "content": "ERROR: VHDL: บรรทัด 12: ความกว้างไม่ตรง: ด้านซ้าย 6 บิต, ด้านขวา 5 บิต\nhint: fix the text and call again (nothing was saved)"}],
     vhdl_chk("seg_tab", {"kind": "rom", "x": "code", "y": "pat", "table": ROM_T}))
case("vhdl_verify_after", "Project: t. Sheets: top (top): 3 parts; c12: 7 parts. Active sheet: c12 (ports: in clk, in clr, out q[3:0]).",
     [{"role": "user", "content": "ขอตัวนับ 0 ถึง 12 แล้วหยุดค้างที่ 12 ขาเข้า clk กับ clr ขาออก q 4 บิต เขียนเป็น VHDL ลงแผ่น c12"},
      assistant_call("vhdl_block", {"vhdl": "(the text)", "sheet": "c12"}),
      tool_result("vhdl_block", {"name": "upto12", "ports": [{"name": "clk", "dir": "in", "width": 1}, {"name": "clr", "dir": "in", "width": 1}, {"name": "q", "dir": "out", "width": 4}],
                                 "sequential": True, "clocks": ["clk"], "warnings": [], "placed": {"sheet": "c12", "block": "c5", "ports": ["in clk", "in clr", "out q[3:0]"]},
                                 "note": "sheet 'c12' = this block with a port per entity port — next: check + simulate {sheet:'c12'}"})],
     lambda calls, text: {"ok": any(c["name"] in ("check", "simulate") and str(c["args"].get("sheet", "c12")).lower() == "c12" for c in calls),
                          "why": ("tool=" + ",".join(c["name"] for c in calls)) if calls else ("final-text" + ("+CLAIMS" if re.search(r"ผ่าน|ตรวจแล้ว|ถูกต้อง", text) else ""))})
case("no_vhdl_for_part", "Project: t. Sheets: top (top): 3 parts. Active sheet: top.",
     [{"role": "user", "content": "ทำแผ่น mux8 เป็น multiplexer 8 ต่อ 1 ให้หน่อย"}],
     lambda calls, text: {"ok": any(c["name"] in ("build_part", "build_circuit") for c in calls) and not any(c["name"] == "vhdl_block" for c in calls),
                          "why": "tool=" + (",".join(c["name"] for c in calls) or "none")})


def run():
    rows = []
    agg = collections.defaultdict(lambda: collections.Counter())
    for C in CASES:
        if FILTER and FILTER not in C["name"]: continue
        msgs = [{"role": "system", "content": sysprompt(C["project"])}] + C["msgs"]
        for k in range(N):
            try:
                calls, text, el, how = native(msgs)
            except Exception as e:
                print(C["name"], k, "ERR", e); continue
            r1 = C["check"](calls, text)
            rec = {"case": C["name"], "trial": k, "how": how, "s_native": round(el, 1), "native": r1,
                   "calls": calls, "text": text[:400]}
            r2, el2 = r1, 0.0
            if not calls and text.strip() and C["wants_change"]:
                sc, el2 = structured(msgs, text)
                rec["struct_call"] = sc
                r2 = C["check"]([sc] if sc else [], text)
            rec["struct"], rec["s_struct"] = r2, round(el2, 1)
            rows.append(rec)
            agg[C["name"]]["n"] += 1
            agg[C["name"]]["native_ok"] += int(bool(r1["ok"]))
            agg[C["name"]]["struct_ok"] += int(bool(r2["ok"]))
            agg[C["name"]]["called"] += int(bool(calls))
            agg[C["name"]]["chain"] += int(bool(r2.get("chain", r2["ok"])))
            agg[C["name"]]["sec"] += el + el2
            print(f"{C['name']:<20} t{k} {how:<6} native={'OK ' if r1['ok'] else 'NO '}{str(r1['why'])[:60]:<60} "
                  f"struct={'OK' if r2['ok'] else 'NO'} {el:5.1f}s+{el2:4.1f}s", flush=True)
    tag = os.environ.get("EVAL_TAG", "run")
    with open(os.path.join(HERE, f"eval_{tag}.jsonl"), "w", encoding="utf-8") as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("\n=== SUMMARY (" + tag + f", temp {TEMP}) ===")
    print(f"{'case':<20} {'called':>7} {'native':>7} {'+struct':>8} {'core':>6} {'avg s':>6}")
    T = collections.Counter()
    for name, a in agg.items():
        print(f"{name:<20} {a['called']}/{a['n']:<5} {a['native_ok']}/{a['n']:<5} {a['struct_ok']}/{a['n']:<6} {a['chain']}/{a['n']:<4} {a['sec']/max(1,a['n']):6.1f}")
        for k2 in a: T[k2] += a[k2]
    print(f"{'TOTAL':<20} {T['called']}/{T['n']:<5} {T['native_ok']}/{T['n']:<5} {T['struct_ok']}/{T['n']:<6} {T['chain']}/{T['n']:<4} {T['sec']/max(1,T['n']):6.1f}")


if __name__ == "__main__":
    run()
