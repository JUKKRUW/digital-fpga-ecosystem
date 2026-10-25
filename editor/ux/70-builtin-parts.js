/* ===== 70. Parts built from the editor's own components, plus the one-hot ring ======================
   "มันจะมีพวกหลายวงจรที่ไม่ใช้ component ที่มีอยู่แล้ว ไปทำให้มันใช้ของเก่าให้คุ้ม เช่น pwm ที่ทำ comp เอง":
   the component list already has COMPM (magnitude comparator, ISE's COMPM2 / COMPM4) and DECODER, but the
   library drew its own comparator sub-sheet (comparator_n4) for pwm / bcd2_compare and a sum-of-products for
   the 7-seg scan's an[3:0]. The intent vocabulary now takes COMPM / COMP / DEC / DEMUX / ENC (named pins like
   MUX / DFF), and those parts use them: n-bit "less than" = COMPM4 / COMPM2 slices, high slice first
   (`ptCompare`). The library's own comparator / decoder parts stay gate-level — they are what one is made of.
   Also `ring_counter`: one 1 walking 0001 → 0010 → 0100 → 1000 (or back), as a shift ring of D-FFs that
   starts itself (d0 = no 1 in the other bits) or as a counter + DECODER. */

/* ---- intent: the coded blocks of the component list ---- */
{
  const pins=(ins, outs, primary)=>({insTest:pid=>ins.some(r=>r.test(pid)), outs:{has:pid=>outs.some(r=>r.test(pid))}, primaryOut:primary});
  Object.assign(INTENT_BLOCKS, {
    COMPM:pins([/^a\d+$/, /^b\d+$/], [/^gt$/, /^lt$/], "lt"),
    COMP: pins([/^a\d+$/, /^b\d+$/], [/^eq$/], "eq"),
    DEC:  pins([/^a\d+$/, /^en$/], [/^y\d+$/], "y0"),
    DEMUX:pins([/^d$/, /^s\d+$/], [/^y\d+$/], "y0"),
    ENC:  pins([/^i\d+$/], [/^y\d+$/], "y0") });
  ["COMPM","COMP","DEC","DEMUX","ENC"].forEach(k=>INTENT_TYPES.add(k));
  const PARAM={COMPM:["width",[2,4]], COMP:["width",[2,4]], DEC:["outputs",[4,8,16]], DEMUX:["outputs",[2,4,8,16]], ENC:["inputs",[4,8,16]]};
  const _build=buildSchematicFromIntent;
  buildSchematicFromIntent=function(intent){
    const r=_build.apply(this, arguments);
    (intent.components||[]).forEach(ic=>{ const P=PARAM[ic.type]; if(!P) return;
      const c=r.comps.find(x=>x.id===ic.id); if(!c) return;
      const v=+((ic.params||{})[P[0]]); c.params={[P[0]]: P[1].includes(v) ? v : P[1][P[1].length>1?1:0]}; });
    return r;
  };
}

/* ---- a > b, a < b, a = b over n bits from COMPM slices (bit lists LSB first), high slice decides first ---- */
function ptCompare(t, A, B){
  const n=A.length, gnd=()=>t.X("GND"), slices=[];
  for(let lo=0; lo<n; lo+=4){ const k=Math.min(4, n-lo), w=k<=2?2:4, c=t.X("COMPM",{params:{width:w}});
    for(let i=0;i<w;i++){ t.W(lo+i<n ? A[lo+i] : gnd(), c+".a"+i); t.W(lo+i<n ? B[lo+i] : gnd(), c+".b"+i); }
    slices.push(c); }
  let gt=null, lt=null, eq=null;
  for(let s=slices.length-1; s>=0; s--){ const c=slices[s], g=c+".gt", l=c+".lt";
    if(gt==null){ gt=g; lt=l; }
    else { gt=t.G("OR",[gt, t.G("AND",[eq, g])]); lt=t.G("OR",[lt, t.G("AND",[eq, l])]); }
    const e=t.G("NOR",[g, l]); eq = eq==null ? e : t.G("AND",[eq, e]); }
  return {gt, lt, eq};
}

/* ---- pwm: the counter against duty on COMPM ---- */
PARTS.pwm.desc=PARTS.pwm.desc.replace(/ · n = /, " · ตัวนับ mod-2ⁿ จากคลัง (n ≤ 6) เทียบด้วย COMPM ในคลังอุปกรณ์ · n = ");
// the counter is the library's mod-2ⁿ counter as a block (synchronous; n ≤ 6), drawn inline above that
PARTS.pwm.build=p=>{ const t=ptIntent("pwm"+p.n), clk=t.IN("clk"), D=[]; for(let i=p.n-1;i>=0;i--) D[i]=t.IN("duty"+i);
  let Q;
  if(p.n<=6){ const cnt=ptBlock(t, ptSub("mod_counter", {n:1<<p.n})); t.W(clk, cnt+".clk"); Q=Array.from({length:p.n},(_,i)=>cnt+".q"+i); }
  else Q=ptCycle(t, 1<<p.n, clk, null, null).map(x=>x.p);
  t.OUT("pwm", ptCompare(t, Q, D).lt); ptPrune(t); return t; };              // the unused "equal" gate goes

