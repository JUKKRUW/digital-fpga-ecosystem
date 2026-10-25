// Ready-made VHDL blocks (arithmetic, number → display, LCD, ADC MCP3208, UART, buzzer), each checked before it is saved;
// Tools ▸ ตัวสร้างวงจร keeps only the library entry, the generators are cards in the window.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("every VHDL library block builds and passes its check; the LCD refuses Thai text", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(() => {
    const cases = [["add", { n: 8 }], ["sub", { n: 6 }], ["mul", { n: 4 }], ["divmod", { n: 6 }], ["bin2dec", { digits: 4 }], ["seg7_num", {}], ["seg7_num", { blank: false }],
      ["lcd16x2", {}], ["lcd16x2", { line1: "HELLO", line2: "WORLD" }],
      ["lcd_scroll", {}], ["lcd_scroll", { text: "HI", right: true }], ["lcd_scroll", { row: 2, other: "VALUE: ####", text: "SCROLL ME PLEASE" }], ["adc_mcp3208", {}], ["adc_mcp3208", { ch: 0 }], ["uart_tx", { baud: 9600 }], ["tone", {}]];
    const bad = [];
    cases.forEach(([k, a]) => { try { const x = vlBuild(k, a); if (!x.verified.pass || !state.project.customs[x.name]) bad.push(k); } catch (e) { bad.push(k + ": " + e.message); } });
    const all = Object.keys(VLIB).filter(k => !cases.some(c => c[0] === k));
    let thai = ""; try { vlBuild("lcd16x2", { line1: "สวัสดี" }); } catch (e) { thai = e.message; }
    // a broken generator is caught: the divider's remainder swapped for the quotient
    const keep = VLIB.divmod.vhdl; VLIB.divmod.vhdl = (p, E) => keep(p, E).replace("unsigned(a) mod unsigned(b)", "unsigned(a) / unsigned(b)");
    let caught = ""; try { vlBuild("divmod", { n: 4, name: "dm_bad" }); } catch (e) { caught = e.message; } VLIB.divmod.vhdl = keep;
    // the scrolling LCD: a step of 2 is caught by decoding the screen
    const keepS = VLIB.lcd_scroll.vhdl; VLIB.lcd_scroll.vhdl = (p, E) => keepS(p, E).replace("off <= off + 1;", "off <= off + 2;");
    let caughtS = ""; try { vlBuild("lcd_scroll", { text: "ABCDEFGHIJKLMNOPQR", name: "ls_bad" }); } catch (e) { caughtS = e.message; } VLIB.lcd_scroll.vhdl = keepS;
    return { bad, all, thai, caught, caughtS, same: vlBuild("add", { n: 8 }).name };
  });
  expect(r.bad).toEqual([]);
  expect(r.all).toEqual([]);                       // every kind is in the list above
  expect(r.thai).toContain("ภาษาไทย");
  expect(r.caught).toContain("ตรวจไม่ผ่าน");
  expect(r.caughtS).toContain("ตรวจไม่ผ่าน");
  expect(r.same).toBe("add8");                     // the same block again reuses it
  expect(page.errors).toEqual([]);
});

test("library window: LCD block opened as a sheet with the EDGE pins; Tools menu holds only the library", async ({ page }) => {
  test.setTimeout(60000);
  await openEditor(page);
  await page.click('#menu button[data-menu="tools"]');
  await expect(page.locator("#menu .gen-mi:visible")).toHaveCount(1);
  await page.click('#menu [data-gen="library"]');
  await page.click('.lib-cat[data-libcat="dev"]');
  await page.click('[data-libvl="lcd16x2"]');
  const dlg = page.locator(".modal").last();
  await dlg.locator('[data-vp="line2"]').fill("LDR: ####");
  await expect(dlg.locator("#vlInfo")).toContainText("value[13:0]");
  await dlg.locator("#vlSheet").click();
  await expect(page.locator(".lib-win")).toHaveCount(0);
  const r = await page.evaluate(() => { const s = activeSch(); return { name: s.name, pins: s.pinmap, blk: s.components.some(c => /^CUSTOM:lcd16x2/.test(c.type)),
    outs: s.components.filter(c => c.type === "OUT").map(c => c.params.name).sort() }; });
  expect(r.blk).toBe(true);
  expect(r.pins.lcd_rs).toBe("lcd:rs");
  expect(r.pins["lcd_data[7]"]).toBe("lcd:d7");
  expect(r.outs).toEqual(["lcd_data", "lcd_e", "lcd_rs"]);
  // the generators are in the window's tools category
  // the scrolling LCD's form takes a long text
  await page.evaluate(() => openLibrary("dev"));
  await page.click('[data-libvl="lcd_scroll"]');
  const d2 = page.locator(".modal").last();
  await d2.locator('[data-vp="text"]').fill("THIS TEXT IS LONGER THAN SIXTEEN");
  await expect(d2.locator("#vlInfo")).toContainText("วนครบ 36 ตำแหน่ง");
  await d2.locator("#vlPlace").click();
  expect(await page.evaluate(() => activeSch().components.some(c => /^CUSTOM:lcd_scroll/.test(c.type)))).toBe(true);
  await page.evaluate(() => openLibrary("tools"));
  await expect(page.locator('.lib-card[data-libtool="fsm"]')).toBeVisible();
  expect(page.errors).toEqual([]);
});
