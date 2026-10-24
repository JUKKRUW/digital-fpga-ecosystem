/* ===== 59. From the v2.7.1 test report (SFT2 through ai_chat, 12 rated runs) ===========================
   N1 a question ("แผ่น div50 ตอนนี้หารกี่เท่า เช็คให้หน่อย") made the agent rebuild div50: a run whose request
      only asks is read-only — tools that change a sheet answer an error.
   N2 the format fixer still fired mid-run (set_top_sheet top_new, check after the work): it now runs only
      before the first successful tool call, and set_top_sheet is the agent's only when the request names the top.
   N3 the probe check looked at outputs only: the request's own bit values ("sw0 ถึง sw3 เป็น 1") are compared
      with what the probe was given; on a mismatch the app probes again with the requested values.
   N4 the oracle took "÷5" from "ทำแผ่น div5 (หาร 5) … div50 เอา div5 มาต่อ" and put it on div50: a request
      naming several sheets gets no auto-attached oracle.
   N5 "not verified yet (simulate …)" after a rename / pin change: those are not logic changes (18).
   N6 the fast path answered "ทำ mux … แล้วลองเทสว่า …" with the build only: when the request asks for more
      (simulate / test / a value), the built part goes to the model as a note and the run goes on.
   N7 "⚠ ไม่ได้เรียกเครื่องมือเลย" on a plain question: only when the answer claims a check it did not run.
   N8 set_spec "clk_out = clk_in / 25" → the divider's own acceptance test (part clock_divider n=25).
   N9 "ขึ้นทุก 50 clock" when the simulation showed period 25: claimed periods / ratios are compared with the
      run's simulate summaries. */

/* ---- N1: a question changes nothing ---- */
const QA_ASK_RE=/(กี่|เท่าไร|เท่าไหร่|ไหม|หรือเปล่า|รึเปล่า|ยังไง|อย่างไร|ทำไม|อธิบาย|เช็ค|เช็ก|ตรวจดู|ดูให้|คืออะไร|[?？]|\b(how many|what|why|explain|check)\b)/i;
function qaReadOnly(msg){
  const t=String(msg||"");
  return QA_ASK_RE.test(t) && !(typeof aiagWantsChange==="function" && aiagWantsChange(t));
}
const QA_WRITE_TOOLS=/^(build_|vhdl_block$|delete|disconnect$|connect$|add_component$|update_component$|apply$|make_bus_ports$|new_sheet$|set_pins$|auto_pins$|pin_preset$|set_top_sheet$|set_spec$|undo$|use_module$|save_module$|rename_)/;
{
  const _call=aiagCall;
  aiagCall=async function(tool, args){
    const run=AIAG.cur, a=args||{};
    if(run && qaReadOnly(run.message) && (QA_WRITE_TOOLS.test(tool) || (tool==="derive_spec" && a.sheet))){
      run.steps.push({kind:"nudge", text:`${tool} refused — the request only asks a question`});
      return {ok:false, error:`the user only ASKED a question — do not change any sheet (${tool} is refused). Find the answer with get_sheet / check / simulate / probe and answer in Thai.`}; }
    if(tool==="set_top_sheet" && run && !/(top|ตัวบนสุด|แผ่นหลัก|ชั้นบนสุด)/i.test(run.message||""))
      return {ok:false, error:"the request does not ask to change the top sheet — leave it as it is"};
    if(tool==="set_top_sheet" && typeof srLocked==="function"){
      const cur=Object.values(state.project.schematics).find(s=>s.id===state.project.topId);
      if(cur && srLocked(cur.name)) return {ok:false, error:`the top sheet '${cur.name}' is locked for the agent — the top stays as it is`}; }
    return _call.apply(this, arguments);
  };
}

/* ---- N2: the format fixer only before any work ---- */
{
  const _u=aiagStructuredUnsafe;
  aiagStructuredUnsafe=function(run, tool, args){
    if((run.steps||[]).some(x=>x.kind==="tool" && x.ok && !x.fast_path)) return "the run already did work — no call is written for it any more";
    if(/^(set_top_sheet|undo|lock_sheet)$/.test(tool)) return tool+" is never written for the model";
    return _u.apply(this, arguments);
  };
}

