"""SFT2 families for VHDL blocks (vhdl_block) — added to gen_sft2.py's GENS by install(globals()).

Every call runs in the real app like the rest of gen_sft2. A row is kept only when the simulation the
model saw matches a reference computed HERE (Python models below) — the check is outside the
conversation, so the final Thai answer can say "matches" only when it really does.

  vhdl      a request a part / formula cannot express well (a lookup table, a counter that stops,
            an up/down counter, a timed FSM, max / min / |a-b|, an accumulator) → vhdl_block {vhdl, sheet}
            → check + simulate → answer from what the simulation showed
  vhdl_fix  the first text has a mistake the app refuses with the line (weight 0: context only) →
            the corrected call → check + simulate → answer
  vhdl_sem  the first text compiles but does the wrong thing (weight 0) → check + simulate (trained:
            the habit) → the model reads the values, rewrites on the SAME sheet with replace:true →
            simulate again → answer saying what was wrong
"""
import random

HDR = ["library ieee;\nuse ieee.std_logic_1164.all;\nuse ieee.numeric_std.all;\n",
       "library IEEE;\nuse IEEE.STD_LOGIC_1164.ALL;\nuse IEEE.NUMERIC_STD.ALL;\n"]


def bits(n):
    return max(1, (n).bit_length())


def b(v, w):
    return format(v, f"0{w}b")


# ------------------------------------------------------------------ the designs: (vhdl text, reference)
def d_rom(rng, ent, x, y, k, m, table, style, bug=None):
    n = 1 << k
    rows = list(table)
    if bug == "row":                                   # one entry typed wrong (semantic)
        i = rng.randrange(n); rows[i] = (rows[i] + 1 + rng.randrange((1 << m) - 1)) % (1 << m)
    lit = [b(v, m) for v in rows]
    if bug == "width":                                 # one literal a bit short (compile error)
        i = rng.randrange(n); lit[i] = lit[i][1:]
    h = rng.choice(HDR)
    if style == "array":
        body = (f"  type rom_t is array (0 to {n - 1}) of std_logic_vector({m - 1} downto 0);\n"
                f"  constant ROM : rom_t := (\n    " + ",\n    ".join(f'"{s}"' for s in lit) + ");\nbegin\n"
                f"  {y} <= ROM(to_integer(unsigned({x})));\n")
    elif style == "case":
        body = "begin\n  process(" + x + ")\n  begin\n    case " + x + " is\n" + "".join(
            f'      when "{b(i, k)}" => {y} <= "{lit[i]}";\n' for i in range(n - 1)) + \
            f'      when others => {y} <= "{lit[n - 1]}";\n    end case;\n  end process;\n'
    else:
        body = f"begin\n  with {x} select\n    {y} <= " + ",\n         ".join(
            f'"{lit[i]}" when "{b(i, k)}"' for i in range(n - 1)) + f',\n         "{lit[n - 1]}" when others;\n'
    v = (h + f"\nentity {ent} is\n  port ( {x} : in  std_logic_vector({k - 1} downto 0);\n         {y} : out std_logic_vector({m - 1} downto 0) );\n"
         f"end {ent};\n\narchitecture rtl of {ent} is\n" + body + "end rtl;\n")
    return v


