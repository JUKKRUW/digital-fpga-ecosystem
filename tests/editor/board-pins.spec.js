// The whole EDGE board as pin targets (LCD, VGA, UART, J5 …), pull-down on buttons in the .xdc,
// and push buttons that work on the simulated board outside real-time mode.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("LCD and the rest of the board are targets; buttons get PULLDOWN; LCD data on an LED's pin is caught", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const bp = MCP_OPS.board_pins(), pin = t => (bp.outputs.concat(bp.inputs).find(x => x.target === t) || {}).pin;
    await MCP_OPS.build_circuit({ sheet: "lcd", intent: { module: "lcd", components: [
      { id: "b", type: "IN", name: "btn" }, ...Array.from({ length: 8 }, (_, i) => ({ id: "d" + i, type: "OUT", name: "data" + i })),
      { id: "rs", type: "OUT", name: "rs" }, { id: "e", type: "OUT", name: "e" }, { id: "y", type: "OUT", name: "y" } ],
      nets: [{ from: "b", to: "rs" }, { from: "b", to: "e" }, { from: "b", to: "y" }, ...Array.from({ length: 8 }, (_, i) => ({ from: "b", to: "d" + i }))] } });
    const s = activeSch();
    const pre = MCP_OPS.pin_preset({ sheet: "lcd", lab: 8 });
    s.pinmap.btn = "pb:4"; s.pinmap.y = "j5:5";
    const xdc = MCP_OPS.get_xdc({ sheet: "lcd" }).xdc;
    const ok = MCP_OPS.board_check({ sheet: "lcd" }).findings.map(f => f.title).join("\n");
    s.pinmap.y = "led:7";                                     // = LCD data 0 (M4)
    const clash = MCP_OPS.board_check({ sheet: "lcd" }).findings.map(f => f.title).join("\n");
    return { rs: pin("lcd:rs"), e: pin("lcd:e"), d0: pin("lcd:d0"), j20: pin("j5:20"), vga: pin("vga:hs"), set: pre.assigned, xdc, ok, clash };
  });
  expect([r.rs, r.e, r.d0, r.j20, r.vga]).toEqual(["M5", "P5", "M4", "F12", "C4"]);
  expect(r.set).toEqual(expect.arrayContaining(["rs → lcd:rs", "e → lcd:e", "data0 → lcd:d0", "data7 → lcd:d7"]));
  expect(r.xdc).toMatch(/PACKAGE_PIN M5 IOSTANDARD LVCMOS33\} \[get_ports rs\]/);
  expect(r.xdc).toMatch(/PACKAGE_PIN J12 IOSTANDARD LVCMOS33 PULLDOWN true\} \[get_ports btn\]/);
  expect(r.ok).not.toMatch(/ขาเดียวกัน/);
  expect(r.clash).toMatch(/data0 กับ y ใช้ขาเดียวกัน|y กับ data0 ใช้ขาเดียวกัน/);
});

test("push buttons on the simulated board: truth-table and clock-by-clock boards", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await openEditor(page);
  // combinational: y = btn AND sw
  await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ sheet: "pbc", intent: { module: "pbc", components: [
      { id: "b", type: "IN", name: "btn" }, { id: "s", type: "IN", name: "s" }, { id: "g", type: "AND" }, { id: "y", type: "OUT", name: "y" } ],
      nets: [{ from: "b", to: "g" }, { from: "s", to: "g" }, { from: "g", to: "y" }] } });
    activeSch().pinmap = { btn: "pb:4", s: "sw:0", y: "led:0" };
    showSimPage("signals");
  });
  const centre = page.locator("#simPcb .pbtn").nth(2);
  await expect(centre).toContainText("btn");
  await page.locator('#simPcb .swUnit[data-sw="0"]').click();
  await expect(page.locator("#simValbar")).toContainText("y=0");
  const box = await centre.boundingBox();
  await page.mouse.move(box.x + 16, box.y + 16); await page.mouse.down();
  await expect(page.locator("#simValbar")).toContainText("btn=1");
  await expect(page.locator("#simValbar")).toContainText("y=1");
  await page.mouse.up();
  await expect(page.locator("#simValbar")).toContainText("y=0");
  // clock by clock: a D flip-flop whose d is the top button — click it, step one clock, q = 1
  await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ sheet: "pbs", intent: { module: "pbs", components: [
      { id: "c", type: "IN", name: "clk" }, { id: "b", type: "IN", name: "go" }, { id: "f", type: "DFF" }, { id: "q", type: "OUT", name: "q" } ],
      nets: [{ from: "c", to: "f.clk" }, { from: "b", to: "f.d" }, { from: "f.q", to: "q" }] } });
    activeSch().pinmap = { clk: "clk", go: "pb:0", q: "led:0" };
    showSimPage("signals");
  });
  const top = page.locator("#simPcb .pbtn").nth(0);
  await expect(top).toContainText("go");
  await expect(page.locator('#simPcb .swUnit.mapped')).toHaveCount(0);       // no switch stands in for the button
  await top.click();
  await page.locator('[data-act="seq-step"]').click();
  await expect(page.locator("#simValbar")).toContainText("q=1");
  await page.locator('[data-act="seq-step"]').click();
  await expect(page.locator("#simValbar")).toContainText("q=0");
  expect(page.errors).toEqual([]);
});
