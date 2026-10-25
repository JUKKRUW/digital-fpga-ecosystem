/* ===== 63. Reordering a block's pins (Inspector ▸ เรียงขาโมดูล) carries the parent sheets along ==========
   The symbol's pins moved, but on every sheet that places the block the wires kept their old routes and the
   IN/OUT tags stayed where they were — a → c, b → a … crossed. Now, for each placed copy, the tags that hang
   on one pin each (the net joins only that pin and the tag) swap places in the new pin order, and the wires
   on that side of the block are routed again. Called from the core's reorderSubPins, before its snapshot. */
function uxPinsFollow(sub, dir, oldOrder){
  Object.values(state.project.schematics).forEach(sch=>{
    if(sch===sub) return;
    sch.components.filter(b=>subSchOf(b)===sub).forEach(blk=>{
      const pins=getPorts(blk).filter(p=>p.dir===dir);
      const tagOf=pid=>{
        const w=sch.wires.find(x=>(x.from.cid===blk.id && x.from.pid===pid) || (x.to.cid===blk.id && x.to.pid===pid)); if(!w) return null;
        const ends=new Map();
        netWires(sch, w).forEach(id=>{ const x=sch.wires.find(y=>y.id===id); if(!x) return;
          [x.from, x.to].forEach(ep=>{ const c=comp(ep.cid, sch); if(c && c.type!=="JUNCTION") ends.set(ep.cid+"."+ep.pid, c); }); });
        if(ends.size!==2) return null;
        const t=[...ends.values()].find(c=>c.id!==blk.id);
        return t && (t.type==="IN" || t.type==="OUT") ? t : null;
      };
      // only the pins that changed place (and their tags) move; the rest keep their routes
      const moved=new Set(pins.map(p=>p.id).filter((id,i)=>!oldOrder || oldOrder[i]!==id));
      const pairs=pins.filter(p=>moved.has(p.id)).map(p=>({pid:p.id, tag:tagOf(p.id)})).filter(x=>x.tag);
      if(pairs.length>1){
        const slots=pairs.map(x=>({x:x.tag.x, y:x.tag.y})).sort((a,b)=>a.y-b.y || a.x-b.x);
        pairs.forEach((x,i)=>{ x.tag.x=slots[i].x; x.tag.y=slots[i].y; });   // pins are listed in their new order
      }
      const ids=new Set();
      pins.filter(p=>moved.has(p.id)).forEach(p=>sch.wires.filter(x=>(x.from.cid===blk.id && x.from.pid===p.id) || (x.to.cid===blk.id && x.to.pid===p.id))
        .forEach(w=>netWires(sch, w).forEach(id=>ids.add(id))));
      if(ids.size && typeof wtReroute==="function") wtReroute(sch, ids);
    });
  });
}