/* ---- 2-digit BCD compare: two COMPM4 ---- */
PARTS.bcd2_compare.desc=PARTS.bcd2_compare.desc.replace("ต่อจากตัวเปรียบเทียบ 4 บิต 2 ตัว", "COMPM4 2 ตัว (หลักสิบ, หลักหน่วย)");
PARTS.bcd2_compare.build=()=>{ const t=ptIntent("bcd2_compare"), I={};
  ["a_hi","a_lo","b_hi","b_lo"].forEach(nm=>{ I[nm]=[]; for(let i=3;i>=0;i--) I[nm][i]=t.IN(nm+i); });
  const c=ptCompare(t, I.a_lo.concat(I.a_hi), I.b_lo.concat(I.b_hi));
  t.OUT("gt", c.gt); t.OUT("eq", c.eq); t.OUT("lt", c.lt); return t; };

/* ---- 7-seg scan: an[3:0] from a 2→4 DECODER (active-low → NOT) ---- */
{
  const _b=PARTS.seg7_mux4.build;
  PARTS.seg7_mux4.build=p=>{ const t=_b(p);
    // drop the an outputs the old build made from sums of products, then decode the scan counter
    const drop=new Set(t.nets.filter(n=>/^o_an\d$/.test(n.to)).map(n=>n.to));
    t.nets.splice(0, t.nets.length, ...t.nets.filter(n=>!drop.has(n.to)));
    t.components.splice(0, t.components.length, ...t.components.filter(c=>!drop.has(c.id)));
    const ffs=t.components.filter(c=>c.type==="DFF").slice(0,2).map(c=>c.id), dec=t.X("DEC",{params:{outputs:4}});
    t.W(ffs[0]+".q", dec+".a0"); t.W(ffs[1]+".q", dec+".a1"); t.W(t.X("VCC"), dec+".en");
    for(let i=0;i<4;i++) t.OUT("an"+i, t.G("NOT",[dec+".y"+i]));
    ptPrune(t); return t; };
}
/* gates whose output no longer goes anywhere (the old an logic) */
function ptPrune(t){
  for(let again=true; again;){ again=false;
    const used=new Set(t.nets.map(n=>intentRef(n.from).id));
    const dead=t.components.filter(c=>!["IN","OUT"].includes(c.type) && INTENT_GATES.hasOwnProperty(c.type) && !used.has(c.id)).map(c=>c.id);
    if(dead.length){ const d=new Set(dead); again=true;
      t.components.splice(0, t.components.length, ...t.components.filter(c=>!d.has(c.id)));
      t.nets.splice(0, t.nets.length, ...t.nets.filter(n=>!d.has(intentRef(n.to).id))); } }
  const used=new Set(t.nets.map(n=>intentRef(n.from).id));
  t.components.splice(0, t.components.length, ...t.components.filter(c=>!["VCC","GND"].includes(c.type) || used.has(c.id)));
}

