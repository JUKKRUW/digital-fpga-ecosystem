// From the user's review: ÷5000 split into ÷5 → ÷10 → ÷10 → ÷10, parts built from their natural blocks, counters with
// async reset / preset, a multiplier; and reordering a block's pins carries the parent sheet's tags and wires along.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("divider chain, blocks, async counters, multiplier: each verified, smaller / split", async ({ page }) => {
  test.setTimeout(180000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const b = (kind, a) => { const r = MCP_OPS.build_part(Object.assign({ kind }, a)); const s = Object.values(state.project.schematics).find(x => x.name === r.sheet);
      const g = s.components.filter(c => !["IN", "OUT", "BUSTAP", "GND", "VCC", "JUNCTION"].includes(c.type));
      return { sheet: r.sheet, ok: sheetVerified(s), gates: g.filter(c => !/^SCH:/.test(c.type)).length,
        blocks: g.filter(c => /^SCH:/.test(c.type)).map(c => state.project.schematics[c.type.slice(4)].name) }; };
    return {
      f: [5000, 50, 24, 97, 50000000].map(n => divFactors(n)),
      d5000: b("divider_chain", { n: 5000 }), d15: b("divider_chain", { n: 15, stages: "3,5" }),
      bad: (() => { try { b("divider_chain", { n: 15, stages: "3,4" }); return "built"; } catch (e) { return e.message; } })(),
      add: b("adder", { n: 4, blocks: true }), sub: b("subtractor", { n: 4, blocks: true }), cmp: b("comparator", { n: 4, blocks: true }),
      addFlat: b("adder", { n: 4 }), mul: b("multiplier", { n: 3, m: 3 }),
      cSync: b("counter_digit", { m: 10 }), cAsync: b("counter_digit", { m: 10, async: true }), cDown: b("counter_digit", { m: 6, down: true, async: true, load: true }),
      multi: b("bcd_counter_multi", { format: "00-59", async: true }),
    };
  });
  expect(r.f).toEqual([[5, 10, 10, 10], [5, 10], [4, 6], null, [5, 10, 10, 10, 10, 10, 10, 10]]);
  expect(r.d5000.ok).toBe(true);
  expect(r.d5000.blocks).toEqual(["clock_divider_n5", "clock_divider_n10", "clock_divider_n10", "clock_divider_n10"]);
  expect(r.d15.blocks.length).toBe(2);
  expect(r.bad).toContain("not 15");
  expect(r.add.ok && r.sub.ok && r.cmp.ok && r.mul.ok).toBe(true);
  expect(r.add.blocks).toEqual(["full_adder", "full_adder", "full_adder", "full_adder"]);
  expect(r.sub.blocks.length).toBe(4);
  expect(r.cmp.blocks).toEqual(["cmp_slice", "cmp_slice", "cmp_slice", "cmp_slice"]);
  expect(r.addFlat.blocks).toEqual([]);                                   // over MCP the default stays flat (what the agent learnt)
  expect(r.cSync.ok && r.cAsync.ok && r.cDown.ok && r.multi.ok).toBe(true);
  expect(r.cAsync.gates).toBeLessThan(r.cSync.gates * 0.75);              // fewer gates with the flip-flops' async reset
  expect(page.errors).toEqual([]);
});

test("a counter that resets itself asynchronously: the stepped and the real-time simulators agree", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    MCP_OPS.build_part({ kind: "counter_digit", sheet: "c10", params: { m: 10, async: true } });
    const sch = activeSch(), en = sch.components.find(c => c.type === "IN" && c.params.name === "en"), N = 40;
    const js = clientSeqSim(sch, N, { hold: { [en.id]: 1 } }), outs = js.sequence.outputs;
    const q = row => outs.reduce((v, n, k) => /^q\d$/.test(n) ? v | (row[3][k] << +n.slice(1)) : v, 0);
    const seq = js.sequence.rows.map(q);
    const s = rtCompile(sch); s.setIn(s.ins.find(x => x.name === "en"), 1);
    const rt = []; for (let i = 0; i < N; i++) { rt.push(outs.reduce((v, n) => /^q\d$/.test(n) ? v | ((s.out(s.outs.find(o => o.name === n)) ? 1 : 0) << +n.slice(1)) : v, 0)); s.run(1); }
    return { seq: seq.slice(0, 22), same: JSON.stringify(seq) === JSON.stringify(rt), rt: rt.slice(0, 22) };
  });
  expect(r.seq).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1]);
  expect(r.rt).toEqual(r.seq);
  expect(page.errors).toEqual([]);
});

test("reordering a block's pins moves the tags on its pins and re-routes only those wires", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    MCP_OPS.build_part({ kind: "bcd_7seg", sheet: "seg" });
    MCP_OPS.build_hierarchy({ sheet: "top", replace: true, blocks: [{ name: "u", sheet: "seg" }], inputs: ["d0", "d1", "d2", "d3"], outputs: ["a", "b", "c", "d", "e", "f", "g"],
      connect: [["d0", "u.b0"], ["d1", "u.b1"], ["d2", "u.b2"], ["d3", "u.b3"]] });
    const top = Object.values(state.project.schematics).find(s => s.name === "top"), blk = top.components.find(c => /^SCH:/.test(c.type));
    const tagY = () => Object.fromEntries(top.components.filter(c => c.type === "OUT").map(c => [c.params.name, c.y]));
    const before = tagY(), eWires = JSON.stringify(top.wires.filter(w => w.to.cid === top.components.find(c => c.type === "OUT" && c.params.name === "e").id));
    reorderSubPins(blk, "out", ["b", "c", "a", "d", "e", "f", "g"]);
    const after = tagY(), order = Object.entries(after).sort((x, y) => x[1] - y[1]).map(x => x[0]);
    return { order, eSame: eWires === JSON.stringify(top.wires.filter(w => w.to.cid === top.components.find(c => c.type === "OUT" && c.params.name === "e").id)),
      dSame: before.d === after.d, cross: wirePinCrossings(top).length };
  });
  expect(r.order.slice(0, 3)).toEqual(["b", "c", "a"]);                    // the tags follow the new pin order
  expect(r.dSame).toBe(true);                                             // pins that kept their place keep their tag…
  expect(r.eSame).toBe(true);                                             // …and their wires
  expect(r.cross).toBe(0);
  expect(page.errors).toEqual([]);
});
