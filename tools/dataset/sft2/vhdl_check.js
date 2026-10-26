// Compile + run a VHDL text with the app's own VHDL simulator (editor/ux/56-vhdl-sim.js) — for the
// eval's VHDL cases. stdin: {vhdl, kind:"rom", x, y, table:[…]} | {vhdl, kind:"seq", clk, vectors:[{…}], expect:{port:[…]}}
// stdout: {ok, why}
const fs = require("fs"), vm = require("vm"), path = require("path");
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "..", "..", "editor", "ux", "56-vhdl-sim.js"), "utf8") + "\nthis.api={vhCompile,vhInitState,vhRun};", ctx);
const { vhCompile, vhInitState, vhRun } = ctx.api;
const T = JSON.parse(fs.readFileSync(0, "utf8"));
const out = r => { process.stdout.write(JSON.stringify(r)); process.exit(0); };
let M; try { M = vhCompile(T.vhdl); } catch (e) { out({ ok: false, why: "compile: " + e.message }); }
const num = v => !v ? 0 : v.k === "vec" || v.k === "sl" ? v.v : v.k === "bool" ? +v.v : v.v;
const port = n => M.ports.find(p => p.name === String(n).toLowerCase());
try {
  if (T.kind === "rom") {
    if (!port(T.x) || !port(T.y)) out({ ok: false, why: "ports " + M.ports.map(p => p.raw).join(",") });
    for (let i = 0; i < T.table.length; i++) {
      const s = vhRun(M, vhInitState(M), { [T.x.toLowerCase()]: i }, null);
      if (num(s.sig[T.y.toLowerCase()]) !== T.table[i]) out({ ok: false, why: `row ${i}: ${num(s.sig[T.y.toLowerCase()])} ≠ ${T.table[i]}` });
    }
    out({ ok: true, why: "all rows" });
  }
  // sequential: outputs of clock i = the state after i edges, inputs of clock i drive edge i+1
  const clk = (T.clk || "clk").toLowerCase();
  if (!port(clk)) out({ ok: false, why: "no clock port " + clk });
  let st = vhInitState(M), prev = null;
  const lo = v => Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toLowerCase(), x]));
  for (let i = 0; i < T.vectors.length; i++) {
    const v = Object.assign(lo(T.vectors[i]), { [clk]: 0 });
    st = vhRun(M, st, v, prev); prev = v;
    for (const [p, L] of Object.entries(T.expect)) if (num(st.sig[p.toLowerCase()]) !== L[i]) out({ ok: false, why: `${p} at clock ${i}: ${num(st.sig[p.toLowerCase()])} ≠ ${L[i]}` });
    const h = Object.assign({}, v, { [clk]: 1 }); st = vhRun(M, st, h, prev); prev = h;
  }
  out({ ok: true, why: T.vectors.length + " clocks" });
} catch (e) { out({ ok: false, why: "run: " + e.message }); }
