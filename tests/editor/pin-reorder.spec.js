// Reordering a module symbol must leave its internal drawing and connectivity intact.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("reordering generated module inputs and outputs preserves the internal drawing and behaviour", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ name: "dcomb", formula: "d3 = a & b; d2 = a | b; d1 = a ^ b; d0 = ~a" });
    const sub = Object.values(state.project.schematics).find(s => s.name === "dcomb");
    sub.portOrder = { in: ["a", "b"], out: ["d3", "d2", "d1", "d0"] }; sub.locked = true;
    await MCP_OPS.build_hierarchy({ sheet: "top2", inputs: ["a", "b"], outputs: ["y"], blocks: [{ name: "u", part: "dcomb" }], connect: "u.d0 -> y" });
    const top = Object.values(state.project.schematics).find(s => s.name === "top2");
    const blk = top.components.find(c => c.type === "SCH:" + sub.id);
    const copy = x => JSON.parse(JSON.stringify(x));
    const original = copy(sub), originalTopNets = ffsNetSig(top);
    const ids = schPortList(sub).map(p => [p.cid, p.id]).sort();
    const simulate = () => { const flat = flattenSchematic(top).sch, struct = probeStruct(flat);
      return [0, 1, 2, 3].map(n => mcpEvalOuts(top, flat, struct, { a: n & 1, b: n >> 1 })); };
    const simBefore = simulate();
    const outs = () => schPortList(sub).filter(p => p.dir === "out").map(p => p.name);
    const before = outs();
    const ok = reorderSubPins(blk, "out", ["d0", "d3", "d2", "d1"]);
    const inputsOk = reorderSubPins(blk, "in", ["b", "a"]);
    const after = copy(sub); delete after.symbolPinOrder;
    return { before, ok, inputsOk, after: outs(), inputs: schPortList(sub).filter(p => p.dir === "in").map(p => p.id),
      original, drawing: after, originalTopNets, topNets: ffsNetSig(top),
      ids, afterIds: schPortList(sub).map(p => [p.cid, p.id]).sort(),
      equivalent: eqSheets(sub, original).equivalent, simBefore, simAfter: simulate() };
  });
  expect(r.before).toEqual(["d3", "d2", "d1", "d0"]);
  expect(r.ok).toBe(true);
  expect(r.after).toEqual(["d0", "d3", "d2", "d1"]);
  expect(r.inputsOk).toBe(true);
  expect(r.inputs).toEqual(["b", "a"]);
  expect(r.drawing).toEqual(r.original);
  expect(r.topNets).toEqual(r.originalTopNets);
  expect(r.afterIds).toEqual(r.ids);
  expect(r.equivalent).toBe(true);
  expect(r.simAfter).toEqual(r.simBefore);
  expect(r.simAfter.map(row => row.y)).toEqual([1, 0, 1, 0]);
  expect(page.errors).toEqual([]);
});

test("hand-drawn and custom module symbols keep stable pin ids, save order and support undo", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    const sub = activeSch(); delete sub.portOrder;
    // Duplicate sanitised names must keep their original cid -> pid association.
    const ins = sub.components.filter(c => c.type === "IN");
    ins.forEach(c => { c.params.name = "same"; c.params.width = 4; });
    renderAll();
    const original = JSON.parse(JSON.stringify(sub));
    const before = schPortList(sub), inOrder = before.filter(p => p.dir === "in").map(p => p.id);
    const block = { type: "SCH:" + sub.id };
    const customId = uid("custom");
    state.project.customs[customId] = { name: "custom", schematic: JSON.parse(JSON.stringify(sub)) };
    const customBlock = { type: "CUSTOM:" + customId };
    snapshot();
    const ok = reorderSubPins(block, "in", inOrder.slice().reverse());
    const saved = JSON.parse(JSON.stringify(state.project));
    const after = schPortList(saved.schematics[sub.id]);
    const internal = JSON.parse(JSON.stringify(sub)); delete internal.symbolPinOrder;
    undo(); const undone = schPortList(state.project.schematics[sub.id]);
    redo(); const redone = schPortList(state.project.schematics[sub.id]);
    const customOk = reorderSubPins(customBlock, "in", inOrder.slice().reverse());
    const custom = subSchOf(customBlock), customPorts = schPortList(custom);
    const customInternal = JSON.parse(JSON.stringify(custom)); delete customInternal.symbolPinOrder;
    const beforeInvalid = JSON.stringify(state.project);
    const rejected = [["in", inOrder.slice().reverse()], ["in", [inOrder[0], inOrder[0]]], ["in", ["missing", inOrder[0]]],
      ["in", [...inOrder.slice().reverse(), "extra"]], ["out", inOrder], ["bad", inOrder], ["in", null]]
      .map(([dir, order]) => reorderSubPins(block, dir, order));
    return { ok, customOk, original, internal, customInternal, before, after, undone, redone, customPorts,
      rejected, unchanged: beforeInvalid === JSON.stringify(state.project) };
  });
  expect(r.ok).toBe(true);
  expect(r.customOk).toBe(true);
  const reversed = [...r.before.filter(p => p.dir === "in").reverse(), ...r.before.filter(p => p.dir === "out")];
  expect(r.after).toEqual(reversed);
  expect(r.customPorts).toEqual(reversed);
  expect(r.undone).toEqual(r.before);
  expect(r.redone).toEqual(reversed);
  expect(r.internal).toEqual(r.original);
  expect(r.customInternal).toEqual(r.original);
  expect(r.rejected).toEqual(Array(7).fill(false));
  expect(r.unchanged).toBe(true);
  expect(page.errors).toEqual([]);
});

test("dragging pins in the Inspector changes the symbol without moving the sub-sheet ports", async ({ page }) => {
  await openEditor(page);
  const original = await page.evaluate(() => {
    const sub = activeSch(), top = blankSchematic(uid("sch"), "parent");
    const block = { id: uid("c"), type: "SCH:" + sub.id, x: 330, y: 220, params: {}, label: "u" };
    top.components.push(block); state.project.schematics[top.id] = top;
    openSchTab(top.id); state.selection = new Set([block.id]); renderAll(); snapshot();
    return { subId: sub.id, sub: JSON.parse(JSON.stringify(sub)), pins: getPorts(block).filter(p => p.dir === "in").map(p => p.id) };
  });
  const chips = page.locator('.pincol[data-dir="in"] .pinchip');
  await chips.nth(1).dragTo(chips.nth(0), { targetPosition: { x: 10, y: 1 } });
  expect(await chips.evaluateAll(nodes => nodes.map(n => n.dataset.pid))).toEqual(original.pins.slice().reverse());
  const r = await page.evaluate(subId => {
    const sub = JSON.parse(JSON.stringify(state.project.schematics[subId])); delete sub.symbolPinOrder;
    return { sub, pins: getPorts(activeSch().components[0]).filter(p => p.dir === "in").map(p => p.id) };
  }, original.subId);
  expect(r.sub).toEqual(original.sub);
  expect(r.pins).toEqual(original.pins.slice().reverse());
  expect(page.errors).toEqual([]);
});
