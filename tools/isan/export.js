// Export the ISAN circuit catalogue: every library part / VHDL block / sequence detector in many settings, built and
// checked by the editor here, saved as data (the clip the editor pastes + a picture) for the ISAN viewer
// (private repo laplacian-n/isan), which only shows and copies them — no generator code goes there.
//
//   NODE_PATH=node_modules node tools/isan/export.js ../isan [filter]
//
// Writes <out>/data/index.js (categories, items, variants — small) and <out>/data/items/<kind>.js (clips + pictures,
// loaded when an item is opened). A kind / variant that fails its build or check is left out and listed in the log.
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const { pathToFileURL } = require("url");
const OUT = path.resolve(process.argv[2] || "isan-out"), FILTER = process.argv[3] || "";
const EDITOR = pathToFileURL(path.join(__dirname, "..", "..", "schematic&bus2vhdl.html")).href;

const R = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const cross = obj => Object.entries(obj).reduce((acc, [k, vals]) => acc.flatMap(a => vals.map(v => Object.assign({}, a, { [k]: v }))), [{}]);
const COMMON_N = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 24, 25, 30, 32, 40, 50, 60, 64, 100, 120, 128, 200, 250, 256, 500, 1000, 2000, 2500,
  5000, 10000, 12500, 20000, 25000, 50000, 100000, 125000, 250000, 500000, 1000000, 2500000, 5000000, 10000000, 12500000, 25000000, 50000000];
