// Copy / paste between windows: a sheet as one block (with its sub-sheets and verified stamp), a selection with a
// VHDL block, Ctrl+C / Ctrl+V through the system clipboard; a same-project paste adds no sheets.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("copy in one window, paste in another: sheets, VHDL blocks and stamps travel; reused on a second paste", async ({ browser }) => {
  test.setTimeout(90000);
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const A = await openEditor(await ctx.newPage()), B = await openEditor(await ctx.newPage());
  await A.evaluate(() => { MCP_OPS.build_part({ kind: "adder", sheet: "add4", params: { n: 4, blocks: true } }); vlBuild("divmod", { n: 4 }); });
  const sheetClip = await A.evaluate(() => clipText(clipSheetObj(activeSch())));
  await A.evaluate(() => { const s = activeSch(), blk = vhdlBlockPlace("divmod4", s); s.components.push({ id: "cx1", type: "AND", x: 500, y: 500, params: { inputs: 2 }, label: "" });
    state.selection = new Set([blk.id, "cx1"]); renderAll(); document.body.focus(); });
  await A.keyboard.press("Control+c");
  await expect.poll(() => A.evaluate(() => navigator.clipboard.readText().then(t => t.slice(0, 19)))).toBe('{"schstudio":"clip"');
  const r = await B.evaluate(t => { const n0 = Object.keys(state.project.schematics).length;
    clipPasteObj(clipFromText(t)); const n1 = Object.keys(state.project.schematics).length;
    clipPasteObj(clipFromText(t)); const n2 = Object.keys(state.project.schematics).length;
    const blk = activeSch().components.find(c => /^SCH:/.test(c.type)), sub = state.project.schematics[blk.type.slice(4)];
    return { added: n1 - n0, again: n2 - n1, name: sub.name, verified: sheetVerified(sub),
      inner: sub.components.filter(c => /^SCH:/.test(c.type)).map(c => state.project.schematics[c.type.slice(4)].name) }; }, sheetClip);
  expect(r.added).toBe(2);                         // add4 and the full_adder it is made of
  expect(r.again).toBe(0);
  expect(r.verified).toBe(true);
  expect(r.inner).toEqual(["full_adder", "full_adder", "full_adder", "full_adder"]);
  const n = await B.evaluate(() => activeSch().components.length);
  await B.keyboard.press("Control+v");
  await expect.poll(() => B.evaluate(() => activeSch().components.length)).toBe(n + 2);
  expect(await B.evaluate(() => !!state.project.customs.divmod4 && activeSch().components.some(c => c.type === "CUSTOM:divmod4"))).toBe(true);
  // the same window: the plain paste, no new sheets
  const s0 = await A.evaluate(() => Object.keys(state.project.schematics).length), c0 = await A.evaluate(() => activeSch().components.length);
  await A.keyboard.press("Control+v");
  await expect.poll(() => A.evaluate(() => activeSch().components.length)).toBe(c0 + 2);
  expect(await A.evaluate(() => Object.keys(state.project.schematics).length)).toBe(s0);
  expect(A.errors.concat(B.errors)).toEqual([]);
  await ctx.close();
});
