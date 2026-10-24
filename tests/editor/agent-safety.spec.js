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
