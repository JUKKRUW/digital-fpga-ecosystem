#!/usr/bin/env python3
"""Category: lab-exam style tasks (held out — eval split only).

  python3 tools/dataset/gen_exam.py > tasks_exam.jsonl

The kinds of circuits the course's lab exams and practice sets ask for — running LEDs, counters
through a list of values (primes, step 3, Fibonacci, squares, counting down), PWM, letters on the
7-segment, a text scrolling over the 4 digits of the EDGE board, two's complement → sign and
magnitude, "2x + 8", "is a power of two" — written as Thai exam requests that name every port and
how the circuit starts. The answer each check uses is computed HERE by small reference models
(not by the app's part library), so a run is checked independently of the code that may build it:

  check.kind "seq":  a clock-by-clock stream (inputs per clock → expected outputs per clock, as
                     numbers; a bus port or numbered 1-bit ports both read as one number)
  check.kind "comb": every input row → expected outputs

Clock convention (as gen_fsm.py, measured on the app's simulator): the outputs of clock i are the
state reached after i clock edges from the all-zero start, with the inputs of clock i applied.
"""
import argparse
import json
import random

# the course's 7-segment patterns (SSD 0-9 / SSD A-Z reference sheets), active-high, segments a..g
DIGITS = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg"]
LETTERS = ["abcefg", "cdefg", "adef", "bcdeg", "adefg", "aefg", "abcdfg", "bcefg", "bc", "bcd", "efg", "def", "ace",
           "abcef", "abcdef", "abefg", "abcfg", "aef", "acdfg", "defg", "bcdef", "cde", "bdf", "bcg", "bcdfg", "abdeg"]


def seg_of(ch):
    if ch.isdigit():
        return DIGITS[int(ch)]
    if "A" <= ch.upper() <= "Z":
        return LETTERS[ord(ch.upper()) - 65]
    return {" ": "", "-": "g", "_": "d"}[ch]


def segs(on, active_low):
    return {s: (0 if s in on else 1) if active_low else (1 if s in on else 0) for s in "abcdefg"}


def primes(n):
    return [x for x in range(2, n + 1) if all(x % d for d in range(2, int(x ** 0.5) + 1))]


def run_list(values, cycles, en=None, clr=None):
    """outputs of a counter through `values` (index 0 at start), with optional en / clr streams"""
    out, s = [], 0
    for i in range(cycles):
        out.append(values[s])
        if clr and clr[i]:
            s = 0
        elif en is None or en[i]:
            s = (s + 1) % len(values)
    return out


def stream_task(tid, msg, sheet, ports, inputs, expect, part):
    return {"id": tid, "cat": "nl_exam", "split": "eval", "message": msg, "use_sheet": sheet, "sheet": sheet,
            "check": {"kind": "seq", "ports": ports, "inputs": inputs, "expect": expect}, "part_hint": part}


def comb_task(tid, msg, sheet, ports, rows, part):
    return {"id": tid, "cat": "nl_exam", "split": "eval", "message": msg, "use_sheet": sheet, "sheet": sheet,
            "check": {"kind": "comb", "ports": ports, "rows": rows}, "part_hint": part}


