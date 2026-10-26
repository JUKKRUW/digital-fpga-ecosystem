// "บล็อก VHDL มันชอบเบี้ยวตลอดเลย": custom / VHDL block pins sat 3 px off the 11 px grid, so every wire to one jogged.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("VHDL block pins are on the grid and its wrap sheet's wires are straight; old sheets' corners follow the pin", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    const x = vlBuild("divmod", { n: 6 }), P = state.project.schematics, id = uid("sch");
    P[id] = blankSchematic(id, uniqueSchName("dm_top", id)); const s = P[id]; openSchTab(id);
    const w = vhdlWrapSheet(s, x.name); mcpCommit(s, { routeWires: w.wires });
    const pin = (cid, pid) => { const c = s.components.find(c => c.id === cid), p = getPorts(c).find(p => p.id === pid); return [c.x + p.dx, c.y + p.dy]; };
    const level = s.wires.every(wr => pin(wr.from.cid, wr.from.pid)[1] === pin(wr.to.cid, wr.to.pid)[1]);
    const blk = s.components.find(c => /^CUSTOM:/.test(c.type)), onGrid = getPorts(blk).every(p => (blk.y + p.dy) % GRID === 0);
    // a sheet saved before: a corner level with the pin's old place (3 px lower) moves with it, once
    const old = blankSchematic("old1", "old"); delete old.cgGrid;
    const c = { id: "b1", type: blk.type, x: 330, y: 110, params: {}, label: "" }, t = { id: "t1", type: "OUT", x: 600, y: 99, params: { name: "q" }, label: "" };
    old.components.push(c, t); const qy = c.y + getPorts(c).find(p => p.id === "q").dy;
    old.wires.push({ id: "w1", from: { cid: "b1", pid: "q" }, to: { cid: "t1", pid: "i" }, name: "", pts: [{ x: 500, y: qy + 3 }, { x: 500, y: 40 }] });
    P.old1 = old; renderAll();
    return { level, onGrid, moved: old.wires[0].pts[0].y === qy, keep: old.wires[0].pts[1].y, flag: old.cgGrid, fresh: blankSchematic("n", "n").cgGrid };
  });
  expect(r).toEqual({ level: true, onGrid: true, moved: true, keep: 40, flag: 1, fresh: 1 });
  expect(page.errors).toEqual([]);
});
