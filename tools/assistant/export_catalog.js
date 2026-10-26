// The assistant's catalog of this app: every library part (PARTS, as list_parts gives it), every ready-made
// VHDL block (VLIB, ports from the block's own default text), the library window's categories and the design
// tools (GENERATORS) — read out of the editor itself, so the model is told what the program really has.
//
//   NODE_PATH=node_modules node tools/assistant/export_catalog.js [--channel msedge] [--check]
//
// Writes ai/assistant/catalog.json (the launcher's find_parts tool searches it). --check fails when the file is stale.
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const { pathToFileURL } = require("url");
const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(ROOT, "ai", "assistant", "catalog.json");
const EDITOR = pathToFileURL(path.join(ROOT, "schematic&bus2vhdl.html")).href;
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ""; };

(async () => {
  const browser = await chromium.launch(arg("--channel") ? { channel: arg("--channel") } : {});
  const page = await browser.newPage();
  await page.goto(EDITOR);
  await page.waitForFunction(() => typeof MCP_OPS === "object" && typeof VLIB === "object" && typeof PARTS === "object");
  await page.waitForTimeout(700);
  const cat = await page.evaluate(() => {
    const catOf = {}; LIB_CATS.forEach(c => c.kinds.forEach(k => catOf[k] = c.label));
    const parts = MCP_OPS.list_parts({}).parts.map(p => ({
      kind: p.kind, label: p.label, category: catOf[p.kind] || p.group || "", description: p.description,
      params: p.params, sequential: p.sequential, ports: p.ports_with_defaults }));
    const vhdl = Object.entries(VLIB).map(([k, L]) => {
      const p = vlParams(k, {}), M = vhCompile(vlText(k, p)), w = x => x.width > 1 ? `${x.name}[${x.width - 1}:0]` : x.name;
      const params = {}; Object.entries(L.params || {}).forEach(([n, s]) =>
        params[n] = (s.label ? s.label + ": " : "") + (s.options ? s.options.join(" | ") : s.bool ? "true/false" : s.text ? "ข้อความ เช่น " + JSON.stringify(s.def) : `${s.min}..${s.max} (ค่าเริ่ม ${s.def})`));
      return { kind: k, label: L.label, category: (LIB_CATS.find(c => c.id === L.cat) || {}).label || L.cat || "อุปกรณ์บนบอร์ด",
               description: L.desc, params, ports: { in: M.ports.filter(x => x.dir === "in").map(w), out: M.ports.filter(x => x.dir === "out").map(w) },
               board_pins: L.pins ? Object.keys(L.pins(p)) : [] };
    });
    const generators = GENERATORS.map(g => ({ id: g.id, name: g.name, description: g.desc || "" }));
    return { categories: LIB_CATS.map(c => c.label), parts, vhdl, generators };
  });
  await browser.close();
  const text = JSON.stringify(cat, null, 1) + "\n";
  if (process.argv.includes("--check")) {
    const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (old !== text) { console.error("ai/assistant/catalog.json is stale — run tools/assistant/export_catalog.js"); process.exit(1); }
    console.log("catalog up to date"); return;
  }
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${cat.parts.length} parts, ${cat.vhdl.length} VHDL blocks, ${cat.generators.length} tools`);
})().catch(e => { console.error(e); process.exit(1); });