def d_upto(rng, ent, N, w, style, bug=None):
    h = rng.choice(HDR)
    stop = f"c /= {N}" if bug != "wrap" else "true"
    if style == "uns":
        sig = f"  signal c : unsigned({w - 1} downto 0) := (others => '0');\n"
        nxt = "c <= c + 1;" if bug != "wrap" else f"if c = {N} then c <= (others => '0'); else c <= c + 1; end if;"
        clr = "c <= (others => '0');"
        out = "  q <= c;\n" if bug == "uns2slv" else "  q <= std_logic_vector(c);\n"
    else:
        sig = f"  signal c : integer range 0 to {N} := 0;\n"
        nxt = "c <= c + 1;" if bug != "wrap" else f"if c = {N} then c <= 0; else c <= c + 1; end if;"
        clr = "c <= 0;"
        out = "  q <= c;\n" if bug == "int2vec" else f"  q <= std_logic_vector(to_unsigned(c, {w}));\n"
    cond = "clr" if bug == "cond" else "clr = '1'"
    stop_line = (f"      elsif {stop} then\n        {nxt}\n") if bug != "wrap" else f"      else\n        {nxt}\n"
    done = f"  done <= '1' when c = {N} else '0';\n"
    extra = ""
    if bug == "multi":                     # done driven twice (also inside the process)
        extra = "        done <= '0';\n"
    proc = (f"  process(clk)\n  begin\n    if rising_edge(clk) then\n{extra}      if {cond} then\n        {clr}\n" + stop_line +
            "      end if;\n    end if;\n  end process;\n")
    return (h + f"\nentity {ent} is\n  port ( clk : in  std_logic;\n         clr : in  std_logic;\n"
            f"         q   : out std_logic_vector({w - 1} downto 0);\n         done : out std_logic );\nend {ent};\n\n"
            f"architecture rtl of {ent} is\n{sig}begin\n{proc}{out}{done}end rtl;\n")


def r_upto(N, vec):
    c, q, done = 0, [], []
    for v in vec:
        q.append(c); done.append(1 if c == N else 0)
        if v.get("clr"):
            c = 0
        elif c != N:
            c += 1
    return {"q": q, "done": done}


def d_updown(rng, ent, M, w, bug=None):
    h = rng.choice(HDR)
    top = M - 1 if bug != "off1" else M
    return (h + f"\nentity {ent} is\n  port ( clk : in  std_logic;\n         en  : in  std_logic;\n         up  : in  std_logic;\n"
            f"         q   : out std_logic_vector({w - 1} downto 0) );\nend {ent};\n\narchitecture rtl of {ent} is\n"
            f"  signal c : unsigned({w - 1} downto 0) := (others => '0');\nbegin\n"
            f"  process(clk)\n  begin\n    if rising_edge(clk) then\n      if en = '1' then\n        if up = '1' then\n"
            f"          if c = {top} then c <= (others => '0'); else c <= c + 1; end if;\n        else\n"
            f"          if c = 0 then c <= to_unsigned({top}, {w}); else c <= c - 1; end if;\n        end if;\n"
            f"      end if;\n    end if;\n  end process;\n  q <= std_logic_vector(c);\nend rtl;\n")


def r_updown(M, vec):
    c, q = 0, []
    for v in vec:
        q.append(c)
        if v.get("en"):
            c = (c + 1) % M if v.get("up") else (c - 1) % M
    return {"q": q}


def d_traffic(rng, ent, G, Y, R, bug=None):
    h = rng.choice(HDR)
    y2 = Y + (1 if bug == "len" else 0)
    mx = max(G, y2, R)
    return (h + f"\nentity {ent} is\n  port ( clk : in  std_logic;\n         rst : in  std_logic;\n"
            f"         g, y, r : out std_logic );\nend {ent};\n\narchitecture rtl of {ent} is\n"
            f"  type state_t is (S_GREEN, S_YELLOW, S_RED);\n  signal st : state_t := S_GREEN;\n"
            f"  signal t  : integer range 0 to {mx} := 0;\nbegin\n"
            f"  process(clk)\n  begin\n    if rising_edge(clk) then\n      if rst = '1' then\n        st <= S_GREEN; t <= 0;\n"
            f"      else\n        case st is\n"
            f"          when S_GREEN  => if t = {G - 1} then st <= S_YELLOW; t <= 0; else t <= t + 1; end if;\n"
            f"          when S_YELLOW => if t = {y2 - 1} then st <= S_RED;    t <= 0; else t <= t + 1; end if;\n"
            f"          when S_RED    => if t = {R - 1} then st <= S_GREEN;  t <= 0; else t <= t + 1; end if;\n"
            f"        end case;\n      end if;\n    end if;\n  end process;\n"
            f"  g <= '1' when st = S_GREEN  else '0';\n  y <= '1' when st = S_YELLOW else '0';\n  r <= '1' when st = S_RED    else '0';\nend rtl;\n")


