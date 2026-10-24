/* ===== 60. From the SFT3 test report (v2.7.2, qwen3.5-4B-SFT3) ===========================================
   N8  a divider's test is its PERIOD: spec kind `period` {port, n} (set_spec "clk_out = clk_in / 25" or "÷ 25").
       The 2.7.2 spec compared clock by clock with one reference divider, and div5 → div5 (period 25, other phase)
       failed it — the model kept rewriting the spec. A clock_divider part spec is checked the same way now.
   N10 the probe check flagged "err = 1 (ติด)" because the same sentence said "sw4 = 0": an output's state is
       read right after its name ("err = 1", "err ติด"), not anywhere in the sentence.
   N12 the 🩺 board verdict only for runs that changed a sheet or asked about the board.
   N13 after the fast path built the part, the model built it again (mux, cnt10 → cnt10b): the note now says
       what is left to do, and a second build in that run is refused.
   ai_chat that did not start a run (sent right after a project switch) answers an error instead of
       "started" — the caller used to read the previous run's status.
   (N11 — no "not verified" nudge after a passing verify_truth_table / check_spec — is in 18.) */

/* ---- N8: the period of a clock output ---- */
function spPeriodOf(sch, port, n){
  const cycles=Math.min(256, 3*n+8);
  let r; try{ r=MCP_OPS.simulate({sheet:sch.name, cycles}); }catch(e){ return {err:String(e&&e.message||e)}; }
  const o=((r && r.summary)||{})[port];
  return o ? {period:o.period, duty:o.duty, cycles} : {err:`no output '${port}'`};
}
{
  const _sc=specCheck;
  specCheck=function(sch){
    const sp=sch && sch.spec;
    const per=sp && (sp.kind==="period" ? {port:sp.port||"clk_out", n:+sp.n}
      : sp.kind==="part" && sp.part==="clock_divider" ? {port:"clk_out", n:+(sp.params||{}).n} : null);
    if(per && sch.components.some(c=>c.type!=="JUNCTION")){
      if(!(per.n>=2)) return {pass:false, reason:"N ต้องเป็น 2 ขึ้นไป"};
      if(3*per.n+8>256) return {pass:null, reason:`÷${per.n} ต้องจำลองเกิน 256 clock — เทียบไม่ได้ทีละ clock`,
        hint:"build the same structure at a small N and check that, or check each stage: a chain of dividers divides by the product of their periods"};
      const p=spPeriodOf(sch, per.port, per.n);
      if(p.err) return {pass:false, reason:p.err};
      if(p.period===per.n) return {pass:true, checked:`${per.port} คาบ ${p.period} clock (จำลอง ${p.cycles} clock)`+(p.duty!=null?` · duty ${Math.round(p.duty*100)} %`:"")};
      return {pass:false, reason:p.period ? `${per.port} คาบ ${p.period} clock — ต้องเป็น ${per.n}` : `${per.port} ยังไม่เห็นคาบใน ${p.cycles} clock (ต้องเป็น ${per.n})`,
        mismatches:[{output:per.port, want_period:per.n, got_period:p.period}], total_mismatches:1};
    }
    return _sc.apply(this, arguments);
  };
  const _sd=specDescribe;
  specDescribe=function(sp){ return sp && sp.kind==="period" ? `${sp.port||"clk_out"} คาบ ${sp.n} clock (หาร ${sp.n})` : _sd.apply(this, arguments); };
}
{
  const _ss=MCP_OPS.set_spec;
  MCP_OPS.set_spec=a=>{
    const f=Array.isArray(a.formula) ? a.formula.join("; ") : a.formula;
    const m=f!=null && /^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*(?:\/|÷|div)\s*(\d+)\s*;?\s*$/i.exec(String(f));
    if(!m) return _ss(a);
    const n=+m[3]; if(n<2) mcpFail("a clock is divided by 2 or more");
    const sch=mcpSheet(a.sheet), outs=schPortList(sch).filter(p=>p.dir==="out").map(p=>p.id);
    if(outs.length && !outs.includes(m[1])) mcpFail(`no output '${m[1]}' on ${sch.name} (outputs: ${outs.join(", ")})`);
    mcpBeforeChange("ข้อกำหนด ÷"+n);
    sch.spec={kind:"period", port:m[1], n}; sch.specSource="spec-first"; delete sch.specResult;
    const res=specRun(sch); mcpCommit(sch);
    try{ renderProjectTree(); }catch(_){}
    return {sheet:sch.name, spec:`${m[1]} = ${m[2]} ÷ ${n}: ${m[1]} must repeat every ${n} clocks`, result:res};
  };
}