/* ---- N3: the probe's inputs against the request's ---- */
function qaRequestedBits(msg, inputNames){
  const names=new Map(inputNames.map(n=>[n.toLowerCase(), n])), want={};
  const t=String(msg||"");
  // ranges: "sw0 ถึง sw3 เป็น 1", "sw0-sw3 = 1", "sw0..3 เป็น 1"
  for(const m of t.matchAll(/([A-Za-z_]+)(\d+)\s*(?:ถึง|-|–|to|\.\.)\s*(?:[A-Za-z_]+)?(\d+)\s*(?:ให้)?\s*(?:เป็น|=|:)\s*([01])/gi)){
    const lo=Math.min(+m[2], +m[3]), hi=Math.max(+m[2], +m[3]);
    for(let i=lo;i<=hi;i++){ const n=names.get((m[1]+i).toLowerCase()); if(n) want[n]=+m[4]; } }
  // singles: "a=1", "s เป็น 1"
  for(const m of t.matchAll(/(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|เป็น)\s*([01])(?![0-9])/g)){
    const n=names.get(m[1].toLowerCase()); if(n && !(n in want)) want[n]=+m[2]; }
  return want;
}
function qaProbeInputsCheck(run, final){
  const p=typeof srLastProbe==="function" ? srLastProbe(run) : null; if(!p || !p.full) return final;
  const sheetName=(p.args||{}).sheet; let sch=null; try{ sch=mcpSheet(sheetName); }catch(_){ return final; }
  const ins=sch.components.filter(c=>c.type==="IN" && (c.params.width||1)===1).map(c=>c.params.name);
  const want=qaRequestedBits(run.message, ins); if(!Object.keys(want).length) return final;
  const got=p.full.inputs||{}, val=n=>{ const k=Object.keys(got).find(x=>x.toLowerCase()===n.toLowerCase()); const v=k!=null?got[k]:0; return +(v&&typeof v==="object"?v.value:v)||0; };
  const wrong=Object.entries(want).filter(([n,v])=>val(n)!==v);
  if(!wrong.length) return final;
  let redo=null; try{ redo=MCP_OPS.probe({sheet:sch.name, inputs:want}); }catch(_){}
  const one=v=>v&&typeof v==="object"?v.value:v;
  run.steps.push({kind:"nudge", text:"the probe was not given the request's values ("+wrong.map(([n,v])=>`${n}=${v}`).join(", ")+") — the app probed again"});
  const line=redo ? " แอปลองใหม่ด้วยค่าที่ขอ: "+Object.entries(want).map(([n,v])=>`${n}=${v}`).join(", ")+" (ที่เหลือ 0) → "+Object.entries(redo.outputs||{}).map(([n,v])=>`${n}=${one(v)}`).join(", ") : "";
  return `⚠ probe ไม่ได้ป้อนค่าตามคำขอ (${wrong.map(([n,v])=>`${n} ควรเป็น ${v} แต่ป้อน ${val(n)}`).join(", ")}) — คำตอบด้านล่างจึงผิดได้.${line}\n\n`+String(final||"");
}
{
  const _fg=aiagFactGuard;
  aiagFactGuard=function(run, final){ const t=_fg.apply(this, arguments); return /^⚠ probe ไม่ได้ป้อน/.test(t) ? t : qaProbeInputsCheck(run, t); };
}

