// 73. auto pins follow a library block's own board pins (seg(0) = a, ADC on its SPI pins)
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

const setup = (page, dropBoardPins) => page.evaluate((drop) => {
  const s = activeSch(); s.components = []; s.wires = []; s.pinmap = {};
  const seg = vlBuild("seg7_num", { blank: true }), adc = vlBuild("adc_mcp3208", { ch: 6 });
  if (drop) { delete state.project.customs[seg.name].boardPins; delete state.project.customs[adc.name].boardPins; }   // a block saved before 73
  const d = vhdlBlockPlace(seg.name, s, { x: 660, y: 132 }), a = vhdlBlockPlace(adc.name, s, { x: 330, y: 132 });
  const mk = (type, x, y, name, width) => { const c = { id: uid("c"), type, x, y, label: "", params: { name, width: width || 1 } }; s.components.push(c); return c; };
  mk("IN", 110, 110, "clk"); mk("IN", 110, 220, "adc_dout");
  mk("OUT", 1000, 110, "seg", 7); mk("OUT", 1000, 220, "an", 4);
  ["adc_sck", "adc_cs", "adc_din"].forEach((n, i) => mk("OUT", 600, 440 + 66 * i, n));
  snapshot();
  const A = mcpName(a), D = mcpName(d);
  MCP_OPS.connect({ connections: [["clk", A + ".clk"], ["clk", D + ".clk"], ["adc_dout", A + ".adc_dout"],
    [A + ".adc_sck", "adc_sck"], [A + ".adc_cs", "adc_cs"], [A + ".adc_din", "adc_din"],
    [D + ".seg", "seg"], [D + ".an", "an"]] });
  uxAutoPins(s, false);
  return { pm: s.pinmap, xdc: uxXdcBody() };
}, dropBoardPins);

for (const drop of [false, true]) {
  test(`seg / ADC wired to library blocks take the block's pins${drop ? " (block saved before 73)" : ""}`, async ({ page }) => {
    await openEditor(page);
    const { pm, xdc } = await setup(page, drop);
    expect(pm).toMatchObject({ "seg[0]": "seg:a", "seg[6]": "seg:g", "an[0]": "an:0", clk: "clk",
      adc_dout: "adc:dout", adc_din: "adc:din", adc_sck: "adc:sck", adc_cs: "adc:cs" });
    expect(xdc).toContain("PACKAGE_PIN L3 IOSTANDARD LVCMOS33} [get_ports {seg[0]}]");
    expect(xdc).toContain("PACKAGE_PIN C1 IOSTANDARD LVCMOS33} [get_ports adc_din]");
    expect(xdc).toContain("PACKAGE_PIN G4 IOSTANDARD LVCMOS33} [get_ports adc_dout]");
    expect(page.errors).toEqual([]);
  });
}

test("a seg bus not driven by a library block keeps the board convention (top bit = a)", async ({ page }) => {
  await openEditor(page);
  const pm = await page.evaluate(() => {
    const s = activeSch(); s.components = []; s.wires = []; s.pinmap = {};
    s.components.push({ id: uid("c"), type: "OUT", x: 700, y: 110, label: "", params: { name: "seg", width: 7 } });
    uxAutoPins(s, false); return s.pinmap; });
  expect(pm).toMatchObject({ "seg[6]": "seg:a", "seg[0]": "seg:g" });
});

test("pins the user chose stay when only the missing ones are filled", async ({ page }) => {
  await openEditor(page);
  const pm = await page.evaluate(() => {
    const s = activeSch(); s.pinmap = { "seg[0]": "seg:g" };
    const seg = vlBuild("seg7_num", { blank: true }), d = vhdlBlockPlace(seg.name, s, { x: 660, y: 132 });
    s.components.push({ id: uid("c"), type: "OUT", x: 1000, y: 110, label: "", params: { name: "seg", width: 7 } });
    snapshot(); MCP_OPS.connect({ from: mcpName(d) + ".seg", to: "seg" });
    uxAutoPins(s, true); return s.pinmap; });
  expect(pm["seg[0]"]).toBe("seg:g");
  expect(pm["seg[1]"]).toBe("seg:b");
});
