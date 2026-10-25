// โหมดเรียบง่าย (exam mode, View ▸ โหมดเรียบง่าย): no AI, no sim page, no library / generators, no MCP; canvas sim, pins, paste and a hand-written
// VHDL block stay; the choice survives a reload; leaving asks first.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("simple mode hides AI, the sim page and the generators; keeps the canvas sim; survives a reload", async ({ page }) => {
  await openEditor(page);
  await page.click('#menu button[data-menu="view"]');
  await page.click("#btnSimple");
  await expect(page.locator("#btnSimple")).toHaveClass(/on/);
  await expect(page.locator("#btnAiChat")).toBeHidden();
  await expect(page.locator('.step[data-stage="sim"]')).toBeHidden();
  await expect(page.locator('.step[data-stage="pins"]')).toBeVisible();
  await page.click('#menu button[data-menu="tools"]');
  await expect(page.locator('#menu [data-gen="library"]')).toBeHidden();
  await expect(page.locator('#menu [data-gen="vhdl_block"]')).toBeVisible();
  const r = await page.evaluate(() => { let mcp = ""; try { MCP_OPS.build_part({ kind: "full_adder" }); } catch (e) { mcp = e.message; }
    showSimPage("signals"); const simShown = document.getElementById("simPage").classList.contains("show");
    openLibrary(); const lib = !!document.querySelector(".lib-bg");
    // the canvas simulation still works
    if (!PROBE) toggleProbe(); const s = activeSch(), a = s.components.find(c => c.type === "IN"); PROBE_VALS[a.id] = 1; probeApply();
    return { mcp, simShown, lib, probe: !!PROBE }; });
  expect(r.mcp).toContain("โหมดเรียบง่าย");
  expect(r.simShown).toBe(false);
  expect(r.lib).toBe(false);
  expect(r.probe).toBe(true);
  await page.reload(); await page.waitForFunction(() => typeof UX === "object"); await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelectorAll(".modal-bg").forEach(m => m.remove()));
  await expect(page.locator("#btnSimple")).toHaveClass(/on/);
  await expect(page.locator("#btnSimple")).toContainText("✓");
  await page.click('#menu button[data-menu="view"]');
  await page.click("#btnSimple");
  await page.click("#smLeave");
  await expect(page.locator("#btnSimple")).not.toHaveClass(/on/);
  await expect(page.locator("#btnAiChat")).toBeVisible();
  expect(page.errors).toEqual([]);
});