/* ---- N10: an output's state is read right after its name ---- */
aiagProbeFacts=function(run, final){
  const p=typeof srLastProbe==="function" ? srLastProbe(run) : null; if(!p) return final;
  const outs=p.full.outputs||{}, ins=p.full.inputs||{}, one=v=>v&&typeof v==="object"?v.value:v;
  const t=String(final||""), wrong=[];
  Object.entries(outs).forEach(([n,v])=>{ v=one(v); if(v!==0 && v!==1) return;
    const re=new RegExp("(?:^|[^A-Za-z0-9_])"+n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(?![A-Za-z0-9_])\\s*(?:\\(|ก็|จะ|ถึง)?\\s*(=|:|เป็น)?\\s*([01])?\\s*(ไม่ติด|ไม่สว่าง|ดับ|ติด|สว่าง)?", "gi");
    for(const m of t.matchAll(re)){
      const said=m[2]!=null ? +m[2] : m[3] ? (/ไม่|ดับ/.test(m[3]) ? 0 : 1) : null;
      if(said!=null && said!==v) wrong.push(n); } });
  const fmt=o=>Object.entries(o).map(([k,v])=>`${k}=${one(v)}`).join(", ");
  const line=`\n\n— ผลจาก probe ล่าสุด (แอปอ่านให้): ขาเข้า ${fmt(ins)||"(ทั้งหมด 0)"} → ขาออก ${fmt(outs)}`;
  if(wrong.length){
    const W=[...new Set(wrong)];
    run.steps.push({kind:"nudge", text:"the answer gives "+W.join(", ")+" another value than the probe — flagged"});
    return `⚠ คำตอบด้านล่างบอกค่าขาออกไม่ตรงกับผล probe (${W.map(n=>n+"="+one(outs[n])).join(", ")}) — เชื่อผล probe`+line+"\n\n"+t; }
  return t+line;
};

/* ---- N12: the board verdict where the board is the subject ---- */
{
  const _bv=aiagBoardVerdict;
  aiagBoardVerdict=function(run){
    const touched=run.touched && run.touched.size, asked=/(ลงบอร์ด|บนบอร์ด.*(ได้|พร้อม)|พร้อม.*บอร์ด|\.bit|โปรแกรมลง|program|board)/i.test(String(run.message||""));
    // an answer that itself says the design is ready for the board gets the doctor's verdict too
    const claims=/(พร้อมลงบอร์ด|ลงบอร์ดได้|พร้อม.{0,10}(บอร์ด|\.bit)|ready for the board)/i.test(String(run.final||""));
    return touched || asked || claims ? _bv.apply(this, arguments) : "";
  };
}

/* ---- N13: the rest of the request, by name; no second build ---- */
{
  const _fp=aiagFastPath;
  aiagFastPath=async function(msg, run){
    const r=await _fp.apply(this, arguments);
    if(r && r.note && /do the REST of the request/.test(r.note)){
      const st=[...run.steps].reverse().find(x=>x.tool==="build_part" && x.ok && x.fast_path);
      const sheet=st && (st.summary||"").replace(/^sheet (\S+).*$/, "$1");
      run.fastBuilt=sheet||null;
      let ports=""; try{ const s=mcpSheet(sheet); ports=schPortList(s).map(p=>(p.dir==="in"?"in ":"out ")+p.id+(p.width>1?`[${p.width-1}:0]`:"")).join(", "); }catch(_){}
      const T=String(msg||"");
      const what=/(จำลอง|simulate|ให้ดู)/i.test(T) ? `simulate {sheet:'${sheet}'${/นับ|counter|หาร|divid/i.test(T)?", cycles:40":""}} and report what it shows`
        : `probe {sheet:'${sheet}', inputs:{…the values the user gave, on these port names…}} and report the outputs`;
      return {note:`(system) The app ALREADY built and verified the part on sheet '${sheet}' (ports: ${ports}). Do NOT build it again. `
        +`The rest of the request is: "${T}". Do it now: ${what}. Then answer in Thai from that result.`};
    }
    return r;
  };
  const _call=aiagCall;
  aiagCall=async function(tool, args){
    const run=AIAG.cur;
    if(run && run.fastBuilt && /^build_(part|circuit|fsm)$/.test(tool))
      return {ok:false, error:`the app already built the part on sheet '${run.fastBuilt}' in this run — do not build again. Do the rest of the request on '${run.fastBuilt}' (simulate / probe) and answer.`};
    return _call.apply(this, arguments);
  };
}

/* ---- ai_chat that did not start a run says so ---- */
{
  const _ac=MCP_OPS.ai_chat;
  MCP_OPS.ai_chat=async a=>{
    const before=AIAG.seq, r=_ac(a);
    if(AICHAT.mode!=="agent") return r;
    const until=Date.now()+5000;
    while(AIAG.seq===before && !(AIAG.capture && AIAG.capture.done) && Date.now()<until) await new Promise(res=>setTimeout(res, 100));
    if(AIAG.seq===before){
      const cap=AIAG.capture||{};
      mcpFail("the chat did not start a run"+(cap.error?": "+cap.error:"")+" — nothing was sent to the model",
        "call ai_chat again (the editor was busy, e.g. right after a project switch)");
    }
    return Object.assign({}, r, {run_id:AIAG.seq});
  };
}