def r_traffic(G, Y, R, vec):
    seq = ["g"] * G + ["y"] * Y + ["r"] * R
    p, out = 0, {"g": [], "y": [], "r": []}
    for v in vec:
        for k in out:
            out[k].append(1 if seq[p] == k else 0)
        p = 0 if v.get("rst") else (p + 1) % len(seq)
    return out


def d_arith(rng, ent, op, n, bug=None):
    h = rng.choice(HDR)
    if op == "max":
        expr = ("  y <= a when unsigned(a) > unsigned(b) else b;\n" if bug != "swap" else
                "  y <= a when unsigned(a) < unsigned(b) else b;\n")
    elif op == "min":
        expr = ("  y <= a when unsigned(a) < unsigned(b) else b;\n" if bug != "swap" else
                "  y <= a when unsigned(a) > unsigned(b) else b;\n")
    else:
        expr = ("  y <= std_logic_vector(unsigned(a) - unsigned(b)) when unsigned(a) >= unsigned(b)\n"
                "       else std_logic_vector(unsigned(b) - unsigned(a));\n") if bug != "swap" else \
               "  y <= std_logic_vector(unsigned(a) - unsigned(b));\n"
    return (h + f"\nentity {ent} is\n  port ( a, b : in  std_logic_vector({n - 1} downto 0);\n"
            f"         y    : out std_logic_vector({n - 1} downto 0) );\nend {ent};\n\narchitecture rtl of {ent} is\nbegin\n{expr}end rtl;\n")


def f_arith(op, a, b_):
    return max(a, b_) if op == "max" else min(a, b_) if op == "min" else abs(a - b_)


def d_accum(rng, ent, n, w, bug=None):
    h = rng.choice(HDR)
    return (h + f"\nentity {ent} is\n  port ( clk : in  std_logic;\n         add : in  std_logic;\n         clr : in  std_logic;\n"
            f"         x   : in  std_logic_vector({n - 1} downto 0);\n         acc : out std_logic_vector({w - 1} downto 0) );\n"
            f"end {ent};\n\narchitecture rtl of {ent} is\n  signal s : unsigned({w - 1} downto 0) := (others => '0');\nbegin\n"
            f"  process(clk)\n  begin\n    if rising_edge(clk) then\n      if clr = '1' then\n        s <= (others => '0');\n"
            f"      elsif add = '1' then\n        s <= s + resize(unsigned(x), {w});\n      end if;\n    end if;\n  end process;\n"
            f"  acc <= std_logic_vector(s);\nend rtl;\n")


def r_accum(w, vec):
    s, out = 0, []
    for v in vec:
        out.append(s)
        if v.get("clr"):
            s = 0
        elif v.get("add"):
            s = (s + v.get("x", 0)) % (1 << w)
    return {"acc": out}


