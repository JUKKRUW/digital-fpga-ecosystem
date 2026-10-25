// The part / module library is a window (Tools ▸ คลังชิ้นส่วนและโมดูล) with categories, not the Modules side tab.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("library window: a checked part placed as a block on the sheet on screen", async ({ page }) => {
  await openEditor(page);
  await expect(page.locator('.pane-tabs button[data-ltab="modules"]')).toBeHidden();      // the side tab is gone
  await page.click('#menu button[data-menu="tools"]');
  await page.click('#menu [data-gen="library"]');
  const win = page.locator(".lib-win");
  await expect(win.locator('.lib-cat[data-libcat="arith"]')).toContainText("บวก / ลบ / คูณ");
  await expect(win.locator('.lib-cat[data-libcat="btn"]')).toContainText("ปุ่มกด");                // debounce lives there now
  await win.locator('.lib-cat[data-libcat="btn"]').click();
  await expect(win.locator('.lib-main [data-libpart="debounce"]').first()).toBeVisible();
  await win.locator('.lib-cat[data-libcat="arith"]').click();
  await win.locator('button[data-libpart="adder"]').click();
  const dlg = page.locator(".modal").last();
  await dlg.locator('[data-pp="n"]').fill("4");
  await dlg.locator('[data-pp="bus"]').check();
  await expect(dlg.locator('[data-pp="blocks"]')).toBeChecked();                          // the form starts "from blocks"
  await expect(dlg.locator("#ptPorts")).toContainText("a[3:0]");
  await page.screenshot({ path: test.info().outputPath("parts-dialog.png") });
  const before = await page.evaluate(() => activeSch().name);
  await dlg.locator("#ptPlace").click();
  await expect(page.locator(".modal .pt-busy")).toHaveCount(0);
  await expect(page.locator(".lib-win")).toHaveCount(0);                                   // the window closes with it
  await expect.poll(() => page.evaluate(() => activeSch().components.some(c => String(c.type).startsWith("SCH:")))).toBe(true);
  const r = await page.evaluate(() => { const s = activeSch(); const blk = s.components.find(c => String(c.type).startsWith("SCH:"));
    const sub = blk && state.project.schematics[blk.type.slice(4)];
    return { name: s.name, block: !!blk, pins: blk ? getPorts(blk).map(p => p.id + ":" + (p.width || 1)) : [], verified: sub && sheetVerified(sub),
      inner: sub ? sub.components.filter(c => String(c.type).startsWith("SCH:")).length : 0 }; });
  expect(r.name).toBe(before);
  expect(r.block).toBe(true);
  expect(r.pins).toEqual(["a:4", "b:4", "cin:1", "s:4", "cout:1"]);
  expect(r.verified).toBe(true);
  expect(r.inner).toBe(4);                                                                 // four full-adder blocks inside
  const overlap = await page.evaluate(() => { const s = activeSch(), b = s.components.find(c => String(c.type).startsWith("SCH:")), B = getSize(b);
    return s.components.filter(c => c !== b && c.type !== "JUNCTION").some(c => { const S = getSize(c); return c.x < b.x + B.w && b.x < c.x + S.w && c.y < b.y + B.h && b.y < c.y + S.h; }); });
  expect(overlap).toBe(false);
  // search reaches every category
  await page.evaluate(() => openLibrary());
  await page.fill("#libSearch", "7-seg");
  await expect(page.locator('.lib-win [data-libpart="bcd_7seg"]').first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("library.png") });
  expect(page.errors).toEqual([]);
});

test("library window: my module saved into a category (or กองกลาง), moved over MCP", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(async () => { await MCP_OPS.build_part({ kind: "mod_counter", sheet: "cnt6", params: { n: 6 } }); openLibrary(); });
  await page.click("#libSave");
  const dlg = page.locator(".modal").last();
  await dlg.locator("#lsName").fill("my_cnt6");
  await dlg.locator("#lsCat").selectOption("ตัวนับ");
  await dlg.locator("#lsOk").click();
  await expect(page.locator(".lib-cat.on")).toContainText("ตัวนับ");
  await expect(page.locator(".lib-main")).toContainText("my_cnt6");
  await expect(page.locator(".lib-main")).toContainText("✓ ตรวจแล้ว");                      // it was a verified part
  const r = await page.evaluate(() => { const L = MCP_OPS.list_modules({}).modules; const a = L.find(m => m.name === "my_cnt6").category;
    const b = MCP_OPS.set_module_category({ module: "my_cnt6", category: "งานกลุ่ม" }).category;
    libRender(); return { a, b, side: [...document.querySelectorAll(".lib-cat")].map(x => x.textContent) }; });
  expect(r.a).toBe("ตัวนับ");
  expect(r.b).toBe("งานกลุ่ม");
  expect(r.side.some(t => /งานกลุ่ม/.test(t))).toBe(true);                                 // a category of its own
  // place it from the window
  await page.locator(".lib-cat", { hasText: "งานกลุ่ม" }).click();
  await page.locator("[data-libuse]").first().click();
  await expect.poll(() => page.evaluate(() => activeSch().components.some(c => String(c.type).startsWith("SCH:")))).toBe(true);
  expect(page.errors).toEqual([]);
});
