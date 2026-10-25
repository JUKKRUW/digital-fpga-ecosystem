// From the exam-room request: parts use the component list's COMPM / DECODER instead of drawing their own,
// the one-hot ring (0001 → 0010 → 0100 → 1000), and circuits for the ASCII table and the note chart.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("pwm, the BCD compare and the 7-seg scan use COMPM / DECODER; the ring counter walks one 1", async ({ page }) => {
  test.setTimeout(180000);
  await openEditor(page);
  const r = await page.evaluate(() => {
    const types = k => { const s = Object.values(state.project.schematics).find(x => x.name === k); return s ? s.components.map(c => c.type) : []; };
    const out = {}, bad = [];
    const B = (k, a) => { try { const x = MCP_OPS.build_part(Object.assign({ kind: k }, a)); if (!x.verified.pass) bad.push(k); return x.sheet; } catch (e) { bad.push(k + " " + JSON.stringify(a) + ": " + e.message); return null; } };
    for (const n of [2, 3, 4, 6, 8]) { const s = B("pwm", { n }); out["pwm" + n] = types(s).filter(t => t === "COMPM").length; }
    out.pwmSub = Object.values(state.project.schematics).some(s => /^comparator/.test(s.name));
    out.bcd = types(B("bcd2_compare")).filter(t => t === "COMPM").length;
    out.seg = types(B("seg7_mux4", { hex: true, dp: true })).filter(t => t === "DEC").length;     // its self-loop wire survives routing
    for (const how of ["shift", "decoder"]) for (const n of [4, 8, 16]) for (const down of [false, true]) B("ring_counter", { n, how, down, en: n === 4, clr: n === 8 });
    B("ring_counter", { n: 2 }); B("ring_counter", { n: 5, down: true });
    let refused = ""; try { MCP_OPS.build_part({ kind: "ring_counter", n: 5, how: "decoder" }); } catch (e) { refused = e.message; }
    // what the ring shows, clock by clock, from power-up (all 0) on the shift version
    const shown = B("ring_counter", { n: 4, sheet: "ring_show" }), s = Object.values(state.project.schematics).find(x => x.name === shown);
    const j = clientSeqSim(s, 6, {}), o = j.sequence.outputs;
    const q = j.sequence.rows.map(row => { const v = row[4] || row[3]; return [3, 2, 1, 0].map(i => v[o.indexOf("q" + i)]).join(""); });
    return { out, bad, refused, q };
  });
  expect(r.bad).toEqual([]);
  expect(r.out).toEqual({ pwm2: 1, pwm3: 1, pwm4: 1, pwm6: 2, pwm8: 2, pwmSub: false, bcd: 2, seg: 1 });
  expect(r.refused).toContain("4, 8 or 16");
  expect(r.q.slice(0, 6)).toEqual(["0000", "0001", "0010", "0100", "1000", "0001"]);
  expect(page.errors).toEqual([]);
});

test("ASCII parts on every row; music and ASCII VHDL blocks catch a wrong table; the two library categories", async ({ page }) => {
  test.setTimeout(180000);
  await openEditor(page);
  const r = await page.evaluate(() => {
    const bad = [];
    [["ascii_case", { mode: "upper" }], ["ascii_case", { mode: "lower" }], ["ascii_case", { mode: "swap" }], ["hex_ascii", {}], ["hex_ascii", { lower: true }],
     ["ascii_value", {}], ["ascii_value", { hex: false }], ["note_divider", {}], ["note_divider", { note: "C#", octave: 0 }]].forEach(([k, a]) => {
      try { const x = MCP_OPS.build_part(Object.assign({ kind: k }, a)); if (!x.verified.pass) bad.push(k); } catch (e) { bad.push(k + ": " + e.message); } });
    const caught = (k, a, from, to) => { const keep = VLIB[k].vhdl; VLIB[k].vhdl = (p, E) => keep(p, E).replace(from, to);
      try { vlBuild(k, Object.assign({ name: k + "_bad" }, a)); return "not caught"; } catch (e) { return e.message; } finally { VLIB[k].vhdl = keep; } };
    // key 2 (E) playing key 3's note; a wrong letter in the UART text; the melody that never moves on
    return { bad,
      piano: caught("piano", {}, "lim <= unsigned(HALF(2));", "lim <= unsigned(HALF(3));"),
      uart: caught("uart_text", { text: "HI" }, /"01001001"/, '"01001010"'),
      melody: caught("melody", {}, "idx <= idx + 1;", "idx <= idx;"),
      plan: PARTS.note_divider.plan(partParams("note_divider", { note: "A", octave: 4 })),
      chord: noteFreq(4, 9).toFixed(2) + " " + noteFreq(0, 0).toFixed(2) + " " + noteFreq(8, 11).toFixed(2),
      parse: (() => { try { songNotes({ song: "C4 H4" }); return "ok"; } catch (e) { return e.message; } })() };
  });
  expect(r.bad).toEqual([]);
  expect(r.piano).toContain("ตรวจไม่ผ่าน");
  expect(r.uart).toContain("ตรวจไม่ผ่าน");
  expect(r.melody).toContain("ตรวจไม่ผ่าน");
  expect(r.plan).toContain("÷113,636");
  expect(r.chord).toBe("440.00 16.35 7902.13");                 // the chart's A4, C0, B8
  expect(r.parse).toContain("H4");
  await page.evaluate(() => openLibrary("music"));
  await expect(page.locator('.lib-card[data-libvl="melody"]')).toBeVisible();
  await expect(page.locator('.lib-card[data-libpart="note_divider"]')).toBeVisible();
  await page.click('.lib-cat[data-libcat="ascii"]');
  await expect(page.locator('.lib-card[data-libvl="lcd_ascii"]')).toBeVisible();
  await expect(page.locator('.lib-card[data-libpart="ascii_case"]')).toBeVisible();
  expect(page.errors).toEqual([]);
});