def tasks(rng):
    T = []
    k = iter(range(1, 1000))
    nid = lambda: f"exam-eval-{next(k):03d}"
    N = 40

    # ---- running LEDs ----
    def leds(mode, n):
        if mode == "ring":
            return [1 << i for i in range(n)]
        if mode == "bounce":
            return [1 << i for i in range(n)] + [1 << i for i in range(n - 2, 0, -1)]
        if mode == "johnson":
            return [(1 << i) - 1 for i in range(n + 1)] + [((1 << n) - 1) & ~((1 << i) - 1) for i in range(1, n)]
        return [(1 << i) - 1 for i in range(n + 1)]
    T.append(stream_task(nid(), "ทำไฟวิ่ง LED 8 ดวง ออกที่ led7..led0: ติดทีละดวงเริ่มจาก led0 แล้วเลื่อนไปทาง led7 ทุก clock พอถึง led7 ก็วนกลับมา led0 อินพุตมีแค่ clk ทำในแผ่น run8",
                         "run8", {"in": {"clk": 1}, "out": {"led": 8}}, [{}] * N, {"led": run_list(leds("ring", 8), N)}, {"kind": "led_pattern", "n": 8, "mode": "ring"}))
    T.append(stream_task(nid(), "โจทย์สอบ: ไฟวิ่งไปกลับ (knight rider) 6 ดวง led0..led5 เริ่มที่ led0 วิ่งไปจนสุด led5 แล้ววิ่งกลับ ดวงปลายไม่ติดซ้ำสองครั้ง เปลี่ยนทุก clock (ขา clk) ลงแผ่น kr6",
                         "kr6", {"in": {"clk": 1}, "out": {"led": 6}}, [{}] * N, {"led": run_list(leds("bounce", 6), N)}, {"kind": "led_pattern", "n": 6, "mode": "bounce"}))
    en = [rng.choice([0, 1, 1]) for _ in range(N)]
    T.append(stream_task(nid(), "ทำ Johnson counter 4 บิตเป็นไฟ LED (led3..led0) เริ่มดับหมด ไฟติดเพิ่มจาก led0 ทีละดวงจนครบ แล้วดับจาก led0 ทีละดวง เดินเฉพาะตอน en = 1 (ไม่งั้นค้าง) อินพุต clk, en แผ่น jc4",
                         "jc4", {"in": {"clk": 1, "en": 1}, "out": {"led": 4}}, [{"en": e} for e in en], {"led": run_list(leds("johnson", 4), N, en=en)}, {"kind": "led_pattern", "n": 4, "mode": "johnson", "en": True}))
    T.append(stream_task(nid(), "ไฟแถบ (bar graph) 5 ดวง led4..led0: เริ่มดับหมด แต่ละ clock ติดเพิ่ม 1 ดวงจาก led0 พอครบ 5 ดวงแล้ว clock ถัดไปดับหมดเริ่มใหม่ อินพุต clk ลงแผ่น bar5",
                         "bar5", {"in": {"clk": 1}, "out": {"led": 5}}, [{}] * N, {"led": run_list(leds("fill", 5), N)}, {"kind": "led_pattern", "n": 5, "mode": "fill"}))
    clr = [1 if i in (9, 27) else 0 for i in range(N)]
    T.append(stream_task(nid(), "ไฟวิ่ง 4 ดวง (led[3:0]) ติดทีละดวงจาก led0 ไป led3 วนไปเรื่อยๆ มีปุ่ม clr (synchronous) กดแล้วกลับไปที่ led0 อินพุต clk, clr แผ่น ring4c",
                         "ring4c", {"in": {"clk": 1, "clr": 1}, "out": {"led": 4}}, [{"clr": c} for c in clr], {"led": run_list(leds("ring", 4), N, clr=clr)}, {"kind": "led_pattern", "n": 4, "mode": "ring", "clr": True}))

    # ---- counters through a list ----
    P = primes(31)
    T.append(stream_task(nid(), f"สร้างตัวนับที่นับเฉพาะจำนวนเฉพาะ 2, 3, 5, 7 ไปจนถึง 31 แล้ววนกลับไป 2 ออกเป็นเลขฐานสองที่ q (q4..q0) เปลี่ยนทุก clock เริ่มที่ 2 ลงแผ่น prime",
                         "prime", {"in": {"clk": 1}, "out": {"q": 5}}, [{}] * N, {"q": run_list(P, N)}, {"kind": "seq_counter", "values": ",".join(map(str, P))}))
    V = list(range(0, 100, 3))
    clr = [1 if i in (13, 31) else 0 for i in range(N)]
    T.append(stream_task(nid(), "ตัวนับ 0 ถึง 99 นับเพิ่มทีละ 3 (0, 3, 6, …, 99 แล้วกลับ 0) ออกที่ q[6:0] มีขา clr ล้างกลับเป็น 0 ตอน clock ถัดไป อินพุต clk, clr แผ่น step3",
                         "step3", {"in": {"clk": 1, "clr": 1}, "out": {"q": 7}}, [{"clr": c} for c in clr], {"q": run_list(V, N, clr=clr)}, {"kind": "seq_counter", "values": "0..99 step 3", "clr": True}))
    F = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
    T.append(stream_task(nid(), "ตัวนับลำดับฟีโบนัชชี 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89 แล้ววนกลับไปเริ่ม 1 ใหม่ ออกที่ q (7 บิต) ทุก clock (clk) ลงแผ่น fib",
                         "fib", {"in": {"clk": 1}, "out": {"q": 7}}, [{}] * N, {"q": run_list(F, N)}, {"kind": "seq_counter", "values": ",".join(map(str, F))}))
    S = [x * x for x in range(1, 8)]
    en = [rng.choice([0, 1, 1]) for _ in range(N)]
    T.append(stream_task(nid(), "ทำตัวนับเลขยกกำลังสอง 1, 4, 9, 16, 25, 36, 49 แล้ววน นับเฉพาะตอน en = 1 ออกที่ q[5:0] อินพุต clk กับ en แผ่น sq",
                         "sq", {"in": {"clk": 1, "en": 1}, "out": {"q": 6}}, [{"en": e} for e in en], {"q": run_list(S, N, en=en)}, {"kind": "seq_counter", "values": ",".join(map(str, S)), "en": True}))
    D = list(range(30, -1, -3))
    T.append(stream_task(nid(), "นับถอยหลังจาก 30 ลงทีละ 3 จนถึง 0 แล้วกลับไป 30 ใหม่ ออกเป็น q4..q0 ทุก clock (clk) แผ่น down3",
                         "down3", {"in": {"clk": 1}, "out": {"q": 5}}, [{}] * N, {"q": run_list(D, N)}, {"kind": "seq_counter", "values": "30..0 step 3"}))
    V = list(range(61))
    T.append(stream_task(nid(), "ตัวนับ 0–60 (61 ค่า แล้ววนกลับ 0) ออก q[5:0] เพิ่มขึ้นทุก clock ขา clk แผ่น c60",
                         "c60", {"in": {"clk": 1}, "out": {"q": 6}}, [{}] * 130, {"q": run_list(V, 130)}, {"kind": "seq_counter", "values": "0..60"}))

    # ---- PWM ----
    for n, sheet in ((4, "pwm4"), (3, "pwm3")):
        M = 1 << n
        duty = [3, M - 1, 0, M // 2, 1]
        ins = [{"duty": duty[(i // (M + 2)) % len(duty)]} for i in range(5 * (M + 2))]
        out, c = [], 0
        for v in ins:
            out.append(1 if c < v["duty"] else 0)
            c = (c + 1) % M
        T.append(stream_task(nid(), f"ทำวงจร PWM {n} บิต: ตัวนับภายในนับ 0 … {M - 1} วนทุก clock (เริ่ม 0) ให้ pwm = 1 เมื่อค่าตัวนับน้อยกว่า duty (อินพุต {n} บิต duty[{n - 1}:0]) อินพุต clk ลงแผ่น {sheet}",
                             sheet, {"in": {"clk": 1, "duty": n}, "out": {"pwm": 1}}, ins, {"pwm": out}, {"kind": "pwm", "n": n}))

    # ---- text on the 4-digit display ----
    def scroll(text, steps):
        t = text + " " * max(0, 4 - len(text))
        L, pos, s, o = len(t), 0, 0, {x: [] for x in "abcdefg"}
        o["an"] = []
        for st in steps:
            on = seg_of(t[(pos + 3 - s) % L])
            for x in "abcdefg":
                o[x].append(0 if x in on else 1)
            o["an"].append(~(1 << s) & 15)
            pos = (pos + st) % L
            s = (s + 1) % 4
        return o
    steps = [1 if i % 4 == 3 and i % 12 != 7 else 0 for i in range(60)]
    T.append(stream_task(nid(), "โจทย์สอบ: ทำข้อความ HELLO วิ่งบนจอ 7-segment 4 หลักของบอร์ด EDGE (a..g, an3..an0 active-low, an3 = หลักซ้ายสุด) ตัวที่ 1 ของข้อความเริ่มที่หลักซ้ายสุด แต่ละ clock สแกนไปหลักถัดไปทางซ้าย an0 → an1 → an2 → an3 (เริ่มที่ an0) ข้อความเลื่อนไปทางซ้าย 1 ตัวเมื่อ step = 1 ระหว่างตัวท้ายกับตัวแรกมีช่องว่าง 1 ช่อง ('HELLO ') อินพุต clk, step แผ่น hello",
                         "hello", {"in": {"clk": 1, "step": 1}, "out": dict({x: 1 for x in "abcdefg"}, an=4)}, [{"step": x} for x in steps], scroll("HELLO ", steps), {"kind": "text_scroll", "text": "HELLO "}))
    steps = [0] * 24
    T.append(stream_task(nid(), "แสดงรหัสนักศึกษา 4 ตัวท้าย 0042 นิ่งๆ บนจอ 7-seg 4 หลัก (a..g, an[3:0] active-low แบบบอร์ด EDGE, an3 ซ้ายสุดแสดง 0 ตัวแรก) สแกนทุก clock เริ่ม an0 แล้ว an1, an2, an3 อินพุต clk และ step (ต่อ 0 ไว้ = ไม่เลื่อน) แผ่น sid",
                         "sid", {"in": {"clk": 1, "step": 1}, "out": dict({x: 1 for x in "abcdefg"}, an=4)}, [{"step": 0}] * 24, scroll("0042", steps), {"kind": "text_scroll", "text": "0042"}))

    # ---- combinational ----
    rows = []
    for c in range(64):
        ch = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[c] if c < 36 else " "
        rows.append([{"code": c}, segs(seg_of(ch), True)])
    T.append(comb_task(nid(), "ออกแบบวงจรถอดรหัส code 6 บิต (code5..code0) ไปเป็น 7-segment active-low a..g: code 0–9 แสดงตัวเลข 0–9, code 10–35 แสดงตัวอักษร A–Z ตามตารางตัวอักษรของวิชา, code 36–63 ไม่แสดงอะไร แผ่น ssd_az",
                       "ssd_az", {"in": {"code": 6}, "out": {x: 1 for x in "abcdefg"}}, rows, {"kind": "char_7seg"}))
    rows = []
    for c in range(32):
        rows.append([{"code": c}, segs(seg_of(chr(65 + c)) if c < 26 else "", False)])
    T.append(comb_task(nid(), "ตัวถอดรหัสตัวอักษร A–Z ล้วน (ไม่มีตัวเลข): code[4:0] 0 = A … 25 = Z, 26–31 = ว่าง ออก a..g แบบ active-high ตามตาราง SSD A-Z ของวิชา ลงแผ่น letters",
                       "letters", {"in": {"code": 5}, "out": {x: 1 for x in "abcdefg"}}, rows, {"kind": "char_7seg", "set": "a-z", "active_low": False}))
    rows = [[{"x": x}, {"neg": x >> 7, "mag": (256 - x) & 255 if x >> 7 else x}] for x in range(256)]
    T.append(comb_task(nid(), "แปลงเลข two's complement 8 บิต x[7:0] เป็นเครื่องหมายกับขนาด: neg = 1 เมื่อ x ติดลบ, mag[7:0] = ค่าสัมบูรณ์ของ x (เช่น x = -5 → neg 1, mag 5; x = -128 → mag 128) แผ่น tcd8",
                       "tcd8", {"in": {"x": 8}, "out": {"mag": 8, "neg": 1}}, rows, {"kind": "tc_decode", "n": 8}))
    rows = [[{"x": x}, {"y": 2 * x + 8}] for x in range(16)]
    T.append(comb_task(nid(), "โจทย์ฝึก: รับ x 4 บิต (x3..x0) คำนวณ y = 2x + 8 ออกเป็นเลขฐานสอง y[5:0] ลงแผ่น twoxp8",
                       "twoxp8", {"in": {"x": 4}, "out": {"y": 6}}, rows, None))
    rows = [[{"x": x}, {"y": 1 if x and not (x & (x - 1)) else 0}] for x in range(32)]
    T.append(comb_task(nid(), "ให้ y = 1 เมื่อ x (5 บิต x4..x0) เป็นเลขยกกำลังของสอง (1, 2, 4, 8, 16) นอกนั้น y = 0 แผ่น pow2",
                       "pow2", {"in": {"x": 5}, "out": {"y": 1}}, rows, None))
    rows = [[{"x": x}, {"y": x % 3 == 0 and 1 or 0}] for x in range(16)]
    T.append(comb_task(nid(), "วงจรตรวจว่า x 4 บิต (x[3:0]) หารด้วย 3 ลงตัวไหม (0 ถือว่าลงตัว) ถ้าลงตัว y = 1 แผ่น div3",
                       "div3", {"in": {"x": 4}, "out": {"y": 1}}, rows, None))
    return T


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    for t in tasks(random.Random(a.seed)):
        print(json.dumps(t, ensure_ascii=False))


if __name__ == "__main__":
    main()