/* ---- N4: no auto-attached oracle when the request names several sheets ---- */
function qaSheetsNamed(msg){
  const names=new Set();
  for(const m of String(msg||"").matchAll(/(?:แผ่น|ชีต|ชีท|sheet)\s*(?:ใหม่\s*)?(?:ชื่อ\s*)?[`"'“]?([A-Za-z_][A-Za-z0-9_]*)/gi)) names.add(m[1].toLowerCase());
  return names;
}
{
  const _oa=aiagOracleAfter;
  aiagOracleAfter=function(run, tool, r){
    if(run && run.oracle && qaSheetsNamed(run.message).size>=2){
      if(!run.oracleDropped){ run.oracleDropped=true; run.steps.push({kind:"nudge", text:"the request names several sheets — the derived test is not put on any one of them"}); }
      const keep=run.oracle; run.oracle=null;
      try{ return _oa.apply(this, arguments); } finally{ run.oracle=keep; } }
    return _oa.apply(this, arguments);
  };
}

/* ---- N6: the fast path does not drop the rest of the request ---- */
const QA_MORE_RE=/(จำลอง|simulate|เทส|ทดสอบ|ลองป้อน|ลองใส่|ลองดู|probe|ถ้า.+(เท่าไร|เท่าไหร่|ไหม)|ออกเท่าไร|ออกเท่าไหร่|ให้ดู)/i;
{
  const _fp=aiagFastPath;
  aiagFastPath=async function(msg, run){
    const r=await _fp.apply(this, arguments);
    if(r && r.final && QA_MORE_RE.test(String(msg||""))){
      run.steps.push({kind:"nudge", text:"the request asks for more than the part — the model does the rest"});
      return {note:"(system) "+r.final.replace(/\n/g," ")+" — the part is built and verified; do not rebuild it. "
        +"Now do the REST of the request (simulate / probe what the user asked, with the values they gave) and answer from those results."}; }
    return r;
  };
}

/* ---- N7: a plain question needs no tool ---- */
{
  const _g=aiagNoWorkGuard;
  aiagNoWorkGuard=function(run, final, didWork, wantsChange){
    if(!didWork && !wantsChange && !/(ตรวจแล้ว|จำลองแล้ว|ทดสอบแล้ว|ลองแล้ว|ผ่านการตรวจ|\b(verified|simulated|tested)\b)/i.test(String(final||""))) return final;
    return _g.apply(this, arguments);
  };
}

/* ---- N8: a divider written as a formula ---- */
{
  const _ss=MCP_OPS.set_spec;
  MCP_OPS.set_spec=a=>{
    const f=Array.isArray(a.formula) ? a.formula.join("; ") : a.formula;
    const m=f!=null && /^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\/\s*(\d+)\s*;?\s*$/.exec(String(f));
    if(m){
      const n=+m[3]; if(n<2) mcpFail("a clock is divided by 2 or more");
      const o=oracleDerive(`ตัวหารความถี่ ${n}`);
      if(!o.ok || !o.spec || o.spec.kind!=="part") mcpFail(`'${f}' is a clock divider — check it with simulate (summary.period = ${n})`);
      const sch=mcpSheet(a.sheet);
      const ports=schPortList(sch).map(p=>p.id);
      if(!ports.includes("clk_in") || !ports.includes("clk_out"))
        mcpFail(`a divider spec needs ports clk_in / clk_out (this sheet has ${ports.join(", ")})`, `or check it with simulate {cycles:${2*n+4}} and read summary.period`);
      mcpBeforeChange("ข้อกำหนด ÷"+n); const res=oracleAttach(sch, o); sch.specSource="spec-first"; mcpCommit(sch);
      try{ renderProjectTree(); }catch(_){}
      return {sheet:sch.name, spec:`${m[1]} = ${m[2]} ÷ ${n} (checked clock by clock against a reference divider)`, result:res};
    }
    return _ss(a);
  };
}

/* ---- N9: periods and ratios in the answer against the simulation ---- */
function qaPeriodCheck(run, final){
  const t=String(final||""); if(/^⚠/.test(t)) return t;
  const periods=new Set();
  (run.steps||[]).forEach(s=>{ if(s.kind==="tool" && s.tool==="simulate" && s.ok) for(const m of String(s.result||"").matchAll(/"period":(\d+)/g)) periods.add(+m[1]); });
  if(!periods.size) return t;
  const bad=[];
  for(const m of t.matchAll(/(?:ขึ้น|กลับมาขึ้น|สลับ)?ทุก\s*(\d+)\s*(?:clock|คล็อก|รอบ)|หาร\s*(\d+)(?!\s*(?:ตัว|บิต))|period\s*(\d+)/gi)){
    const n=+(m[1]||m[2]||m[3]); if(!(n>1) || periods.has(n)) continue;
    // "หาร 5 → หาร 10" inside a chain: a factor of a seen period is a stage, not a claim about the output
    if(m[2] && [...periods].some(p=>p%n===0)) continue;
    bad.push(m[0].trim()); }
  if(!bad.length) return t;
  run.steps.push({kind:"nudge", text:"periods in the answer differ from the simulation: "+bad.join(", ")});
  return `⚠ คำตอบบอก ${[...new Set(bad)].map(x=>`“${x}”`).join(", ")} แต่การจำลองในรอบนี้เห็นคาบ ${[...periods].join(", ")} clock — เชื่อผลจำลอง\n\n`+t;
}
{
  const _fg=aiagFactGuard;
  aiagFactGuard=function(run, final){ return qaPeriodCheck(run, _fg.apply(this, arguments)); };
}
