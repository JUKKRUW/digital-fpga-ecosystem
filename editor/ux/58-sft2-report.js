/* ===== 58. From the SFT2 test report (v2.6.0, qwen3.5-4B-SFT2 through ai_chat) =====================
   What code can fix is fixed here, so the next training round (SFT3) only has to teach what code cannot:
   - "sw0 ถึง sw3 เป็น 1 — err ติดไหม": the model probed sw = 0 and answered "ไม่ติด (sw0..sw3 เป็น 1)". An
     answer after a probe now carries what the probe really set and read (`aiagProbeFacts`), and an answer that
     says on/off against the probe's value is flagged.
   - A sheet re-checked with nothing changed since the last check: the tool answers from the last result and
     tells the model to answer now (SFT2 learned "check + simulate" after every step and looped 3×).
   - simulate of a divider with no `cycles`: 16 clocks cannot show period 25 — a sequential run with an
     output that shows no period is re-run over 256 clocks.
   - The fast path built a library part over `div50` for "แตก div50 เป็น …": a request to change what is
     there (split / replace / edit an existing sheet) never takes the fast path.
   - Sheets the agent may not touch (`project.agentLocked`, the 🔒 in the project tree's menu, MCP lock_sheet). */

/* ---- the fast path is for new things only ---- */
const SR_EDIT_RE=/(แตก|แยก|แทน|ของเดิม|อันเดิม|เปลี่ยน|แก้|ย้าย|ลบ|เอาออก|ต่อเข้า|ต่อกับ|\b(split|replace|instead|rewire|modify|change|edit|remove)\b)/i;
function srNamesExistingSheet(msg){
  const P=Object.values(((state||{}).project||{}).schematics||{}).filter(s=>s.components.some(c=>c.type!=="JUNCTION"));
  return P.find(s=>s.name.length>=3 && new RegExp("(^|[^A-Za-z0-9_])"+s.name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"($|[^A-Za-z0-9_])", "i").test(msg))||null;
}
{
  const _fp=aiagFastPath;
  aiagFastPath=async function(msg, run){
    const ex=srNamesExistingSheet(String(msg||""));
    if(SR_EDIT_RE.test(String(msg||"")) && ex){
      run.steps.push({kind:"nudge", text:`a change to the existing sheet '${ex.name}' — no fast path`});
      return null; }
    return _fp.apply(this, arguments);
  };
}

/* ---- sheets the agent may not touch ---- */
function srLocked(name){
  const L=(((state||{}).project||{}).agentLocked)||[];
  return !!name && L.some(n=>String(n).toLowerCase()===String(name).toLowerCase());
}
const SR_READ_ONLY=new Set(["check","simulate","probe","verify_truth_table","explain_simulation","get_pins","board_check",
  "board_troubleshoot","suggest_wires","list_modules","search_course","get_state","check_spec","derive_spec","compare_sheets","list_parts"]);
{
  const _call=aiagCall;
  aiagCall=async function(tool, args){
    const a=args||{};
    if(!SR_READ_ONLY.has(tool)){
      // which sheets this call writes: the named one, blocks it rebuilds are not written
      const names=[a.sheet, a.name, tool==="build_hierarchy" && !a.sheet && !a.name ? "top" : null].filter(Boolean);
      const hit=names.find(srLocked);
      if(hit) return {ok:false, error:`sheet '${hit}' is locked for the agent (the user locked it) — do not change it; build into a new sheet instead, e.g. sheet:'${hit}_new'`};
    }
    return srRecheck(tool, a, ()=>_call.apply(this, arguments));
  };
}
MCP_OPS.lock_sheet=a=>{
  const sch=mcpSheet(a.sheet), P=state.project, L=P.agentLocked=(P.agentLocked||[]).filter(n=>n.toLowerCase()!==sch.name.toLowerCase());
  if(a.lock!==false) L.push(sch.name);
  try{ snapshot(); }catch(_){}
  try{ renderProjectTree(); }catch(_){}
  return {sheet:sch.name, locked:a.lock!==false, all_locked:L.slice()};
};

/* ---- re-checking what did not change ---- */
const SR_LAST=new Map();                       // tool|sheet|args → {hash, result}
async function srRecheck(tool, a, run){
  if(!/^(check|simulate|check_spec|verify_truth_table)$/.test(tool)) return run();
  const sch=(()=>{ try{ return mcpSheet(a.sheet); }catch(_){ return null; } })();
  if(!sch) return run();
  const key=tool+"|"+sch.name+"|"+JSON.stringify(Object.assign({}, a, {sheet:undefined}));
  const h=sheetHash(sch), prev=SR_LAST.get(key);
  if(prev && prev.hash===h){
    const result=Object.assign({}, prev.result, {unchanged:"(system) Nothing on this sheet changed since you last ran "+tool
      +" with these arguments — this is the same result. Do not run it again: answer the user now."});
    return {ok:true, result}; }
  const r=await run();
  if(r && r.ok) SR_LAST.set(key, {hash:h, result:r.result});
  return r;
}