/* ---- ring counter: 0001 → 0010 → 0100 → 1000 → 0001 … ---- */
Object.assign(PARTS, {
  ring_counter:{ label:"ไล่บิตทีละตำแหน่ง (ring / one-hot)", group:"ตัวนับ",
    desc:"มีบิตเป็น 1 ตัวเดียววิ่ง q0 → q(n−1) แล้ววน (…0001 → 0010 → 0100 → 1000) ทุก clock · dir down = วิ่งกลับทาง · "+
      "shift = D-FF n ตัวต่อเป็นวง ตั้งตัวเองได้ (d0 = 1 เมื่อบิตอื่นเป็น 0 หมด) · decoder = ตัวนับ + DECODER ในคลังอุปกรณ์ (n = 4, 8, 16) · en / clr (กลับไปบิตแรก) ได้ · n = 2..16",
    params:{n:{min:2,max:16,def:4}, how:{options:["shift","decoder"],def:"shift"}, down:{bool:true,def:false}, en:{bool:true,def:false}, clr:{bool:true,def:false}},
    ports:p=>({in:Object.assign({clk:1}, p.en?{en:1}:{}, p.clr?{clr:1}:{}), out:{q:p.n}}),
    build:p=>{ if(p.how==="decoder" && ![4,8,16].includes(p.n)) mcpFail("ring_counter how:decoder takes n = 4, 8 or 16 (the DECODER's sizes) — แบบ decoder ใช้ n = 4, 8 หรือ 16");
      const t=ptIntent("ring"+p.n+(p.down?"_down":"")+(p.how==="decoder"?"_dec":"")), clk=t.IN("clk");
      const en=p.en?t.IN("en"):null, clr=p.clr?t.IN("clr"):null, pos=k=>p.down ? p.n-1-k : k;   // k-th step lights q[pos(k)]
      if(p.how==="decoder"){
        const sv=ptCycle(t, p.n, clk, en, clr), dec=t.X("DEC",{params:{outputs:p.n}});
        sv.forEach((v,i)=>t.W(v.p, dec+".a"+i)); t.W(t.X("VCC"), dec+".en");
        for(let k=0;k<p.n;k++) t.OUT("q"+pos(k), dec+".y"+k);
        return t; }
      // F[k] holds step k; F[k] ← F[k−1], F[0] ← no 1 in F[0..n−2] (starts itself from 0…0 and from any bad state)
      const F=Array.from({length:p.n},()=>t.X("DFF")); F.forEach(f=>t.W(clk, f+".clk"));
      const nclr=clr?t.G("NOT",[clr]):null;
      const Q=F.slice(0, p.n-1).map(f=>f+".q");
      const first=Q.length===1 ? t.G("NOT", Q) : Q.length<=8 ? t.G("NOR", Q) : t.G("NOT", [ptGate(t, "OR", Q)]);
      F.forEach((f,k)=>{ let d=k ? F[k-1]+".q" : first;
        if(clr) d = k ? t.G("AND",[d, nclr]) : t.G("OR",[d, clr]);
        if(en){ const m=t.X("MUX",{params:{inputs:2}}); t.W(f+".q", m+".d0"); t.W(d, m+".d1"); t.W(clr?t.G("OR",[en, clr]):en, m+".s0"); d=m+".y"; }
        t.W(d, f+".d"); t.OUT("q"+pos(k), f+".q"); });
      return t; },
    seq:p=>{ const L=p.n, dec=p.how==="decoder", bit=k=>1<<(p.down ? p.n-1-k : k);
      // shift: all 0 at power-up, step 0 on the first clock; decoder: the counter starts at step 0
      return {cycles:Math.min(Math.max(3*L+4, 40), 160), init:dec?0:-1, drive:ptSeqDrive(p.en,p.clr),
        step:(s,v)=>({out:{q:s<0?0:bit(s)}, state:(p.clr&&v.clr)?0:(!p.en||v.en)?(s+1)%L:s})}; } },
});
LIB_CATS.forEach(c=>{ if(c.id==="cnt" && !c.kinds.includes("ring_counter")) c.kinds.push("ring_counter"); });

/* ---- the auto-router must keep every connection ----
   seg7_mux4 with dp lost its scan flip-flop's qn → d wire in autoRouteSheet (a wire from a part to itself), the
   counter stood still and the part's check refused it. After any auto-route, each net of before must still be
   one net: pins it left with no wire at all get a wire back to the rest, routed alone (12-wire-tidy). */
function arNetGroups(sch){
  const par=new Map(), f=k=>{ if(!par.has(k)) par.set(k,k); while(par.get(k)!==k){ par.set(k, par.get(par.get(k))); k=par.get(k); } return k; };
  sch.wires.forEach(w=>{ const a=f(w.from.cid+"\u0001"+w.from.pid), b=f(w.to.cid+"\u0001"+w.to.pid); if(a!==b) par.set(a,b); });
  const J=new Set(sch.components.filter(c=>c.type==="JUNCTION").map(c=>c.id)), nets=new Map();
  [...par.keys()].forEach(k=>{ if(J.has(k.split("\u0001")[0])) return; const r=f(k); (nets.get(r)||nets.set(r,[]).get(r)).push(k); });
  return {nets:[...nets.values()], root:k=>par.has(k)?f(k):k};
}
{
  const _ar=autoRouteSheet;
  autoRouteSheet=function(sch){
    sch=sch||activeSch(); if(!sch) return _ar.apply(this, arguments);
    const before=arNetGroups(sch).nets.filter(n=>n.length>1);
    const r=_ar.apply(this, arguments);
    try{
      const after=arNetGroups(sch), fixed=new Set(), wired=new Set(after.nets.filter(n=>n.length>1).flat()), conn=p=>p.filter(k=>wired.has(k)).length;
      before.forEach(net=>{ const groups=new Map(); net.forEach(k=>{ const g=after.root(k); (groups.get(g)||groups.set(g,[]).get(g)).push(k); });
        if(groups.size<2) return;
        // only pins left with no wire at all: the router may legally swap a gate's inputs (a pin then sits on another net)
        const parts=[...groups.values()].sort((x,y)=>conn(y)-conn(x)), main=parts[0][0].split("\u0001");
        parts.slice(1).filter(p=>!conn(p)).forEach(p=>{ const o=p[0].split("\u0001"), id=uid("w");
          // the wire runs from whichever end is an output pin (drawing direction only; connectivity is the same)
          sch.wires.push({id, from:{cid:main[0], pid:main[1]}, to:{cid:o[0], pid:o[1]}, name:""}); fixed.add(id); }); });
      if(fixed.size){ try{ wtReroute(sch, fixed); }catch(_){} }
    }catch(_){}
    return r;
  };
}