# ------------------------------------------------------------------ install into gen_sft2
def install(G):
    call, Traj, fresh_project, pick, yield_rows, check_line = (G[k] for k in ("call", "Traj", "fresh_project", "pick", "yield_rows", "check_line"))
    rng = random.Random(4242)
    VH = "VHDL"

    def thai_list(xs, n=16):
        xs = list(xs)
        return ", ".join(str(v) for v in xs[:n]) + (" …" if len(xs) > n else "")

    def table_ok(sres, x, y, table):
        try:
            got = {r[x]: r[y] for r in (sres or {}).get("table") or []}
        except Exception:
            return False
        return all(got.get(i) == v for i, v in enumerate(table)) and len(got) == len(table)

    def seq_ok(sres, want):
        try:
            vals = (sres or {}).get("values") or []
            return all([v.get(k) for v in vals][:len(L)] == L for k, L in want.items()) and len(vals) >= min(len(L) for L in want.values())
        except Exception:
            return False

    def built_line(sheet, ent, res):
        ports = ", ".join(((res or {}).get("placed") or {}).get("ports") or [])
        return pick(f"สร้างแผ่น {sheet} จากบล็อก VHDL `{ent}` แล้วครับ", f"ทำแผ่น {sheet} เป็นบล็อก VHDL `{ent}` เรียบร้อย",
                    f"เขียน VHDL เป็นบล็อก `{ent}` ลงแผ่น {sheet} แล้ว") + (f" (ขา: {ports})" if ports else "")

    # ---- one design = (kind, params, the right text, reference, how to simulate, how to say what it does)
    def make(kind):
        sheet = pick("lab", "my_rom", "conv", "ctrl", "cnt", "light", "calc", "acc_top", "unit", "blk") + str(rng.randint(1, 99))
        if kind == "rom":
            k = rng.choice([2, 3, 3, 4]); m = rng.choice([3, 4, 5, 6, 7, 8]); n = 1 << k
            table = [rng.randrange(1 << m) for _ in range(n)]
            x, y = rng.choice([("addr", "data"), ("x", "y"), ("sel", "code"), ("i", "o"), ("a", "f")])
            ent = rng.choice(["lut", "rom", "tbl", "conv"]) + str(n)
            style = rng.choice(["array", "case", "select"])
            pairs = ", ".join(f"{i}→{v}" for i, v in enumerate(table))
            users = [f"ทำวงจรแปลงค่า {x} ({k} บิต) เป็น {y} ({m} บิต) ตามตารางนี้: {pairs} ลงแผ่น {sheet}",
                     f"อยากได้ ROM เล็กๆ {n} ช่อง ช่องละ {m} บิต ค่าตามลำดับคือ {', '.join(map(str, table))} ขาเข้า {x} ขาออก {y} ใส่แผ่น {sheet}",
                     f"แผ่น {sheet}: ขอตารางค้นหา {x}[{k - 1}:0] → {y}[{m - 1}:0] ({pairs}) เขียนเป็น VHDL ก็ได้"]
            return dict(kind=kind, sheet=sheet, ent=ent, users=users, x=x, y=y, k=k, m=m, table=table, style=style,
                        text=lambda bug=None: d_rom(rng, ent, x, y, k, m, table, style, bug),
                        sim={"sheet": sheet}, ok=lambda s: table_ok(s, x, y, table),
                        says=lambda s: f"- จำลองครบ {n} แถว ตรงตามตารางทุกช่อง ({pairs})")
        if kind == "upto":
            N = rng.randint(5, 40); w = bits(N); ent = rng.choice(["upto", "cnt_stop", "count_to", "stopcnt"]) + str(N)
            style = rng.choice(["uns", "int"])
            cyc = N + rng.randint(3, 6); at = rng.randrange(N + 1, cyc)
            vec = [{"clr": 1 if i == at else 0} for i in range(cyc + 3)]
            want = r_upto(N, vec)
            users = [f"ทำตัวนับ 0 ถึง {N} แล้วหยุดค้างไว้ที่ {N} มีขา clr ล้างกลับ 0 (ซิงโครนัส) กับไฟ done ติดตอนนับถึง {N} ออกเป็น q ลงแผ่น {sheet}",
                     f"ขอวงจรนับขึ้นจาก 0 พอถึง {N} ให้ค้าง ไม่วนกลับ จนกว่าจะกด clr ขาออก q กับ done เขียนเป็น VHDL แผ่น {sheet}",
                     f"แผ่น {sheet}: counter นับถึง {N} แล้วหยุด (done = 1 ตอนหยุด, clr = เริ่มใหม่)"]
            return dict(kind=kind, sheet=sheet, ent=ent, users=users, N=N, w=w, style=style,
                        text=lambda bug=None: d_upto(rng, ent, N, w, style, bug),
                        sim={"sheet": sheet, "vectors": vec}, ok=lambda s: seq_ok(s, want),
                        says=lambda s: f"- จำลอง {len(vec)} clock: q = {thai_list(want['q'], 24)} (นับถึง {N} แล้วค้าง done = 1, กด clr ที่ clock {at} กลับเป็น 0)")
        if kind == "updown":
            M = rng.choice([5, 6, 7, 10, 12, 16]); w = bits(M - 1); ent = rng.choice(["updn", "ud_cnt", "bidir"]) + str(M)
            vec = [{"en": 1 if i < 3 or rng.random() < 0.85 else 0, "up": 0 if i < 3 else 1} for i in range(M + 8)]
            want = r_updown(M, vec)
            users = [f"ตัวนับขึ้นลง mod {M} (0 ถึง {M - 1} วน) up = 1 นับขึ้น up = 0 นับลง นับเฉพาะตอน en = 1 ขาออก q ลงแผ่น {sheet}",
                     f"ขอ up/down counter 0..{M - 1} วนรอบ มีขา up กับ en ทำเป็น VHDL ลงแผ่น {sheet}",
                     f"แผ่น {sheet}: นับขึ้นหรือลงตาม up ช่วง 0–{M - 1} (ลงจาก 0 ไป {M - 1}) หยุดเมื่อ en = 0"]
            return dict(kind=kind, sheet=sheet, ent=ent, users=users, M=M, w=w,
                        text=lambda bug=None: d_updown(rng, ent, M, w, bug),
                        sim={"sheet": sheet, "vectors": vec}, ok=lambda s: seq_ok(s, want),
                        says=lambda s: f"- จำลอง {len(vec)} clock (นับลง 3 clock แล้วนับขึ้น): q = {thai_list(want['q'], 24)} — ลงจาก 0 ไป {M - 1} และขึ้นจาก {M - 1} กลับ 0 ถูกต้อง")
        if kind == "traffic":
            Gt, Yt, Rt = rng.randint(2, 6), rng.randint(1, 2), rng.randint(2, 5); ent = rng.choice(["traffic", "tlight", "signal3"])
            per = Gt + Yt + Rt; vec = [{"rst": 0} for _ in range(2 * per + 2)]
            want = r_traffic(Gt, Yt, Rt, vec)
            users = [f"ไฟจราจร: เขียว {Gt} clock เหลือง {Yt} clock แดง {Rt} clock แล้ววน มีขา rst (ซิงโครนัส) กลับไปเขียว ขาออก g y r ลงแผ่น {sheet}",
                     f"ทำ FSM ไฟจราจร g/y/r: เขียวค้าง {Gt} จังหวะ เหลือง {Yt} แดง {Rt} เริ่มที่เขียว แผ่น {sheet}",
                     f"แผ่น {sheet}: state machine ไฟเขียว {Gt} → เหลือง {Yt} → แดง {Rt} clock วนไป (rst = เริ่มใหม่ที่เขียว)"]
            return dict(kind=kind, sheet=sheet, ent=ent, users=users,
                        text=lambda bug=None: d_traffic(rng, ent, Gt, Yt, Rt, bug),
                        sim={"sheet": sheet, "cycles": len(vec)}, ok=lambda s: seq_ok(s, want),
                        says=lambda s: f"- จำลอง {len(vec)} clock: เขียว {Gt} → เหลือง {Yt} → แดง {Rt} แล้ววน (รอบละ {per} clock) ตามที่ขอ")
        if kind == "arith":
            op = rng.choice(["max", "min", "absdiff"]); n = rng.choice([3, 4]); ent = {"max": "maxab", "min": "minab", "absdiff": "absdiff"}[op] + str(n)
            name = {"max": "ค่ามากกว่าระหว่าง a กับ b", "min": "ค่าน้อยกว่าระหว่าง a กับ b", "absdiff": "|a − b| (ผลต่างไม่ติดลบ)"}[op]
            users = [f"ขอวงจรหา{name} a, b เป็นเลข {n} บิตไม่มีเครื่องหมาย ขาออก y ลงแผ่น {sheet}",
                     f"แผ่น {sheet}: y = {'max(a, b)' if op == 'max' else 'min(a, b)' if op == 'min' else '|a - b|'} สำหรับ a, b {n} บิต เขียน VHDL ได้เลย",
                     f"ทำ {name} {n} บิตให้หน่อย ใส่แผ่น {sheet}"]
            def ok(s):
                try:
                    return all(r["y"] == f_arith(op, r["a"], r["b"]) for r in (s or {}).get("table") or []) and len((s or {}).get("table") or []) == 1 << (2 * n)
                except Exception:
                    return False
            return dict(kind=kind, sheet=sheet, ent=ent, users=users, op=op, n=n,
                        text=lambda bug=None: d_arith(rng, ent, op, n, bug),
                        sim={"sheet": sheet}, ok=ok,
                        says=lambda s: f"- จำลองครบ {1 << (2 * n)} แถว ถูกทุกแถว เช่น " + ", ".join(
                            f"a={a_},b={b_}→{f_arith(op, a_, b_)}" for a_, b_ in [(5 % (1 << n), 2), (1, 6 % (1 << n)), (3, 3)]))
        if kind == "accum":
            n = rng.choice([3, 4]); w = rng.choice([6, 8]); ent = rng.choice(["accum", "summer", "acc"]) + str(w)
            vec = [{"add": 1 if rng.random() < 0.7 else 0, "clr": 1 if i == 11 else 0, "x": rng.randrange(1, 1 << n)} for i in range(16)]
            want = r_accum(w, vec)
            users = [f"ตัวสะสมค่า: ทุก clock ถ้า add = 1 ให้ acc = acc + x (x {n} บิต, acc {w} บิต) clr ล้างเป็น 0 ลงแผ่น {sheet}",
                     f"ขอ accumulator {w} บิต บวก x ({n} บิต) เข้าไปทุกครั้งที่ add = 1 มี clr แผ่น {sheet} เขียนเป็น VHDL",
                     f"แผ่น {sheet}: acc เก็บผลรวมของ x ที่เข้ามาตอน add = 1 (clr = เริ่ม 0 ใหม่)"]
            return dict(kind=kind, sheet=sheet, ent=ent, users=users,
                        text=lambda bug=None: d_accum(rng, ent, n, w, bug),
                        sim={"sheet": sheet, "vectors": vec}, ok=lambda s: seq_ok(s, want),
                        says=lambda s: f"- จำลอง {len(vec)} clock ด้วย x / add สุ่ม: acc = {thai_list(want['acc'], 16)} ตรงกับผลรวมที่คิดมือ (clr ที่ clock 11)")
        raise ValueError(kind)

    def run_good(T, D, replace=False):
        args = {"vhdl": D["text"](), "sheet": D["sheet"]}
        if replace:
            args["replace"] = True
        (ok, res, cont), = T.turn([("vhdl_block", args)])
        if not ok:
            raise RuntimeError("good vhdl failed: " + cont[:300])
        (okc, cres, _), (oks, sres, scont) = T.turn([("check", {"sheet": D["sheet"]}), ("simulate", D["sim"])])
        if not oks or not D["ok"](sres):
            raise RuntimeError("simulation does not match the reference: " + scont[:400])
        return res, cres, sres

    def gen_vhdl():
        kinds = ["rom"] * 4 + ["upto"] * 3 + ["updown"] * 2 + ["traffic"] * 2 + ["arith"] * 2 + ["accum"] * 2
        for kind in kinds * 3:
            try:
                fresh_project("vhdl")
                D = make(kind)
                T = Traj("vhdl", {"kind": kind, "ent": D["ent"]})
                T.start(D["users"][0])
                res, cres, sres = run_good(T, D)
                T.final("\n".join([built_line(D["sheet"], D["ent"], res), "- " + check_line(cres), D["says"](sres)]))
                yield_rows(T.rows(D["users"]))
            except Exception as e:
                print("  vhdl fail", kind, e)

    FIX = [("upto", "uns2slv", {"style": "uns"}, "q เป็น std_logic_vector แต่ c เป็น unsigned ต้องแปลงด้วย std_logic_vector(c)"),
           ("upto", "int2vec", {"style": "int"}, "c เป็น integer ต้องแปลงเป็นเวกเตอร์ด้วย std_logic_vector(to_unsigned(c, …))"),
           ("upto", "cond", {}, "เงื่อนไข if ต้องเทียบค่า clr = '1' ไม่ใช่ clr เฉยๆ"),
           ("upto", "multi", {}, "done ถูกกำหนดค่าสองที่ (ใน process และนอก process) เหลือไว้ที่เดียว"),
           ("rom", "width", {"rom_style": "array"}, "ค่าในตารางช่องหนึ่งพิมพ์บิตขาดไป แก้ให้ครบทุกช่อง"),
           ("rom", "samename", {}, "ชื่อแผ่นซ้ำกับชื่อ entity เปลี่ยนชื่อ entity ไม่ให้ซ้ำกับชื่อแผ่น")]

    def gen_vhdl_fix():
        for _ in range(3):
            for kind, bug, force, why in FIX:
                try:
                    fresh_project("vhfix")
                    D = make(kind)
                    if "rom_style" in force:
                        D["style"] = force["rom_style"]
                        D["text"] = (lambda D: (lambda bug=None: d_rom(rng, D["ent"], D["x"], D["y"], D["k"], D["m"], D["table"], D["style"], bug)))(D)
                    if "style" in force and D.get("style") != force["style"]:
                        D["style"] = force["style"]
                        D["text"] = (lambda D: (lambda bug=None: d_upto(rng, D["ent"], D["N"], D["w"], D["style"], bug)))(D)
                    T = Traj("vhdl_fix", {"kind": kind, "bug": bug})
                    T.start(D["users"][0])
                    if bug == "samename":
                        bad = {"vhdl": D["text"]().replace(D["ent"], D["sheet"]), "sheet": D["sheet"]}
                    else:
                        bad = {"vhdl": D["text"](bug), "sheet": D["sheet"]}
                    (okb, _, bc), = T.turn([("vhdl_block", bad)], weight=0)
                    if okb:
                        raise RuntimeError(f"the app took the {bug} mistake")
                    res, cres, sres = run_good(T, D)
                    T.final("\n".join([built_line(D["sheet"], D["ent"], res),
                                       f"- รอบแรกโปรแกรมไม่รับโค้ด: {bc.split(chr(10))[0].replace('ERROR: ', '').replace('VHDL: ', '')}",
                                       f"- แก้แล้ว: {why}",
                                       "- " + check_line(cres), D["says"](sres)]))
                    yield_rows(T.rows(D["users"][:2]))
                except Exception as e:
                    print("  vhdl_fix fail", kind, bug, e)

    SEM = [("upto", "wrap", "ตัวนับวนกลับ 0 หลังถึงค่าสุดท้าย แทนที่จะหยุดค้าง"),
           ("rom", "row", "ตารางมีค่าผิดหนึ่งช่อง"),
           ("traffic", "len", "ไฟเหลืองค้างนานเกินที่ขอไป 1 clock"),
           ("arith", "swap", "ผลออกมาผิดทาง (เงื่อนไขเทียบกลับด้าน / ไม่ได้กันผลติดลบ)"),
           ("updown", "off1", "นับเกินค่าสูงสุดไป 1 ค่าก่อนวนกลับ")]

    def gen_vhdl_sem():
        for _ in range(3):
            for kind, bug, why in SEM:
                try:
                    fresh_project("vhsem")
                    D = make(kind)
                    T = Traj("vhdl_sem", {"kind": kind, "bug": bug})
                    T.start(D["users"][0])
                    (okb, _, bc), = T.turn([("vhdl_block", {"vhdl": D["text"](bug), "sheet": D["sheet"]})], weight=0)
                    if not okb:
                        raise RuntimeError("the wrong-but-compiling text was refused: " + bc[:200])
                    (okc, _, _), (oks, sres0, sc0) = T.turn([("check", {"sheet": D["sheet"]}), ("simulate", D["sim"])])
                    if D["ok"](sres0):
                        raise RuntimeError("the bug did not show in the simulation")
                    res, cres, sres = run_good(T, D, replace=True)
                    T.final("\n".join([built_line(D["sheet"], D["ent"], res),
                                       f"- จำลองรอบแรกพบว่า{why} จึงแก้โค้ดแล้วสร้างใหม่บนแผ่นเดิม",
                                       "- " + check_line(cres), D["says"](sres)]))
                    yield_rows(T.rows(D["users"][:2]))
                except Exception as e:
                    print("  vhdl_sem fail", kind, bug, e)

    return {"vhdl": gen_vhdl, "vhdl_fix": gen_vhdl_fix, "vhdl_sem": gen_vhdl_sem}