/* the variants: [source, kind, settings list] — settings are the editor form's own (blocks / async as the form starts them) */
const PLAN = [
  ["part", "half_adder", [{}]], ["part", "full_adder", [{}]], ["part", "half_subtractor", [{}]], ["part", "full_subtractor", [{}]],
  ["part", "adder", cross({ n: R(1, 8), cin: [true, false], bus: [false, true] }).filter(p => p.n > 1 || !p.bus)],
  ["part", "subtractor", cross({ n: R(1, 8), bus: [false, true] }).filter(p => p.n > 1 || !p.bus)],
  ["part", "addsub", cross({ n: R(2, 8), bus: [false, true] })],
  ["part", "multiplier", cross({ n: R(1, 4), m: R(1, 4), bus: [false, true] })],
  ["part", "cmp_slice", [{}]],
  ["part", "comparator", cross({ n: R(1, 8), bus: [false, true] }).filter(p => p.n > 1 || !p.bus)],
  ["part", "bcd2_compare", [{}]], ["part", "bcd_valid", [{}]], ["part", "majority", [{}]],
  ["part", "parity", cross({ n: R(2, 8), odd: [false, true], bus: [false, true] })],
  ["part", "mux", cross({ n: [2, 4, 8], bus: [false, true] })], ["part", "demux", cross({ n: [2, 4, 8], bus: [false, true] })],
  ["part", "mux_bus", cross({ k: [2, 4, 8], n: [1, 2, 4, 8] })],
  ["part", "decoder", cross({ n: R(1, 4), en: [false, true], bus: [false, true] })], ["part", "encoder", cross({ n: [4, 8], bus: [false, true] })],
  ["part", "add3", [{}]], ["part", "bin2bcd", cross({ n: R(4, 8) })], ["part", "tc_decode", cross({ n: R(2, 8) })], ["part", "bcd_ascii", [{}]],
  ["part", "bcd_7seg", cross({ active_low: [true, false], bus: [false, true] })], ["part", "hex_7seg", cross({ active_low: [true, false], bus: [false, true] })],
  ["part", "char_7seg", cross({ set: ["0-9a-z", "a-z"], blank0: [false, true], active_low: [true, false] })],
  ["part", "seg7_mux4", cross({ hex: [false, true], dp: [false, true] })],
  ["part", "text_scroll", ["HELLO ", "FPGA ", "EDGE ", "CE KMITL ", "HELLO WORLD ", "0123456789 "].map(text => ({ text }))],
  ["part", "led_pattern", cross({ n: [4, 8, 16], mode: ["ring", "johnson", "bounce", "fill"], en: [false, true] })],
  ["part", "pwm", cross({ n: R(2, 8) })],
  ["part", "toggle", [{}]], ["part", "edge_detector", [{}]], ["part", "debounce", [{}]], ["part", "one_pulse", [{}]],
  ["part", "register", cross({ n: R(2, 16), bus: [false, true] })], ["part", "register_en", cross({ n: [1, 2, 4, 8, 12, 16], async: [false, true] })],
  ["part", "shift_register", cross({ n: R(2, 16), bus: [false, true] })],
  ["part", "binary_counter", cross({ n: R(1, 8), bus: [false, true] }).filter(p => p.n > 1 || !p.bus)],
  ["part", "mod_counter", cross({ n: [...R(2, 16), 20, 24, 30, 32, 50, 60, 64], bus: [false, true] })],
  ["part", "bcd_counter", [{}, { bus: true }]],
  ["part", "jk_counter", cross({ n: [...R(2, 16), 20, 24, 30, 32, 50, 60, 64], output: ["clk_out", "q"] })],
  ["part", "counter_digit", cross({ m: R(2, 16), down: [false, true], load: [false, true], async: [true, false] })],
  ["part", "bcd_counter_multi", cross({ format: ["00-99", "000-999", "0000-9999", "00-59", "mm.ss", "99.59"], down: [false, true], load: [false, true] })],
  ["part", "seq_counter", cross({ values: ["2,3,5,7,11,13", "0..9", "0..99 step 3", "0,2,4,6,8", "1,3,5,7,9", "9..0", "0,1,3,7,15", "1,2,4,8"], en: [false, true] })],
  ["part", "ring_counter", [...cross({ n: R(2, 16), how: ["shift"], down: [false, true], en: [false, true], clr: [false, true] }),
    ...cross({ n: [4, 8, 16], how: ["decoder"], down: [false, true], en: [false, true], clr: [false, true] })]],
  ["part", "ascii_case", cross({ mode: ["upper", "lower", "swap"] })], ["part", "hex_ascii", cross({ lower: [false, true] })],
  ["part", "ascii_value", cross({ hex: [true, false] })],
  ["part", "note_divider", cross({ note: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"], octave: R(2, 7) })],
  ["div", "clock_divider", COMMON_N.map(n => ({ n }))],
  ["part", "alu_slice", cross({ ops: ["4", "8"] })], ["part", "alu", cross({ n: [4, 8], ops: ["4", "8"] })],
  ["part", "lab6_counter", [{}]], ["part", "lab7_countdown", [{}]],
  ["fsm", "seq_detector", ["000", "001", "010", "011", "100", "101", "110", "111", "0110", "1001", "1011", "1101", "0101", "1010", "1100", "0011", "1110", "0111", "1111", "0000", "10110", "11011"]
    .flatMap(pattern => cross({ mealy: [false, true], overlap: [true, false] }).map(o => Object.assign({ pattern }, o)))],
  ["vhdl", "add", cross({ n: R(1, 16) })], ["vhdl", "sub", cross({ n: R(1, 16) })], ["vhdl", "mul", cross({ n: R(1, 16) })], ["vhdl", "divmod", cross({ n: R(1, 16) })],
  ["vhdl", "bin2dec", cross({ digits: R(1, 5) })], ["vhdl", "seg7_num", cross({ blank: [true, false] })],
  ["vhdl", "lcd16x2", [["FPGA EDGE", "VALUE: ####"], ["LAB 8 LDR", "LIGHT: ####"], ["HELLO", "WORLD"], ["COUNT", "#####"], ["TEMP", "## C"], ["VOLT", "#.### V"], ["SCORE", "###"], ["CE KMITL", "DIGITAL SYSTEM"]]
    .map(([line1, line2]) => ({ line1, line2 }))],
  ["vhdl", "lcd_scroll", [["HELLO FROM FPGA EDGE SPARTAN-7", "FPGA EDGE"], ["WELCOME TO CE KMITL", "DIGITAL SYSTEM"], ["DIGITAL SYSTEM LAB", "VALUE: ####"], ["HELLO", "WORLD"], ["LAB 8 LDR SENSOR", "LIGHT: ####"], ["GOOD LUCK ON THE EXAM", "SCORE: ###"]]
    .flatMap(([text, other]) => cross({ row: [1, 2], right: [false, true], ms: [150, 300, 500] }).map(o => Object.assign({ text, other }, o)))],
  ["vhdl", "note_tone", [...R(0, 8).map(octave => ({ octave })), { oct_in: true }]], ["vhdl", "piano", R(1, 7).map(octave => ({ octave }))],
  ["vhdl", "melody", ["C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2",                                                     // twinkle twinkle
    "E4 D4 C4 D4 E4 E4 E4:2 D4 D4 D4:2 E4 G4 G4:2 E4 D4 C4 D4 E4 E4 E4 E4 D4 D4 E4 D4 C4:4",                                // mary had a little lamb
    "E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4:1.5 D4:0.5 D4:2",                                                             // ode to joy
    "G4:0.5 G4:0.5 A4 G4 C5 B4:2 G4:0.5 G4:0.5 A4 G4 D5 C5:2 G4:0.5 G4:0.5 G5 E5 C5 B4 A4:2 F5:0.5 F5:0.5 E5 C5 D5 C5:2",   // happy birthday
    "E4 E4 E4:2 E4 E4 E4:2 E4 G4 C4:1.5 D4:0.5 E4:4 F4 F4 F4:1.5 F4:0.5 F4 E4 E4 E4:0.5 E4:0.5 E4 D4 D4 E4 D4:2 G4:2",       // jingle bells
    "C4 D4 E4 F4 G4 A4 B4 C5", "C5 B4 A4 G4 F4 E4 D4 C4"]
    .flatMap(song => cross({ bpm: [90, 120, 160], loop: [true, false] }).map(o => Object.assign({ song }, o)))],
  ["vhdl", "ascii_7seg", cross({ active_low: [true, false] })],
  ["vhdl", "lcd_ascii", [["CHAR: @", "HEX:%% DEC:###"], ["@", "~~~~~~~~"], ["ASCII CODE", "@ = 0x%%"], ["KEY: @", "CODE: ###"]].map(([line1, line2]) => ({ line1, line2 }))],
  ["vhdl", "uart_text", ["HELLO FPGA", "HELLO WORLD", "CE KMITL", "OK"].flatMap(text => cross({ baud: [9600, 115200], crlf: [true, false] }).map(o => Object.assign({ text }, o)))],
  ["vhdl", "adc_mcp3208", cross({ ch: R(0, 7) })], ["vhdl", "uart_tx", cross({ baud: [9600, 19200, 57600, 115200] })],
  ["vhdl", "tone", [262, 294, 330, 349, 392, 440, 494, 523, 1000, 2000].map(f => ({ f }))],
];

(async () => {
  fs.mkdirSync(path.join(OUT, "data", "items"), { recursive: true });
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", e => console.log("page error:", e.message));
  await page.goto(EDITOR); await page.waitForFunction(() => typeof UX === "object"); await page.waitForTimeout(800);
  await page.evaluate(() => { document.querySelectorAll(".modal-bg").forEach(m => m.remove()); window.toast = () => {}; });
  // the page side: build one variant, return its clip + picture + facts
  await page.evaluate(() => {
    const keepTop = () => { const P = state.project, top = P.schematics[P.topId]; P.schematics = { [top.id]: top }; P.customs = {}; state.openTabs = [top.id]; state.activeId = top.id; };
    const STYLE = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "font-size", "font-weight", "font-family", "font-style", "text-anchor", "dominant-baseline"];
    window.isanPicture = sch => {
      openSchTab(sch.id); state.selection = new Set(); renderAll();
      const svg = document.getElementById("canvas"), world = svg.firstElementChild, box = world.getBBox();
      const clone = world.cloneNode(true), src = [world, ...world.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
      // only what differs from the parent (or from SVG's own defaults at the top): pictures were 240 KB with every property on every element
      const INIT = { fill: "rgb(0, 0, 0)", stroke: "none", "stroke-width": "1px", "stroke-dasharray": "none", "stroke-linecap": "butt", "stroke-linejoin": "miter",
        "fill-opacity": "1", "font-style": "normal", "text-anchor": "start", "dominant-baseline": "auto", "font-weight": "400" };
      src.forEach((e, i) => { const d = dst[i]; if (!d || !(e instanceof SVGElement)) return; const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden") { d.remove(); return; }
        const pcs = e === world ? null : getComputedStyle(e.parentElement);
        STYLE.forEach(k => { const v = cs.getPropertyValue(k); if (!v) return;
          if (k === "opacity") { if (v !== "1") d.setAttribute(k, v); return; }
          const base = pcs ? pcs.getPropertyValue(k) : INIT[k];
          if (v !== base) d.setAttribute(k, k === "font-family" ? "Segoe UI, sans-serif" : v); });
        d.removeAttribute("class"); d.removeAttribute("style"); [...d.attributes].forEach(a => { if (/^data-|^on/.test(a.name)) d.removeAttribute(a.name); }); });
      clone.removeAttribute("transform");
      clone.querySelectorAll("title").forEach(t => t.remove());
      // hover / hit areas paint nothing (transparent stroke, no fill): gone
      const clear = v => !v || v === "none" || /rgba\(.*,\s*0\)$/.test(v) || v === "transparent";
      clone.querySelectorAll("path, rect, circle, line, polyline, polygon").forEach(e => {
        const f = e.getAttribute("fill") ?? e.closest("[fill]")?.getAttribute("fill"), st = e.getAttribute("stroke") ?? e.closest("[stroke]")?.getAttribute("stroke");
        if (clear(f) && clear(st)) e.remove(); });
      // the same style on many elements becomes one class
      const SA = STYLE.filter(k => k !== "font-family"), count = new Map();
      const sig = e => SA.map(k => e.hasAttribute(k) ? k + ":" + e.getAttribute(k) : "").filter(Boolean).join(";");
      clone.querySelectorAll("*").forEach(e => { const k = sig(e); if (k) count.set(k, (count.get(k) || 0) + 1); });
      const cls = new Map(); let css = "text{font-family:Segoe UI,sans-serif}";
      [...count].filter(([, n]) => n > 1).forEach(([k], i) => { cls.set(k, "s" + i); css += `.s${i}{${k}}`; });
      clone.querySelectorAll("*").forEach(e => { const k = sig(e); if (cls.has(k)) { SA.forEach(a => e.removeAttribute(a)); e.setAttribute("class", cls.get(k)); } e.removeAttribute("font-family"); });
      clone.insertAdjacentHTML("afterbegin", `<style>${css}</style>`);
      // groups left empty
      for (let again = true; again; ) { again = false; clone.querySelectorAll("g").forEach(g => { if (!g.children.length) { g.remove(); again = true; } }); }
      const r = n => Math.round(n);
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(box.x - 16)} ${r(box.y - 16)} ${r(box.width + 32)} ${r(box.height + 32)}">${clone.outerHTML}</svg>`
        .replace(/(\d+\.\d)\d+/g, "$1").replace(/rgb\((\d+), (\d+), (\d+)\)/g, (m, r, g, b) => "#" + [r, g, b].map(x => (+x).toString(16).padStart(2, "0")).join(""));
    };
    const ports = list => list.map(p => ({ dir: p.dir, name: p.width > 1 ? `${p.name || p.id}[${p.width - 1}:0]` : (p.name || p.id) }));
    window.isanBuild = (src, kind, a) => {
      keepTop();
      if (src === "vhdl") {
        const r = vlBuild(kind, a), s = activeSch(), c = vhdlBlockPlace(r.name, s);
        const need = clipNeeds([c]);
        return { label: VLIB[kind].label.replace(/ \(VHDL\)$/, ""), name: r.name, how: r.verified.how, ports: ports(r.ports), code: r.text,
          clip: { kind: "parts", components: [JSON.parse(JSON.stringify(c))], wires: [], ties: [], sheets: need.sheets, customs: need.customs } };
      }
      let sheetName, how;
      if (src === "fsm") {
        const d = Object.assign({ x: "x", z: "z" }, a), r = MCP_OPS.build_fsm({ fsm: sqdDiagram(d), name: "det_" + a.pattern + (a.mealy ? "_mealy" : "_moore") + (a.overlap ? "" : "_nov") });
        const sch = Object.values(state.project.schematics).find(s => s.name === r.sheet), c = sqdCheck(sch, d);
        if (!c.ok) throw new Error("check: " + c.why);
        how = `จำลอง ${c.clocks} clock เทียบกับตัวตรวจจับอ้างอิง`; sheetVerifyStamp(sch, how); sheetName = r.sheet;
      } else {
        let k = kind, args = Object.assign({}, a);
        if (src === "div" && a.n > 16) { const L = divFactors(a.n); if (L && L.length > 1) k = "divider_chain"; }
        const P = PARTS[k];
        Object.entries(P.params || {}).forEach(([n, s]) => { if (args[n] === undefined && s.uiDef !== undefined) args[n] = s.uiDef; });
        const r = MCP_OPS.build_part(Object.assign({ kind: k }, args)); sheetName = r.sheet; how = r.verified.method;
      }
      const sch = Object.values(state.project.schematics).find(s => s.name === sheetName);
      if (!sheetVerified(sch)) throw new Error("not verified");
      return { name: sch.name, how, ports: ports(schPortList(sch)), picture: isanPicture(sch), clip: clipSheetObj(sch),
        sub: Object.values(state.project.schematics).filter(s => s !== sch && s.id !== state.project.topId).map(s => s.name) };
    };
    // the settings the editor's form starts with (cards show that variant first)
    window.isanDefaults = () => Object.assign(
      Object.fromEntries(Object.entries(PARTS).map(([k, P]) => [k, Object.fromEntries(Object.entries(P.params || {}).map(([n, s]) => [n, s.uiDef !== undefined ? s.uiDef : s.def]))])),
      Object.fromEntries(Object.entries(VLIB).map(([k, V]) => ["v_" + k, Object.fromEntries(Object.entries(V.params || {}).map(([n, s]) => [n, s.def]))])),
      { clock_divider: { n: 50 }, seq_detector: { pattern: "101", mealy: false, overlap: true } });
    window.isanMeta = () => ({ parts: Object.fromEntries(Object.entries(PARTS).map(([k, P]) => [k, { label: P.label, desc: P.desc, group: P.group }])),
      vlib: Object.fromEntries(Object.entries(VLIB).map(([k, V]) => [k, { label: V.label.replace(/ \(VHDL\)$/, ""), desc: V.desc, cat: V.cat, params: V.params }])),
      cats: LIB_CATS.map(c => ({ id: c.id, label: c.label, kinds: c.kinds })), icons: LIB_SVG });
  });
  const meta = await page.evaluate(() => isanMeta()), defaults = await page.evaluate(() => isanDefaults());
  const items = [], log = [];
  for (const [src, kind, variants] of PLAN) {
    if (FILTER && !kind.includes(FILTER)) continue;
    const out = []; const t0 = Date.now();
    for (const a of variants) {
      try {
        const r = await page.evaluate(([s, k, x]) => isanBuild(s, k, x), [src, kind, a]);
        out.push(Object.assign({ params: a }, r));
      } catch (e) { log.push(`${kind} ${JSON.stringify(a)}: ${String(e.message).split("\n")[0].slice(0, 200)}`); }
    }
    if (!out.length) continue;
    const id = (src === "vhdl" ? "v_" : "") + kind;
    fs.writeFileSync(path.join(OUT, "data", "items", id + ".js"), `ISAN.load(${JSON.stringify(id)}, ${JSON.stringify(out)});\n`);
    const def = defaults[id] || defaults[kind] || {}, score = v => Object.keys(def).filter(k => JSON.stringify(v.params[k] ?? (k === "bus" ? false : undefined)) === JSON.stringify(def[k])).length;
    let di = 0; out.forEach((v, i) => { if (score(v) > score(out[di])) di = i; });
    items.push({ id, src, kind, def: di, variants: out.map(v => ({ params: v.params, name: v.name, how: v.how, ports: v.ports, sub: v.sub || [] })) });
    console.log(`${id}: ${out.length}/${variants.length} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  if (!FILTER) {
    const index = { made: new Date().toISOString().slice(0, 10), meta, items };
    fs.writeFileSync(path.join(OUT, "data", "index.js"), `ISAN.index(${JSON.stringify(index)});\n`);
  }
  fs.writeFileSync(path.join(OUT, "data", "export-log.txt"), log.join("\n") + "\n");
  console.log(`done: ${items.length} items, ${items.reduce((n, i) => n + i.variants.length, 0)} variants, ${log.length} left out`);
  await browser.close();
})();
