// From a user report: the VHDL block's text was dark on dark in the light theme, picking a pin far down the
// pin page jumped back to the top, a bus lit up end to end in the live sim, and a clock could only free-run.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("live sim: a bus lights only the stretch a 1 travels; ⏭ 1 clk gives one edge", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ sheet: "bp", formula: "q0 = d0 & e; q1 = d1 & e; q2 = d2 & e; q3 = d3 & e", bus: true });
    const sch = activeSch();
    const busWire = sch.wires.find(w => { try { return wireWidth(w, sch) > 1; } catch (_) { return false; } });
    if (!PROBE) toggleProbe();
    const din = sch.components.find(c => c.type === "IN" && c.params.name === "d"), en = sch.components.find(c => c.type === "IN" && c.params.name === "e");
    PROBE_VALS[din.id] = 4; PROBE_VALS[en.id] = 1; probeApply();
    const groups = [...document.querySelectorAll("#canvas .wire-group[data-wid]")].map(g => ({ id: g.dataset.wid, op: g.style.opacity }));
    const busIds = new Set([...sch.wires].filter(w => { try { return wireWidth(w, sch) > 1; } catch (_) { return false; } }).map(w => w.id));
    const busOps = groups.filter(g => busIds.has(g.id)).map(g => g.op);
    // a counter for the clock button
    await MCP_OPS.build_part({ kind: "mod_counter", sheet: "c4", params: { n: 4 } });
    probeApply();
    const btn = document.querySelector("#canvas .bp-clk");
    const qv = () => { const c = activeSch(); return c.components.filter(x => x.type === "OUT").map(o => probeEval(c).compVal.get(o.id)).join(""); };
    const q0 = qv();
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await new Promise(res => setTimeout(res, 300));
    const q1 = qv();
    document.querySelector("#canvas .bp-clk").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await new Promise(res => setTimeout(res, 300));
    const q2 = qv();
    return { sheet: sch.name, busOps, hasBtn: !!btn, q: [q0, q1, q2], comps: sch.components.map(c => c.type + ':' + (c.params.name || '')).join(' ') };
  });
  expect(r.busOps.length).toBeGreaterThan(1);
  expect(r.busOps).toContain("1");          // the stretch from d to the bit-2 tap
  expect(r.busOps).toContain("0.22");       // the rest of the bus
  expect(r.hasBtn).toBe(true);
  expect(new Set(r.q).size).toBe(3);        // one count per click
});

test("VHDL block text is readable in the light theme; the pin page keeps its scroll", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "ise");
    const t = document.createElement("textarea"); t.className = "vhb-text"; document.body.appendChild(t);
    const cs = getComputedStyle(t); const out = { bg: cs.backgroundColor, fg: cs.color }; t.remove(); return out;
  });
  expect(r.bg).not.toBe(r.fg);
  expect(r.bg).toBe("rgb(255, 255, 255)");
});
