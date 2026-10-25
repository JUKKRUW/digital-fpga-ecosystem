/* ===== 67. Copy / paste between windows (and between this editor and the circuit library program) =========
   Ctrl+C used to fill `state.clipboard` only — the drawing could not leave the window it was copied in, and the
   blocks it used (sub-sheets, VHDL blocks) never travelled with it. Now Ctrl+C / Ctrl+X also put the selection on
   the system clipboard as JSON (`{"schstudio":"clip", …}`) together with every sheet and custom / VHDL block it
   needs (recursively), and Ctrl+V in any copy of the editor reads it back: the sheets are added to the project
   (once — a sheet already pasted from the same source is reused, `clipSig`), the verified stamp of a part comes
   with it, and the parts land at the mouse like an ordinary paste. `clipCopySheet()` copies a whole sheet as ONE
   block (what the circuit library program's "คัดลอกไปโปรแกรมหลัก" does). Within the same project the old
   in-window paste is used, so nothing is duplicated. */
const CLIP={pending:null, mark:'{"schstudio":"clip"', win:Math.random().toString(36).slice(2)};   // win: this window (ids like prj2 / sch23 repeat across windows)

/* every sheet / custom a list of components needs, recursively */
function clipNeeds(comps){
  const P=state.project, sheets=new Map(), customs={};
  const walk=list=>(list||[]).forEach(c=>{ const t=String(c.type||"");
    if(t.indexOf("SCH:")===0){ const s=P.schematics[t.slice(4)]; if(s && !sheets.has(s.id)){ sheets.set(s.id, s); walk(s.components); } }
    else if(t.indexOf("CUSTOM:")===0){ const n=t.slice(7), cc=(P.customs||{})[n]; if(cc && !customs[n]){ customs[n]=cc; if(cc.schematic) walk(cc.schematic.components); } } });
  walk(comps);
  const pack=s=>Object.assign(JSON.parse(JSON.stringify(s)), {clipSig:s.clipSig||clipSigOf(s), clipVerified:sheetVerified(s) ? s.verified.how : null});
  return {sheets:[...sheets.values()].map(pack), customs:JSON.parse(JSON.stringify(customs))};
}
function clipSigOf(s){ let h=2166136261>>>0; const str=s.name+"|"+sheetHash(s); for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h.toString(36); }
function clipText(obj){ return JSON.stringify(Object.assign({schstudio:"clip", v:1, win:CLIP.win, project:state.activeProjectId||null, app:document.title}, obj)); }
/* a whole sheet as one block */
function clipSheetObj(sch){
  sch=sch||activeSch();
  const need=clipNeeds([{type:"SCH:"+sch.id}]);
  return {kind:"block", top:sch.id, name:sch.name, sheets:need.sheets, customs:need.customs};
}
function clipCopySheet(sch){
  CLIP.pending=clipSheetObj(sch);
  let ok=false; try{ ok=document.execCommand("copy"); }catch(_){}
  if(!ok && navigator.clipboard){ navigator.clipboard.writeText(clipText(CLIP.pending)).catch(()=>{}); ok=true; }
  CLIP.pending=null;
  return ok;
}

