// The lab-exam parts (54-parts-exam.js): every kind builds and passes its reference check, text
// settings are checked, and a few behave as an exam asks when simulated.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("every lab-exam part builds and passes its reference check", async ({ page }) => {
  test.setTimeout(400000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const cases = [["char_7seg",{}],["char_7seg",{set:"a-z",blank0:true,active_low:false}],
      ["seq_counter",{}],["seq_counter",{values:"0..99 step 3",en:true,clr:true}],["seq_counter",{values:"1,1,2,3,5,8,13,21,34,55,89,144,233"}],["seq_counter",{values:"9..0"}],
      ["led_pattern",{}],["led_pattern",{n:4,mode:"johnson",en:true}],["led_pattern",{n:6,mode:"bounce",clr:true}],["led_pattern",{n:5,mode:"fill"}],
      ["pwm",{}],["pwm",{n:3}],["tc_decode",{n:8}],["tc_decode",{n:3}],
      ["text_scroll",{}],["text_scroll",{text:"65010001"}],["text_scroll",{text:"HI"}]];
    const bad = [], kinds = new Set();
    for (const [k, a] of cases) { kinds.add(k);
      try { const res = MCP_OPS.build_part(Object.assign({ kind: k }, a)); if (!res.verified.pass) bad.push(k); }
      catch (e) { bad.push(k + " " + JSON.stringify(a) + ": " + e.message); } }
    const refused = [];
    for (const a of [{kind:"seq_counter", values:"2,x,5"}, {kind:"seq_counter", values:"300,1"}, {kind:"text_scroll", text:"ก"}])
      try { MCP_OPS.build_part(a); refused.push("built " + JSON.stringify(a)); } catch (e) { refused.push(e.message); }
    return { bad, missing: PARTS_EXAM.filter(k => !kinds.has(k)), refused };
  });
  expect(r.bad).toEqual([]);
  expect(r.missing).toEqual([]);
  expect(r.refused[0]).toMatch(/cannot read "x"/);
  expect(r.refused[1]).toMatch(/0\.\.255/);
  expect(r.refused[2]).toMatch(/no 7-segment pattern/);
});

test("the course's letters, primes in order, and PWM duty", async ({ page }) => {
  test.setTimeout(200000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    MCP_OPS.build_part({ kind: "char_7seg", active_low: false, bus: true, sheet: "ch" });
    const codes = [10, 17, 21, 35, 7, 40];                         // A H L Z 7 blank
    const s = MCP_OPS.simulate({ sheet: "ch", vectors: codes.map(c => ({ code: c })) });
    const segs = s.rows.map(x => [..."abcdefg"].filter(k => String(x.outputs[k]) === "1").join(""));
    MCP_OPS.build_part({ kind: "seq_counter", values: "2,3,5,7,11,13", bus: true, sheet: "pr" });
    const q = MCP_OPS.simulate({ sheet: "pr", cycles: 8 });
    MCP_OPS.build_part({ kind: "pwm", n: 3, bus: true, sheet: "pw" });
    const p = MCP_OPS.simulate({ sheet: "pw", cycles: 16, inputs: { duty: 3 } });
    return { segs, q: q.rows.map(x => parseInt(x.outputs.q, 2)), p: p.rows.map(x => +x.outputs) };
  });
  expect(r.segs).toEqual(["abcefg", "bcefg", "def", "abdeg", "abc", ""]);
  expect(r.q).toEqual([2, 3, 5, 7, 11, 13, 2, 3]);
  expect(r.p.slice(0, 16)).toEqual([1,1,1,0,0,0,0,0, 1,1,1,0,0,0,0,0]);    // duty 3 of 8
});