/* ---- simulate: long enough to see the period ---- */
{
  const _sim=MCP_OPS.simulate;
  MCP_OPS.simulate=a=>{
    const r=_sim(a);
    if(r && r.kind==="sequential" && !a.cycles && !a.vectors && r.summary){
      // no period yet — still constant counts: a ÷25 output has not moved in the first 16 clocks
      const S=Object.values(r.summary), moving=S.some(o=>o.period==null);
      if(moving && (r.clocks||0)<256){
        const r2=_sim(Object.assign({}, a, {cycles:256}));
        r2.note=(r2.note?r2.note+" · ":"")+`run over 256 clocks (no cycles given; ${r.clocks} clocks showed no period)`;
        return r2; } }
    return r;
  };
}

/* ---- the answer after a probe says what the probe saw ---- */
const SR_ON=/(ติด|สว่าง|เป็น\s*1|=\s*1|\bon\b|\bhigh\b|\bis 1\b)/i, SR_OFF=/(ไม่ติด|ดับ|ไม่สว่าง|เป็น\s*0|=\s*0|\boff\b|\blow\b|\bis 0\b)/i;
function srLastProbe(run){
  for(let i=(run.steps||[]).length-1;i>=0;i--){ const s=run.steps[i];
    if(s.kind==="tool" && s.tool==="probe" && s.ok && s.full) return s; }
  return null;
}
function aiagProbeFacts(run, final){
  const p=srLastProbe(run); if(!p) return final;
  const outs=p.full.outputs||{}, ins=p.full.inputs||{};
  const one=v=>v&&typeof v==="object"?v.value:v;
  const t=String(final||""), wrong=[];
  Object.entries(outs).forEach(([n,v])=>{ v=one(v); if(v!==0 && v!==1) return;
    // the sentence(s) that name this output
    const parts=t.split(/[\n.。!?]|(?<=\))\s/).filter(x=>new RegExp("(^|[^A-Za-z0-9_])"+n+"($|[^A-Za-z0-9_])", "i").test(x));
    parts.forEach(x=>{ const off=SR_OFF.test(x), on=!off && SR_ON.test(x);
      if((v===1 && off) || (v===0 && on)) wrong.push(n); }); });
  const fmt=o=>Object.entries(o).map(([k,v])=>`${k}=${one(v)}`).join(", ");
  const line=`\n\n— ผลจาก probe ล่าสุด (แอปอ่านให้): ขาเข้า ${fmt(ins)||"(ทั้งหมด 0)"} → ขาออก ${fmt(outs)}`;
  if(wrong.length){
    run.steps.push({kind:"nudge", text:"the answer contradicts the probe for "+[...new Set(wrong)].join(", ")+" — flagged"});
    return `⚠ คำตอบด้านล่างขัดกับผล probe (${[...new Set(wrong)].map(n=>n+"="+one(outs[n])).join(", ")}) — เชื่อผล probe`+line+"\n\n"+t; }
  return t+line;
}
{
  // keep the probe's own answer on the step (st.result is clipped text)
  const _probe=MCP_OPS.probe;
  MCP_OPS.probe=a=>{ const r=_probe(a); SR_PROBE_LAST.r=r; return r; };
}
const SR_PROBE_LAST={r:null};
{
  const _line=aiagLine;
  aiagLine=function(html, kind){
    // the step that was just pushed: attach the full probe answer to it
    const run=AIAG.cur, s=run && run.steps && run.steps[run.steps.length-1];
    if(s && s.tool==="probe" && s.ok && SR_PROBE_LAST.r && !s.full){ s.full={inputs:SR_PROBE_LAST.r.inputs, outputs:SR_PROBE_LAST.r.outputs}; SR_PROBE_LAST.r=null; }
    return _line.apply(this, arguments);
  };
}
{
  const _fg=aiagFactGuard;
  aiagFactGuard=function(run, final){ return aiagProbeFacts(run, _fg.apply(this, arguments)); };
}

/* 🔒 in the project tree: click toggles whether the agent may change that sheet */
{
  const _tree=renderProjectTree;
  renderProjectTree=function(){ const r=_tree.apply(this, arguments);
    try{ const P=state.project; if(!P) return r;
      document.querySelectorAll(`#projectPane .tree-item.sch[data-open][data-prj="${state.activeProjectId}"]`).forEach(el=>{
        const s=P.schematics[el.dataset.open]; if(!s || el.querySelector(".sr-lock")) return;
        const on=srLocked(s.name), b=document.createElement("span");
        b.className="sr-lock"+(on?" on":""); b.textContent=on?"🔒":"🔓";
        b.title=on?"เอเจนต์ห้ามแก้แผ่นนี้ — คลิกเพื่อปลดล็อก":"คลิกเพื่อล็อก: เอเจนต์ห้ามแก้แผ่นนี้";
        b.addEventListener("click", e=>{ e.stopPropagation(); MCP_OPS.lock_sheet({sheet:s.name, lock:!srLocked(s.name)}); });
        el.appendChild(b); }); }catch(e){ console.warn("sheet lock", e); }
    return r; };
}

/* the Issues pane said "ไม่พบปัญหา" while the stepper counted a warning: the pane showed only the core
   check, the stepper uxQuietIssues (core + 39-drc). Both now list the same issues. */
{
  const _re=renderErrors;
  renderErrors=function(list){
    let L=list||[];
    // the same list the stepper counts (39-drc deduplicates against the core's own messages)
    try{ const all=uxQuietIssues(); L=L.concat(all.filter(i=>!L.some(b=>b.schId===i.schId && b.msg===i.msg))); }catch(_){}
    return _re.call(this, L);
  };
}
