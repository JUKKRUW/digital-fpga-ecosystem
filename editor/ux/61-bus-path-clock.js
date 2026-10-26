/* ===== 61. Live sim: a bus lights only where a 1 travels, and a clock you press yourself =================
   - A bus net used to turn green end to end whenever its value was non-zero (d = 00000100 lit all eight taps'
     stretch and the whole q trunk). Now only the segments on the way from where a 1 enters the bus (its driver,
     or a merge tap whose bit is 1) to where it leaves (a split tap whose bit is 1, or a pin that takes the whole
     bus) are lit; the rest of the bus is drawn like a 0 wire.
   - Every clock input gets a "⏭ 1 clk" button beside its badge: one rising + falling edge per click (the clock's
     free run stops). Alt+click on the input did the same, and nobody found it. */

/* ---- bus segments that carry a 1 ---- */
function bpLitWires(sch, ids, v){
  const W=ids.map(id=>sch.wires.find(w=>w.id===id)).filter(Boolean);
  const key=ep=>{ const c=comp(ep.cid, sch); return c && c.type==="JUNCTION" ? "J:"+ep.cid : ep.cid+"."+ep.pid; };
  const adj=new Map(), add=(a,b,id)=>{ (adj.get(a)||adj.set(a,[]).get(a)).push([b,id]); };
  W.forEach(w=>{ const a=key(w.from), b=key(w.to); add(a,b,w.id); add(b,a,w.id); });
  const lit=bits=>{ const p=bits||{bit:0,nbit:32}; const m=p.nbit>=32?0xFFFFFFFF:((1<<p.nbit)>>>0)-1; return ((v>>>(p.bit||0))&m)!==0; };
  const src=[], snk=[]; let driver=null;
  const seen=new Set();
  W.forEach(w=>[w.from, w.to].forEach(ep=>{ const k=key(ep); if(seen.has(k) || k.startsWith("J:")) return; seen.add(k);
    const c=comp(ep.cid, sch); if(!c) return;
    if(c.type==="BUSTAP" && ep.pid==="d"){
      const p=c.params||{}, on=lit({bit:p.bit||0, nbit:Math.max(1,p.nbit||1)});
      if(p.mode==="merge"){ if(on) src.push(k); } else if(on) snk.push(k);
      return; }
    let dir="in"; try{ dir=(getPort(c, ep.pid)||{}).dir||"in"; }catch(_){}
    if(dir==="out") driver=k; else snk.push(k); }));
  const sources=driver ? [driver] : src;
  const out=new Set();
  sources.forEach(s=>{
    // shortest path from s to every lit sink (the net is a tree in practice)
    const prev=new Map([[s,null]]), q=[s];
    while(q.length){ const a=q.shift(); (adj.get(a)||[]).forEach(([b,id])=>{ if(!prev.has(b)){ prev.set(b,[a,id]); q.push(b); } }); }
    snk.forEach(t=>{ for(let x=t; prev.get(x); x=prev.get(x)[0]) out.add(prev.get(x)[1]); });
  });
  return out;
}
{
  const _pe=probeEval;
  probeEval=function(){ const r=_pe.apply(this, arguments); BP.last=r; return r; };
  const _pc=probeColorize;
  probeColorize=function(sch){
    const r=_pc.apply(this, arguments);
    try{ bpBusPaths(sch); }catch(e){ console.warn("bus paths", e); }
    try{ bpClockButtons(sch); }catch(e){ console.warn("clock buttons", e); }
    return r;
  };
}
const BP={last:null};
function bpBusPaths(sch){
  const ev=BP.last; if(!ev || !sch) return;
  const root=$("#canvas"), done=new Set();
  sch.wires.forEach(w=>{
    if(done.has(w.id)) return;
    const v=ev.wireVal.get(w.id); let bw=1; try{ bw=wireWidth(w, sch)||1; }catch(_){}
    const ids=[...netWires(sch, w)]; ids.forEach(id=>done.add(id));
    if(bw<=1 || v==null || v===0) return;
    const lit=bpLitWires(sch, ids, v>>>0);
    ids.forEach(id=>{ const g=root.querySelector(`.wire-group[data-wid="${CSS.escape(id)}"]`); if(!g) return;
      const path=g.querySelector("path.wire"); if(!path) return;
      if(lit.has(id)) return;                                  // stays as the core drew it (green)
      if(!NETCOLOR) path.setAttribute("stroke", "var(--wire)");
      path.removeAttribute("stroke-width"); g.style.opacity="0.22"; });
  });
}

/* ---- ⏭ 1 clk ---- */
function bpPulse(id){
  probeStopClock(id);
  PROBE_VALS[id]=1; probeApply();
  setTimeout(()=>{ if(!PROBE) return; PROBE_VALS[id]=0; probeApply(); }, 120);
}
function bpClockButtons(sch){
  const ev=BP.last, world=$("#canvas") && $("#canvas").firstChild; if(!ev || !world) return;
  ev.clocks.forEach(id=>{
    const c=comp(id, sch); if(!c) return;
    const sz=getSize(c), x=c.x+sz.w/2+25, y=c.y+sz.h+4;      // under the input, clear of the badge on its left
    const g=document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "bp-clk"); g.setAttribute("data-clk", id);
    g.innerHTML=`<rect x="${x-50}" y="${y}" width="50" height="16" rx="4"></rect><text x="${x-25}" y="${y+11.5}" text-anchor="middle">⏭ 1 clk</text><title>กดทีละครั้ง = 1 จังหวะนาฬิกา (ขอบขาขึ้น + ขาลง) · หยุดการเดินอัตโนมัติ</title>`;
    world.appendChild(g);
  });
}
document.addEventListener("mousedown", e=>{
  const g=e.target.closest && e.target.closest("#canvas .bp-clk"); if(!g) return;
  e.stopPropagation(); e.preventDefault();
  bpPulse(g.getAttribute("data-clk"));
}, true);
