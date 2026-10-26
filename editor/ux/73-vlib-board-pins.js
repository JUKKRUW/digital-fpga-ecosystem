/* =========================================================================
   73. AUTO PINS FOLLOW A LIBRARY BLOCK'S OWN BOARD PINS
   ========================================================================= */
/* A library VHDL block placed on a sheet (วางบนแผ่นนี้) and then given pins with auto_pins got the
   name rule's guess: a seg bus is top bit = a (06), but every VLIB block drives seg(0) = a … seg(6) = g
   (VLIB.seg7_num.pins) — the digits came out scrambled; adc_* ports landed on LEDs. The block's
   pins() map is now kept with the block (`boardPins`), and an IN / OUT wired straight to one of
   those block pins takes that pin's target. Blocks saved before this are recognised by name. */
function vlBoardPinsOf(name){
  const C=state.project.customs||{}, def=C[name]; if(!def || typeof def.vhdl!=="string") return null;
  if(def.boardPins) return def.boardPins;
  const base=String(name).replace(/_\d+$/,"");
  for(const [kind, L] of Object.entries(VLIB)){
    if(!L.pins) continue;
    const bools=Object.entries(L.params||{}).filter(([,s])=>s.bool).map(([k])=>k);
    for(let m=0; m<(1<<bools.length); m++){
      const a={}; bools.forEach((k,i)=>a[k]=!!(m>>i&1));
      let p; try{ p=vlParams(kind, a); }catch(_){ continue; }
      if(L.name(p)===base) return L.pins(p);
    }
    // a numbered setting in the name (adc_mcp3208_ch6, tone440, uart_tx_9600): the pins do not depend on it
    try{ const p=vlParams(kind, {}), n=L.name(p), stem=n.replace(/\d+$/,"");
      if(stem!==n && base.startsWith(stem) && /^\d+$/.test(base.slice(stem.length))) return L.pins(p); }catch(_){}
  }
  return null;
}
{
  const _build=vlBuild;
  vlBuild=function(kind, a){ const r=_build.apply(this, arguments), L=VLIB[kind];
    if(L && L.pins) state.project.customs[r.name].boardPins=L.pins(r.params);
    return r; };
  const _save=vhdlBlockSave;
  vhdlBlockSave=function(text, old){ const prev=old && (state.project.customs||{})[old], keep=prev && prev.boardPins;
    const r=_save.apply(this, arguments);
    if(keep && state.project.customs[r.name]) state.project.customs[r.name].boardPins=keep;
    return r; };
}
/* port key ("seg[3]", "adc_cs") → target, for the ports wired straight to a block that has board pins */
function vlPortHints(sch){
  const hints={};
  schPortList(sch).forEach(p=>{
    const w=(sch.wires||[]).find(x=>x.from.cid===p.cid || x.to.cid===p.cid); if(!w) return;
    let ids; try{ ids=netWires(sch, w); }catch(_){ return; }
    for(const id of ids){ const x=sch.wires.find(y=>y.id===id); if(!x) continue;
      for(const ep of [x.from, x.to]){
        const c=comp(ep.cid, sch); if(!c || !/^CUSTOM:/.test(c.type)) continue;
        const bp=vlBoardPinsOf(c.type.slice(7)); if(!bp) continue;
        const pin=getPorts(c).find(q=>q.id===ep.pid); if(!pin || pin.dir!==p.dir) continue;   // OUT ← block output, IN → block input
        const w2=p.width||1;
        if(w2===1){ if(bp[ep.pid]) hints[p.id]=bp[ep.pid]; }
        else for(let i=0;i<w2;i++){ const t=bp[`${ep.pid}[${i}]`]; if(t) hints[`${p.id}[${i}]`]=t; }
        return;
      } }
  });
  return hints;
}
{
  const _auto=uxAutoPins;
  uxAutoPins=function(sch, onlyMissing){
    const before=new Set(onlyMissing ? Object.keys(sch.pinmap||{}) : []);
    const r=_auto.apply(this, arguments);
    let hints={}; try{ hints=vlPortHints(sch); }catch(e){ console.warn("vlPortHints", e); }
    const own=sch.pinmap=sch.pinmap||{};
    Object.entries(hints).forEach(([k,t])=>{ if(before.has(k)) return;
      // the guess may have put another guessed port on this target: free it for the block's pin
      Object.keys(own).forEach(o=>{ if(o!==k && own[o]===t && !before.has(o) && !hints[o]) delete own[o]; });
      own[k]=t; });
    return r; };
}
