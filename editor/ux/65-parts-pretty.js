/* ===== 65. Parts drawn the way a person would split them ===========================================
   From the user's review of the library:
   - ÷5000 drew one 12-bit counter. A big N now splits into stages of ≤ 10 (5000 = ÷5 → ÷10 → ÷10 → ÷10,
     odd stages first so the last one gives 50 % duty): part `divider_chain`, and the divider form / Tools ▸
     หารความถี่ use it for N > 16 when N factors that way.
   - parts that have a natural cell are built from blocks of that cell (`blocks`): the N-bit adder from
     half / full adders, the subtractor from half / full subtractors, the comparator from 1-bit cascade cells
     (`cmp_slice`, like the 7485), and a new array multiplier from AND rows + adder blocks.
   - counter_digit (and the multi-digit counters made of it) can use the flip-flops' asynchronous reset /
     preset (`async`): clr goes to every rst pin, the count runs as a plain binary up/down counter and the
     first state past the end (m when counting up, all ones when counting down) resets / presets it at once —
     the textbook "reset at N" counter, a third of the gates of the synchronous one.
   The form (24) starts `blocks` / `async` ON (`uiDef`); over MCP / the agent they default OFF, so what the
   in-app model was trained on stays the same. */

/* the new on/off settings (quiet) are left out of a part's params while off: build_part answers, sheet names
   (ptSub) and the agent's view stay exactly as before */
{
  const _pp=partParams;
  partParams=function(kind){ const p=_pp.apply(this, arguments), P=PARTS[kind];
    Object.entries((P&&P.params)||{}).forEach(([k,s])=>{ if(s.quiet && p[k]===s.def) delete p[k]; }); return p; };
}
/* ---- ÷N as a chain of small dividers ---- */
function divFactors(n, max){
  max=max||10; n=Math.floor(+n); if(!(n>=2)) return null;
  const pr=[]; let x=n;
  for(let f=2; f*f<=x; f++) while(x%f===0){ pr.push(f); x/=f; }
  if(x>1) pr.push(x);
  if(pr.some(f=>f>max)) return null;
  // pair 2 × 5 into 10s, pack the rest first-fit decreasing into stages ≤ max
  const c2=pr.filter(f=>f===2).length, c5=pr.filter(f=>f===5).length, tens=Math.min(c2, c5);
  const R=[...Array(c2-tens).fill(2), ...Array(c5-tens).fill(5), ...pr.filter(f=>f!==2 && f!==5)].sort((a,b)=>b-a);
  const bins=[];
  R.forEach(f=>{ const b=bins.find(b=>b.v*f<=max); if(b) b.v*=f; else bins.push({v:f}); });
  const st=bins.map(b=>b.v).concat(Array(tens).fill(10));
  // odd stages first, then the even ones, the 10s last: the output stage is even → 50 % duty
  return st.sort((a,b)=>((a%2===0)-(b%2===0)) || ((a===10)-(b===10)) || (a-b));
}
function divStagesOf(p){
  const t=String(p.stages||"").trim();
  if(!t) return divFactors(p.n) || [p.n];
  const L=(t.match(/\d+/g)||[]).map(Number);
  return L;
}
function divChainCheck(v){
  const t=String(v||"").trim(); if(!t) return null;
  const L=(t.match(/\d+/g)||[]).map(Number);
  if(!L.length) return "write the stages as numbers, e.g. 5,10,10,10";
  if(L.some(x=>x<2)) return "every stage divides by 2 or more";
  return null;
}
/* the ripple chain, clock by clock: a stage moves when the one before it rises */
function divChainStep(stages, S){
  const outs=S.map((s,k)=>sysDivStep(stages[k], s).out);
  const nx=S.slice();
  for(let k=0;k<stages.length;k++){
    const o=sysDivStep(stages[k], nx[k]); nx[k]={c:o.c, t:o.t};
    const now=sysDivStep(stages[k], nx[k]).out;
    if(!(now===1 && outs[k]===0)) break;            // no rising edge → the next stage does not move
  }
  return {out:outs[outs.length-1], state:nx};
}
Object.assign(PARTS, {
  divider_chain:{ label:"หารความถี่ ÷N แบบหลายขั้น", group:"นาฬิกา / หารความถี่",
    desc:"N ใหญ่ (เช่น 5000 = ÷5 → ÷10 → ÷10 → ÷10) แบ่งเป็นตัวหารเล็กต่อกันเป็นทอด ๆ ให้อัตโนมัติ — วงจรเล็กและอ่านง่ายกว่าตัวนับใหญ่ตัวเดียว · stages = กำหนดเองได้ (ผลคูณต้องเท่ากับ N) · ขั้นสุดท้ายเป็นเลขคู่ = duty 50%",
    params:{n:{min:2,max:2147483648,def:5000}, stages:{text:true, def:"", check:divChainCheck}},
    ports:()=>({in:{clk_in:1}, out:{clk_out:1}}),
    plan:p=>{ const L=divStagesOf(p); if(!L || L.reduce((a,b)=>a*b,1)!==p.n) return `แบ่ง ${L?L.join(" × "):"?"} ≠ ${p.n}`;
      return L.length>1 ? `÷${p.n} = ${L.map(x=>"÷"+x).join(" → ")} (${L.length} ขั้น)` : `÷${p.n} แบ่งเป็นตัวหาร ≤ 10 ไม่ได้ (มีตัวประกอบเฉพาะ > 10) — ทำเป็นขั้นเดียว`; },
    build:p=>{ const L=divStagesOf(p);
      if(L.reduce((a,b)=>a*b,1)!==p.n) throw new Error(`stages ${L.join("×")} = ${L.reduce((a,b)=>a*b,1)}, not ${p.n}`);
      const t=ptIntent("div"+p.n), clk=t.IN("clk_in"); let prev=clk;
      L.forEach(f=>{ const b=ptBlock(t, ptSub("clock_divider", {n:f})); t.W(prev, b+".clk_in"); prev=b+".clk_out"; });
      t.OUT("clk_out", prev); return t; },
    // ≤ 64: the chain itself, clock by clock; bigger: the same generator on its first and last stage
    seq:p=>{ const L=divStagesOf(p), P=L.reduce((a,b)=>a*b,1);
      if(P>64){ const f=L.length>1?[L[0], L[L.length-1]]:[p.n%2?63:62];
        if(f.length===1) return {small:{n:f[0], stages:""}};
        let sm=f; if(sm[0]*sm[1]>64) sm=[sm[0]%2?3:2, sm[1]%2?5:10];
        return {small:{n:sm[0]*sm[1], stages:sm.join(",")}}; }
      return {cycles:Math.min(3*P+4, 200), init:L.map(()=>({c:0,t:0})), drive:()=>({}), step:s=>divChainStep(L, s)}; } },

  cmp_slice:{ label:"ตัวเปรียบเทียบ 1 บิต (ต่อเป็นทอด)", group:"เปรียบเทียบ / ตรวจสอบ",
    desc:"เทียบ a กับ b หนึ่งบิต ต่อจากบิตที่สูงกว่า: gt = gt_in + eq_in·a·b' · lt = lt_in + eq_in·a'·b · eq = eq_in·(a⊙b) — บิตสูงสุดใส่ gt_in = 0, eq_in = 1, lt_in = 0 (แบบ 7485)",
    ports:()=>({in:{a:1, b:1, gt_in:1, eq_in:1, lt_in:1}, out:{gt:1, eq:1, lt:1}}),
    ref:v=>({gt:v.gt_in|(v.eq_in&v.a&(1-v.b)), lt:v.lt_in|(v.eq_in&(1-v.a)&v.b), eq:v.eq_in&(v.a===v.b?1:0)}),
    build:()=>{ const t=ptIntent("cmp_slice"), a=t.IN("a"), b=t.IN("b"), gi=t.IN("gt_in"), ei=t.IN("eq_in"), li=t.IN("lt_in");
      t.OUT("gt", t.G("OR",[gi, t.G("AND",[ei, a, t.G("NOT",[b])])]));
      t.OUT("eq", t.G("AND",[ei, t.G("XNOR",[a, b])]));
      t.OUT("lt", t.G("OR",[li, t.G("AND",[ei, t.G("NOT",[a]), b])])); return t; } },

  multiplier:{ label:"ตัวคูณ n × m บิต (array multiplier)", group:"บวก / ลบ / คูณ",
    desc:"p = a × b · ผลคูณย่อย a·bᵢ ด้วย AND แล้วบวกทีละแถวด้วยตัวบวก (บล็อก) แบบในตำรา · n, m = 1..4 บิต → p มี n + m บิต",
    params:{n:{min:1,max:4,def:4}, m:{min:1,max:4,def:4}},
    ports:p=>({in:{a:p.n, b:p.m}, out:{p:p.n+p.m}}),
    ref:(v,p)=>({p:v.a*v.b}),
    build:p=>{ const t=ptIntent(`mult${p.n}x${p.m}`), A=[], B=[];
      for(let i=p.n-1;i>=0;i--) A[i]=t.IN("a"+i);
      for(let i=p.m-1;i>=0;i--) B[i]=t.IN("b"+i);
      const pp=i=>A.map(a=>t.G("AND",[a, B[i]]));
      let acc=pp(0);                                   // bits 0 … n−1 of the running sum
      const add=p.n>1 ? ptSub("adder", {n:p.n, cin:false, blocks:true}) : null;
      for(let i=1;i<p.m;i++){
        const row=pp(i);
        if(!add){ acc[i]=row[0]; continue; }             // 1 × m bits: each product bit is one AND
        const b=ptBlock(t, add);
        for(let j=0;j<p.n;j++){ t.W(acc[i+j]!=null ? acc[i+j] : t.X("GND"), b+".a"+j); t.W(row[j], b+".b"+j); }
        for(let j=0;j<p.n;j++) acc[i+j]=b+".s"+j;
        acc[i+p.n]=b+".cout";
      }
      for(let k=0;k<p.n+p.m;k++) t.OUT("p"+k, acc[k]!=null ? acc[k] : t.X("GND"));
      return t; } },
});