test("the agent's fast path names the exam parts from a request", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    const ask = m => { const x = partFromMessage(m); return x ? [x.kind, JSON.stringify(x.args), x.simple] : null; };
    return {
      led: ask("ทำไฟวิ่งไปกลับ 8 ดวง"), ring: ask("running LED 4 bit"),
      pwm: ask("สร้าง PWM 4 บิต"), scroll: ask("ทำข้อความวิ่ง \"HELLO 2024\" บนจอ 7-seg"),
      id: ask("แสดงรหัสนักศึกษา 65010001 บน 7-segment"), az: ask("ถอดรหัสตัวอักษร A-Z ออก 7-segment"),
      prime: ask("ตัวนับจำนวนเฉพาะ 2 ถึง 31"), step: ask("ทำตัวนับ 0 ถึง 99 ทีละ 3 มีปุ่มรีเซ็ต"),
      fib: ask("counter fibonacci up to 100"), list: ask("ตัวนับ 1, 4, 9, 16, 25"),
      plain7: ask("ทำ BCD to 7 segment"), mod: ask("ตัวนับ mod 6"), divider: ask("ไฟวิ่ง 8 ดวง ใช้ตัวหารความถี่จาก 50MHz"),
    };
  });
  expect(r.led).toEqual(["led_pattern", '{"mode":"bounce","n":8}', true]);
  expect(r.ring[0]).toBe("led_pattern");
  expect(r.pwm).toEqual(["pwm", '{"n":4}', true]);
  expect(r.scroll).toEqual(["text_scroll", '{"text":"HELLO 2024"}', true]);
  expect(r.id).toEqual(["text_scroll", '{"text":"65010001"}', true]);
  expect(r.az[0]).toBe("char_7seg");
  expect(r.prime[1]).toBe('{"values":"2,3,5,7,11,13,17,19,23,29,31"}');
  expect(JSON.parse(r.step[1])).toEqual({ values: Array.from({ length: 34 }, (_, i) => 3 * i).join(","), clr: true });
  expect(r.fib[1]).toBe('{"values":"0,1,1,2,3,5,8,13,21,34,55,89"}');
  expect(r.list[1]).toBe('{"values":"1,4,9,16,25"}');
  expect(r.plain7[0]).toBe("bcd_7seg");
  expect(r.mod[0]).toBe("mod_counter");
  expect(r.divider[2]).toBe(false);
});

// tools/dataset/gen_exam.py computes its answers with its own small models: the library parts must
// pass them (two independent derivations agree), and a wrong circuit must not
test("gen_exam.py's exam tasks: the library parts pass the independent checks, a wrong one fails", async ({ page }) => {
  test.setTimeout(400000);
  const { execFileSync } = require("child_process"), path = require("path");
  const tasks = execFileSync("python3", [path.join(__dirname, "..", "..", "tools", "dataset", "gen_exam.py")], { encoding: "utf-8" })
    .split("\n").filter(Boolean).map(l => JSON.parse(l));
  await openEditor(page);
  const r = await page.evaluate(tasks => {
    const check = (t, sheet) => {                      // = run.js checkInPage for nl_exam
      const s = Object.values(state.project.schematics).find(x => x.name === sheet), c = t.check, part = { ports: () => c.ports };
      if (c.kind === "seq") { part.seq = () => ({ cycles: c.inputs.length, init: 0, drive: i => c.inputs[i] || {},
          step: i => ({ out: Object.fromEntries(Object.entries(c.expect).map(([o, L]) => [o, L[i]])), state: i + 1 }) });
        return partVerifySeq(s, part, {}); }
      const key = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]])), M = new Map(c.rows.map(([i, o]) => [key(i), o]));
      part.ref = v => M.get(key(v)) || null; return partVerifyComb(s, part, {}); };
    const out = { bad: [], n: 0 };
    for (const t of tasks.filter(t => t.part_hint)) { out.n++;
      try { MCP_OPS.build_part(Object.assign({}, t.part_hint, { sheet: t.sheet, bus: t.id.length % 2 === 0 }));
        const v = check(t, t.sheet); if (!v.pass) out.bad.push(t.id + " " + JSON.stringify(v.mismatch)); }
      catch (e) { out.bad.push(t.id + ": " + e.message); } }
    const kr = tasks.find(t => t.sheet === "kr6");
    MCP_OPS.build_part({ kind: "led_pattern", n: 6, mode: "ring", sheet: "kr6_wrong" });
    out.wrong = check(kr, "kr6_wrong").pass;
    return out;
  }, tasks);
  expect(r.n).toBeGreaterThan(15);
  expect(r.bad).toEqual([]);
  expect(r.wrong).toBe(false);
});
