/* ===== 72. Custom / VHDL block pins on the grid ===========================================================
   "บล็อก VHDL มันชอบเบี้ยวตลอดเลย": a custom block's pins sat at dy = 14 + 22·i, but the sheet's grid is 11 px —
   every pin was 3 px off the grid, so an IN / OUT tag (snapped) or a wire corner (on the grid) never lined up
   and each wire got a small jog right at the block. The pins are now at 11 + 22·i (on the grid; the block's
   position is snapped). Sheets drawn before keep their picture: a wire corner left level with a pin's old
   place moves with the pin (`cgMigrate`, once per sheet, on the first draw). */
const CG={old:14, now:11, step:22};
{
  const _td=customTypeDef;
  customTypeDef=function(cc){
    const td=_td.apply(this, arguments), ports=td.ports;
    td.ports=function(){ return ports.apply(this, arguments).map(p=>Object.assign({}, p, {dy:p.dy-(CG.old-CG.now)})); };
    return td;
  };
}
/* a corner level with a custom pin's old place (3 px lower) moves up with the pin */
function cgMigrate(sch){
  if(!sch || sch.cgGrid) return false;
  let moved=0;
  const by=new Map(sch.components.map(c=>[c.id,c]));
  const fix=(w, end)=>{
    const c=by.get(w[end].cid); if(!c || String(c.type).indexOf("CUSTOM:")!==0) return;
    const p=getPorts(c).find(q=>q.id===w[end].pid); if(!p) return;
    const oldY=c.y+p.dy+(CG.old-CG.now), newY=c.y+p.dy;
    ["pts","autoPts"].forEach(f=>{ const L=w[f]; if(!Array.isArray(L) || !L.length) return;
      const pt=end==="from" ? L[0] : L[L.length-1];
      if(pt && Math.abs(pt.y-oldY)<0.5){ pt.y=newY; moved++;
        // the corner before it, when the run is vertical-then-horizontal into the pin, keeps its column
        const nb=end==="from" ? L[1] : L[L.length-2];
        if(nb && Math.abs(nb.y-oldY)<0.5 && nb.x!==pt.x){ nb.y=newY; moved++; } } });
  };
  (sch.wires||[]).forEach(w=>{ fix(w, "from"); fix(w, "to"); });
  sch.cgGrid=1;
  return moved>0;
}
{
  const _ra=renderAll;
  renderAll=function(){
    try{ const P=state.project&&state.project.schematics; if(P) Object.values(P).forEach(cgMigrate); }catch(_){}
    return _ra.apply(this, arguments);
  };
}
/* sheets made from now on are drawn with the new pins already */
{
  const _bs=blankSchematic;
  blankSchematic=function(){ const s=_bs.apply(this, arguments); if(s) s.cgGrid=1; return s; };
}