/* ---- built from blocks: adder, subtractor, comparator ---- */
{
  const addBlocks=(kind, fn)=>{
    const P=PARTS[kind], _b=P.build;
    P.params=Object.assign({}, P.params, {blocks:{bool:true, def:false, uiDef:true, quiet:true}});
    P.build=p=>p.blocks && p.n>1 ? fn(p) : _b(p);
  };
  addBlocks("adder", p=>{ const t=ptIntent("adder"+p.n), A=[], B=[];
    for(let i=p.n-1;i>=0;i--){ A[i]=t.IN("a"+i); B[i]=t.IN("b"+i); }
    let c=p.cin ? t.IN("cin") : null;
    const fa=ptSub("full_adder");
    for(let i=0;i<p.n;i++){
      if(c==null){ const h=ptBlock(t, ptSub("half_adder")); t.W(A[i], h+".a"); t.W(B[i], h+".b"); t.OUT("s"+i, h+".sum"); c=h+".carry"; continue; }
      const b=ptBlock(t, fa); t.W(A[i], b+".a"); t.W(B[i], b+".b"); t.W(c, b+".cin"); t.OUT("s"+i, b+".sum"); c=b+".cout"; }
    t.OUT("cout", c); return t; });
  addBlocks("subtractor", p=>{ const t=ptIntent("subtractor"+p.n), A=[], B=[];
    for(let i=p.n-1;i>=0;i--){ A[i]=t.IN("a"+i); B[i]=t.IN("b"+i); }
    const hs=ptBlock(t, ptSub("half_subtractor")); t.W(A[0], hs+".a"); t.W(B[0], hs+".b"); t.OUT("d0", hs+".diff");
    let c=hs+".borrow"; const fs=ptSub("full_subtractor");
    for(let i=1;i<p.n;i++){ const b=ptBlock(t, fs); t.W(A[i], b+".a"); t.W(B[i], b+".b"); t.W(c, b+".bin"); t.OUT("d"+i, b+".diff"); c=b+".bout"; }
    t.OUT("bout", c); return t; });
  addBlocks("comparator", p=>{ const t=ptIntent("comparator"+p.n), A=[], B=[];
    for(let i=p.n-1;i>=0;i--){ A[i]=t.IN("a"+i); B[i]=t.IN("b"+i); }
    const cs=ptSub("cmp_slice");
    let g=t.X("GND"), e=t.X("VCC"), l=t.X("GND");
    for(let i=p.n-1;i>=0;i--){ const b=ptBlock(t, cs);           // from the top bit down, like the 7485 cascade
      t.W(A[i], b+".a"); t.W(B[i], b+".b"); t.W(g, b+".gt_in"); t.W(e, b+".eq_in"); t.W(l, b+".lt_in");
      g=b+".gt"; e=b+".eq"; l=b+".lt"; }
    t.OUT("eq", e); t.OUT("gt", g); t.OUT("lt", l); return t; });
}

