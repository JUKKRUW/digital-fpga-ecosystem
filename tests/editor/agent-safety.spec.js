// From a user report: the format fixer (aiagStructuredCall) ran on the closing summary ("clk → div5 …")
// and rebuilt the top sheet; probe bit ranges; the final answer checked against the tool results.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("a closing summary is not a plan; a written call never rebuilds a sheet the run did not make", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ sheet: "top", formula: "y = a & b", replace: true });
    const run = { made: new Set(), steps: [] };
    const a1 = { blocks: [{ name: "u", part: "half_adder" }], replace: true };
    const noSheet = aiagStructuredUnsafe(run, "build_hierarchy", a1);
    const a2 = { sheet: "top", blocks: [], replace: true }; aiagStructuredUnsafe(run, "build_hierarchy", a2);
    const top = Object.values(state.project.schematics).find(s => s.name === "top");
    run.made.add(top.id); const a3 = { sheet: "top", replace: true }; aiagStructuredUnsafe(run, "build_hierarchy", a3);
    return { summary: aiagPlanAhead("ต่อสายครบแล้ว: clk_in → div5.clk_in → div10 ตรวจผ่าน"),
      ahead: aiagPlanAhead("ขั้นต่อไปจะต่อ div5.clk_out -> div10.clk_in"),
      noSheet, keptReplace: "replace" in a2, ownReplace: a3.replace, del: aiagStructuredUnsafe(run, "delete_sheet", {}) };
  });
  expect(r.summary).toBe(false);
  expect(r.ahead).toBe(true);
  expect(r.noSheet).toMatch(/no sheet/);
  expect(r.keptReplace).toBe(false);
  expect(r.ownReplace).toBe(true);
  expect(r.del).toBeTruthy();
});

test("probe takes bit ranges of a bus INPUT and of a numbered group", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ sheet: "g", intent: { module: "g", components: [
      ...Array.from({ length: 8 }, (_, i) => ({ id: "s" + i, type: "IN", name: "sw" + i })),
      ...Array.from({ length: 8 }, (_, i) => ({ id: "l" + i, type: "OUT", name: "led" + i })) ],
      nets: Array.from({ length: 8 }, (_, i) => ({ from: "s" + i, to: "l" + i })) } });
    const p = MCP_OPS.probe({ sheet: "g", inputs: { "sw[7:4]": 5, "sw[1]": 1 } }).outputs;
    let err = ""; try { MCP_OPS.probe({ sheet: "g", inputs: { "sw[3:2]": 9 } }); } catch (e) { err = e.message; }
    return { p, err };
  });
  expect([0, 1, 2, 3, 4, 5, 6, 7].map(i => r.p["led" + i])).toEqual([0, 1, 0, 0, 1, 0, 1, 0]);
  expect(r.err).toMatch(/does not fit/);
});

test("numbers and sheets in the final answer must come from the tool results", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    const run = { steps: [{ kind: "tool", tool: "verify_truth_table", result: '{"rows":16,"passed":16}', args: { sheet: "add" } }] };
    return { ok: aiagFactGuard(run, "ตรวจผ่าน 16/16 แถว"), bad: aiagFactGuard(run, "ผ่านครบ 1,000 จาก 1,000 บนแผ่น ghost") };
  });
  expect(r.ok).toBe("ตรวจผ่าน 16/16 แถว");
  expect(r.bad).toMatch(/^⚠.*1,000 จาก 1,000.*แผ่น ghost/s);
});

test("SFT2 report: probe facts in the answer, unchanged re-check, long simulate, no fast path over an existing sheet, locked sheets", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ sheet: "errs", formula: "err = sw0 & sw1 & sw2 & sw3" });
    const pr = MCP_OPS.probe({ sheet: "errs", inputs: { "sw[3:0]": "1111" } });
    const run = { steps: [{ kind: "tool", tool: "probe", ok: true, full: { inputs: pr.inputs, outputs: pr.outputs } }] };
    const wrong = aiagProbeFacts(run, "ไฟ err ไม่ติด (sw0 sw1 sw2 sw3 เป็น 1)");
    const right = aiagProbeFacts({ steps: run.steps }, "ไฟ err ติด");
    const c1 = await srRecheck("check", { sheet: "errs" }, async () => ({ ok: true, result: { errors: 0 } }));
    const c2 = await srRecheck("check", { sheet: "errs" }, async () => ({ ok: true, result: { errors: 0 } }));
    await MCP_OPS.build_part({ kind: "clock_divider", sheet: "d25", params: { n: 25 } });
    const div = Object.values(state.project.schematics).find(s => s.name === "d25");
    const sim = div ? MCP_OPS.simulate({ sheet: "d25" }) : null;
    const fpRun = { steps: [] };
    const fp = await aiagFastPath("แตก errs เป็นตัวหาร 5 สองตัว", fpRun);
    MCP_OPS.lock_sheet({ sheet: "errs" });
    const lockedCall = await aiagCall("build_circuit", { sheet: "errs", formula: "err = sw0", replace: true });
    MCP_OPS.lock_sheet({ sheet: "errs", lock: false });
    return { err: pr.outputs.err, wrong, right, c1: c1.result.unchanged, c2: c2.result.unchanged,
      clocks: sim && sim.clocks, period: sim && Object.values(sim.summary).map(o => o.period), fp, fpNote: fpRun.steps.map(s => s.text).join(),
      locked: lockedCall.error };
  });
  expect(r.err).toBe(1);
  expect(r.wrong).toMatch(/^⚠ คำตอบด้านล่างขัดกับผล probe \(err=1\)/);
  expect(r.right).toMatch(/ไฟ err ติด\n\n— ผลจาก probe ล่าสุด.*sw0=1.*err=1/s);
  expect(r.c1).toBeUndefined();
  expect(r.c2).toMatch(/Nothing on this sheet changed/);
  expect(r.clocks).toBe(256); expect(r.period).toContain(25);
  expect(r.fp).toBeNull();
  expect(r.fpNote).toMatch(/existing sheet 'errs'/);
  expect(r.locked).toMatch(/locked for the agent/);
});

