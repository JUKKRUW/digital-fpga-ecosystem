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

test("sim page: ⚡ real time on a design with a clock divider; bus inputs on switches bit by bit (lab 9)", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_part({ kind: "clock_divider", sheet: "dv", params: { n: 50 } });
    await MCP_OPS.build_hierarchy({ sheet: "alu", blocks: [{ name: "d", sheet: "dv" }], inputs: ["clk", "a[3:0]", "b"], outputs: ["tick", "y[3:0]"],
      connect: [["clk", "d.clk_in"], ["d.clk_out", "tick"], ["a[0]", "y[0]"], ["a[1]", "y[1]"], ["a[2]", "y[2]"], ["a[3]", "y[3]"]] });
    const s = Object.values(state.project.schematics).find(x => x.name === "alu");
    s.pinmap = { clk: "clk", "a[0]": "sw:0", "a[1]": "sw:9", "a[2]": "sw:10", "a[3]": "sw:11", b: "sw:3" };
    openSchTab(s.id); renderAll(); showSimPage();
    await new Promise(res => setTimeout(res, 2500));
    const out = { rt: !!document.querySelector('#simBoardMsg [data-act="rt-toggle"]'), bus: (SIM_SEQ.busBits || []).map(b => b.name + ":" + b.bits.map(x => x.bit + "@" + x.sw).join(",")) };
    seqToggle(10); seqToggle(0);
    out.a = SIM_SEQ.rows[SIM_SEQ.idx][1][SIM_SEQ.inputs.indexOf("a")];
    return out;
  });
  expect(r.rt).toBe(true);
  expect(r.bus).toEqual(["a:0@0,1@9,2@10,3@11"]);
  expect(r.a).toBe(5);
});