/* ---- counter_digit with the flip-flops' asynchronous reset / preset ---- */
function cdAsyncBuild(p){
  const w=ptLen(p.m-1), t=ptIntent((p.down?"down":"up")+"_digit_m"+p.m+"_async"), clk=t.IN("clk"), en=t.IN("en"), clr=t.IN("clr");
  const ld=p.load?t.IN("load"):null, D=p.load?Array.from({length:w},(_,i)=>t.IN("d"+i)):null;
  const full=p.m===(1<<w), T=p.down ? (1<<w)-1 : p.m;           // the first state past the end (momentary)
  const target=p.down ? p.m-1 : 0, presetBits=full ? [] : Array.from({length:w},(_,i)=>i).filter(i=>(target>>i)&1);
  const F=Array.from({length:w},(_,i)=>t.X("DFF",{params:{reset:true, preset:presetBits.includes(i)}}));
  F.forEach(f=>t.W(clk, f+".clk"));
  const qv=F.map(f=>({p:f+".q", n:f+".qn"}));
  // plain binary up / down count while en: bit i toggles when every lower bit is 1 (up) / 0 (down)
  let carry=en;
  for(let i=0;i<w;i++){
    const nx=t.G("XOR",[qv[i].p, carry]);
    if(i<w-1) carry=t.G("AND",[carry, p.down?qv[i].n:qv[i].p]);
    let d=nx; if(ld){ const m=t.X("MUX",{params:{inputs:2}}); t.W(nx, m+".d0"); t.W(D[i], m+".d1"); t.W(ld, m+".s0"); d=m+".y"; }
    t.W(d, F[i]+".d"); t.OUT("q"+i, F[i]+".q");
  }
  // reset (and, counting down, preset) the moment the count leaves the range
  let rst=clr;
  if(!full){
    const reach=new Set([...Array(p.m).keys(), T]);
    const hit=ptSop(t, qv, [T], ptMin(w, s=>!reach.has(s)));
    rst=t.G("OR",[clr, hit]);
    presetBits.forEach(i=>t.W(hit, F[i]+".pre"));
  }
  F.forEach((f,i)=>t.W(presetBits.includes(i) ? clr : rst, f+".rst"));
  const term=p.down?0:p.m-1;
  const atEnd=ptSop(t, qv, [term], ptMin(w, s=>s>=p.m && s!==T));
  t.OUT("tc", t.G("AND",[atEnd, en]));
  t.layout="ffstack";                                // drawn like the lab sheet (50), flip-flops in one column
  return t;
}
{
  const P=PARTS.counter_digit, _b=P.build, _s=P.seq;
  P.params=Object.assign({}, P.params, {async:{bool:true, def:false, uiDef:true, quiet:true}});
  P.desc=P.desc.replace("(ทั้งคู่ synchronous)", "(synchronous; async:true = clr ต่อเข้าขา reset ของ flip-flop ตรง ๆ และวนกลับด้วย async reset/preset — วงจรเล็กลง)");
  P.build=p=>p.async ? cdAsyncBuild(p) : _b(p);
  // async clr: the count shows 0 in the same clock clr is 1, and stays 0 while it is held
  P.seq=p=>{ const S=_s(p); if(!p.async) return S;
    const st=S.step;
    return Object.assign({}, S, {step:(s,v)=>{ if(v.clr) return {out:{q:0, tc:v.en&&(p.down?0:p.m-1)===0?1:0}, state:0}; return st(s,v); }}); };
  const M=PARTS.bcd_counter_multi, _mb=M.build, _ms=M.seq;
  M.params=Object.assign({}, M.params, {async:{bool:true, def:false, uiDef:true, quiet:true}});
  M.build=p=>{ if(!p.async) return _mb(p);
    const keep=ptSub; let it;
    // the same drawing, with async digits
    ptSub=(kind, a)=>keep(kind, kind==="counter_digit" ? Object.assign({}, a, {async:true}) : a);
    try{ it=_mb(p); } finally { ptSub=keep; }
    it.module=(it.module||"counter")+"_async"; return it; };
  M.seq=p=>{ const S=_ms(p); if(!p.async) return S;
    const F=CNT_FORMATS[p.format], st=S.step;
    return Object.assign({}, S, {step:(s,v)=>{ if(!v.clr) return st(s,v);
      const out={carry:0}; F.names.forEach(n=>out[n]=0);
      out.carry=v.en && (p.down?0:F.mods.reduce((a,b)=>a*b,1)-1)===0 ? 1 : 0; return {out, state:0}; }}); };
}