test("v2.7.1 report: questions are read-only, request bits vs probe, no oracle over several sheets, fast path keeps the rest, divider spec, periods", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ sheet: "errchk", formula: "err = sw1 & sw2 & sw3" });
    AIAG.cur = { message: "แผ่น div50 ตอนนี้หารกี่เท่า เช็คให้หน่อย", steps: [] };
    const q = await aiagCall("build_part", { kind: "clock_divider", sheet: "errchk", params: { n: 50 }, replace: true });
    AIAG.cur = { message: "ทำ y = a & b ลงแผ่น main", steps: [] };
    const top = await aiagCall("set_top_sheet", { sheet: "errchk" }).catch(e => ({ ok: false, error: String(e) }));
    // the 2.7.1 test C run: probe given sw=0, answer "ไม่ติด"
    const pr = MCP_OPS.probe({ sheet: "errchk", inputs: { sw: 0 } });
    const run = { message: "ถ้าตั้ง sw0 ถึง sw3 เป็น 1 หมด ที่เหลือเป็น 0 ไฟ err จะติดไหม", steps: [{ kind: "tool", tool: "probe", ok: true, args: { sheet: "errchk" }, full: { inputs: pr.inputs, outputs: pr.outputs } }] };
    const c = aiagFactGuard(run, "ไม่ติดครับ — probe ด้วย sw = 0 ได้ err = 0");
    const ov = aiagOracleAfter({ message: "ทำแผ่น div5 (หาร 5) กับแผ่น div10 แล้วให้แผ่น div50 เอา div5 มาต่อ", steps: [], oracle: oracleDerive("หารความถี่ 5") },
      "build_part", { ok: true, result: { sheet: "errchk" } });
    const errSpec = (Object.values(state.project.schematics).find(s => s.name === "errchk") || {}).specSource || null;
    const fpRun = { steps: [] };
    const keepCall = aiagCall; aiagCall = async (t, a) => ({ ok: true, result: await MCP_OPS[t](a) });   // no launcher here
    const fp = await aiagFastPath("ทำ mux 2:1 ชื่อแผ่น m2 แล้วลองเทสว่าถ้า s=1 d0=0 d1=1 ขาออกเป็นเท่าไร", fpRun);
    aiagCall = keepCall;
    await MCP_OPS.build_part({ kind: "clock_divider", sheet: "d25", params: { n: 25 } });
    const sp = MCP_OPS.set_spec({ sheet: "d25", formula: "clk_out = clk_in / 25" });
    const sim = MCP_OPS.simulate({ sheet: "d25" });
    const per = aiagFactGuard({ message: "div25", steps: [{ kind: "tool", tool: "simulate", ok: true, result: JSON.stringify(sim).slice(0, 2500) }] },
      "จำลองแล้ว clk_out กลับมาขึ้นทุก 50 clock (หาร 50)");
    const qGuard = aiagNoWorkGuard({ steps: [] }, "เพราะ 7-seg เป็น common anode", false, false);
    return { q: q.error, top: top.error, c, ov, errSpec, fp: fp && (fp.final ? "final" : fp.note), spec: sp.result && sp.result.pass, per, qGuard };
  });
  expect(r.q).toMatch(/only ASKED a question/);
  expect(r.top).toMatch(/does not ask to change the top/);
  expect(r.c).toMatch(/^⚠ probe ไม่ได้ป้อนค่าตามคำขอ.*sw1 ควรเป็น 1.*err=1/s);
  expect(r.ov).toBeNull();
  expect(r.errSpec).toBeNull();
  expect(r.fp).toMatch(/do the REST of the request/);
  expect(r.spec).toBe(true);
  expect(r.per).toMatch(/^⚠ คำตอบบอก .*ทุก 50 clock.*คาบ 25/s);
  expect(r.qGuard).toBe("เพราะ 7-seg เป็น common anode");
});

test("probe: a bit range over a missing switch names the missing bit", async ({ page }) => {
  await openEditor(page);
  const msg = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ sheet: "sp", formula: "err = sw1 & sw2 & sw3 & ~sw5" });
    try { MCP_OPS.probe({ sheet: "sp", inputs: { "sw[5:2]": "1111" } }); return "no error"; } catch (e) { return e.message; }
  });
  expect(msg).toMatch(/no INPUT sw4/);
});