/* ---- paste ---- */
function clipImport(o){
  const P=state.project, sch=activeSch();
    // customs first (VHDL blocks / legacy customs): same text = reuse, else a free name
  const cmap={}; P.customs=P.customs||{};
  Object.entries(o.customs||{}).forEach(([n,cc])=>{
    const have=P.customs[n];
    if(have && JSON.stringify(have)===JSON.stringify(cc)){ cmap[n]=n; return; }
    let nn=n; for(let i=2; P.customs[nn]; i++) nn=n+"_"+i;
    const c2=JSON.parse(JSON.stringify(cc)); c2.name=nn;
    if(typeof c2.vhdl==="string" && nn!==n) c2.vhdl=c2.vhdl.replace(new RegExp("\\b"+n+"\\b","gi"), nn);
    P.customs[nn]=c2; cmap[n]=nn; });
  const retype=list=>(list||[]).forEach(c=>{ const t=String(c.type||""); if(t.indexOf("CUSTOM:")===0 && cmap[t.slice(7)]) c.type="CUSTOM:"+cmap[t.slice(7)]; });
  // sheets: reuse one pasted before from the same source, adopt the rest
  const smap={}, fresh=[];
  (o.sheets||[]).forEach(s=>{ const have=Object.values(P.schematics).find(x=>x.clipSig && x.clipSig===s.clipSig);
    if(have) smap[s.id]=have.id; else fresh.push(s); });
  const added=adoptSchematics(fresh.map(s=>{ const c=JSON.parse(JSON.stringify(s)); delete c.clipVerified; return c; }));
  added.forEach((ns,i)=>{ const src=fresh[i]; smap[src.id]=ns.id; ns.clipSig=src.clipSig; });
  added.forEach(ns=>{ ns.components.forEach(c=>{ const t=String(c.type||""); if(t.indexOf("SCH:")===0 && smap[t.slice(4)]) c.type="SCH:"+smap[t.slice(4)]; }); retype(ns.components); });
  // the part's check travels with it (the stamp is tied to the sheet's own ids, so it is made again here)
  added.forEach((ns,i)=>{ const how=fresh[i].clipVerified; if(how) sheetVerifyStamp(ns, how+" · คัดลอกมา"); else delete ns.verified; });
  let placed=[];
  if(o.kind==="block"){
    const sid=smap[o.top]; const why=subBlockBlockedWhy(sid, sch.id);
    if(why){ toast(why,"warn",4000); snapshot(); renderAll(); return null; }
    const c={id:uid("c"), type:"SCH:"+sid, x:snap(state.mouse.x-30), y:snap(state.mouse.y-20), params:{}, label:""};
    sch.components.push(c); placed=[c.id];
  } else {
    const comps=JSON.parse(JSON.stringify(o.components||[])), wires=JSON.parse(JSON.stringify(o.wires||[]));
    comps.forEach(c=>{ const t=String(c.type||""); if(t.indexOf("SCH:")===0 && smap[t.slice(4)]) c.type="SCH:"+smap[t.slice(4)]; }); retype(comps);
    const keep=state.clipboard; state.clipboard={components:comps, wires, ties:o.ties||[]};
    try{ _clipPaste(); placed=[...state.selection]; } finally { state.clipboard=keep; }
    return {sheets:added.map(s=>s.name), reused:Object.keys(smap).length-added.length, placed};
  }
  state.selection=new Set(placed); snapshot(); renderAll();
  return {sheets:added.map(s=>s.name), reused:Object.keys(smap).length-added.length, placed};
}
const _clipCopy=copySelection, _clipPaste=pasteClipboard;
function clipFromText(t){ if(!t || t.indexOf(CLIP.mark)!==0) return null; try{ const o=JSON.parse(t); return o && o.schstudio==="clip" ? o : null; }catch(_){ return null; } }
function clipPasteObj(o){
  // the same project and every sheet it needs is here: the plain paste
  if(o.kind!=="block" && o.win===CLIP.win && o.project && o.project===state.activeProjectId && (o.sheets||[]).every(s=>state.project.schematics[s.id])
     && Object.entries(o.customs||{}).every(([n,cc])=>{ const h=(state.project.customs||{})[n]; return h && JSON.stringify(h)===JSON.stringify(cc); })){
    const keep=state.clipboard; state.clipboard={components:o.components, wires:o.wires, ties:o.ties||[]};
    try{ _clipPaste(); } finally { state.clipboard=keep; } return; }
  const r=clipImport(o); if(!r) return;
  toast(o.kind==="block" ? `วาง ${o.name} เป็นบล็อกแล้ว`+(r.sheets.length?` (เพิ่มแผ่น ${r.sheets.join(", ")})`:"")
    : `วางแล้ว ${r.placed.length} ชิ้น`+(r.sheets.length?` — เพิ่มแผ่นที่ใช้ ${r.sheets.join(", ")}`:""), "ok", 4000);
}
const clipTyping=()=>{ const a=document.activeElement; return a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable); };
/* Ctrl+C / X / V reach the browser's own copy / paste events (the core handler prevented them) */
window.addEventListener("keydown", ev=>{
  if(clipTyping() || !(ev.ctrlKey||ev.metaKey) || ev.altKey || ev.shiftKey) return;
  const k=(ev.key||"").toLowerCase(), code=ev.code;
  if(code==="KeyC"||k==="c"||code==="KeyX"||k==="x"||code==="KeyV"||k==="v"){
    if(document.querySelector(".modal-bg")) return;            // a dialog's own fields
    ev.stopPropagation(); CLIP.key=code==="KeyX"||k==="x" ? "cut" : (code==="KeyV"||k==="v") ? "paste" : "copy";
    // no copy / paste event follows (some browsers): do the plain one
    setTimeout(()=>{ if(CLIP.key){ const how=CLIP.key; CLIP.key=null; if(how==="paste") _clipPaste(); else { copySelection(); if(how==="cut") deleteSelection(); } } }, 60);
  }
}, true);
document.addEventListener("copy", e=>{
  if(!CLIP.pending && !CLIP.key && !CLIP.inMenu) return;      // text copied from the page itself stays as it is
  if(clipTyping() && !CLIP.pending) return;
  let obj=CLIP.pending;
  if(!obj){
    const how=CLIP.key; CLIP.key=null;
    if(!state.selection || !state.selection.size){ if(how) _clipCopy(); return; }
    _clipCopy();
    const cb=state.clipboard; if(!cb || !cb.components.length) return;
    const need=clipNeeds(cb.components);
    obj={kind:"parts", components:cb.components, wires:cb.wires, ties:cb.ties||[], sheets:need.sheets, customs:need.customs};
    if(how==="cut") setTimeout(()=>deleteSelection(), 0);
  }
  e.clipboardData.setData("text/plain", clipText(obj)); e.preventDefault();
});
document.addEventListener("paste", e=>{
  if(clipTyping()) return;
  const was=CLIP.key; CLIP.key=null;
  const o=clipFromText(e.clipboardData && e.clipboardData.getData("text/plain"));
  if(o){ e.preventDefault(); clipPasteObj(o); return; }
  if(was==="paste") _clipPaste();
});
/* Edit menu: copy through the same path; paste reads the system clipboard when it may */
copySelection=function(){ if(CLIP.inMenu) return _clipCopy.apply(this, arguments); CLIP.inMenu=true;
  try{ let ok=false; try{ ok=document.execCommand("copy"); }catch(_){} if(!ok) _clipCopy(); } finally { CLIP.inMenu=false; } };
pasteClipboard=function(){
  if(navigator.clipboard && navigator.clipboard.readText){
    navigator.clipboard.readText().then(t=>{ const o=clipFromText(t); if(o) clipPasteObj(o); else _clipPaste(); }, ()=>_clipPaste());
  } else _clipPaste();
};