/* ---- the divider form and Tools ▸ หารความถี่: a big N is split ---- */
PARTS.clock_divider.ui={
  extra:`<label class="pt-f"><input type="checkbox" data-pp="_split" checked> แบ่งเป็นหลายขั้นอัตโนมัติเมื่อ N > 16 (เช่น 5000 = ÷5 → ÷10 → ÷10 → ÷10)</label>`,
  swap:a=>{ const sp=a._split; delete a._split;
    const L=divFactors(a.n); if(!sp || !(a.n>16) || !L || L.length<2) return a;
    return Object.assign({}, a, {kind:"divider_chain"}); } };
{
  const g=GENERATORS.find(x=>x.id==="clkdiv");
  if(g){
    g.run=async()=>{
      const v=await uxAsk("หารความถี่ด้วย N",[
        {label:"หารด้วย (N)",type:"number",value:2500000,min:2,hint:"50 MHz → 1 Hz = 50000000 · → 20 Hz = 2500000 · N > 16 แบ่งเป็นตัวหารเล็กต่อกันให้อัตโนมัติ"},
        {label:"ขาออก",value:"clk_out"}]);
      if(!v) return;
      const n=Math.floor(+v[0]), out=sanId(String(v[1]||"clk_out").trim()||"clk_out"), L=divFactors(n);
      if(!(n>16) || !L || L.length<2 || out!=="clk_out"){
        const r=dividerIntent(n, {out});
        if(r.error){ toast("สร้างไม่ได้: "+r.error,"err"); return; }
        const dr=uxDrawGenerated(r, "หารความถี่ ÷"+r.module.slice(3));
        if(dr){ try{ zoomFit(); }catch(_){} toast(r.note+(n>16 && !L?" · N นี้มีตัวประกอบเฉพาะ > 10 จึงแบ่งเป็นขั้นไม่ได้":""),"info",8000); }
        return; }
      try{ const r=MCP_OPS.build_part({kind:"divider_chain", n});
        toast(`สร้าง ÷${n} = ${L.map(x=>"÷"+x).join(" → ")} ในแผ่น ${r.sheet} แล้ว — ตรวจแล้ว: ${r.verified.method}`,"ok",7000); }
      catch(e){ toast("สร้างไม่ได้: "+e.message,"err",6000); }
    };
  }
}
