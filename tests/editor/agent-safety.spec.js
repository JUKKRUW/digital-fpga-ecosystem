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
