/* ===== 55. Push buttons on the simulated board =====================================================
   An INPUT mapped to a push button (pb:0–4, e.g. the centre button J12) could only be pressed in
   "⚡ เล่นเวลาจริง": the truth-table board and the clock-by-clock board quietly gave that input a
   free SWITCH instead, and clicking the button did nothing. Now the button is the input there too:
   held = 1 while the mouse is down (a click on the clock-by-clock board lasts at least the clock
   on show, so "click, then ก้าว 1 clock" latches it, as on the board). The button shows the name
   of the input it drives. */
const PB_DOM_ORDER=[0,2,4,3,1];             // .pbtn order in the drawing: top, left, centre, right, bottom
function pbTargetOf(name){
  const own=(activeSch()||{}).pinmap||{}, t=pmGet(own, name)||"";
  return /^pb:[0-4]$/.test(t) ? +t.slice(3) : null;
}
/* names on the buttons: {pb index → [input names]} */
function pbLabelBoard(byPb){
  const btns=[...document.querySelectorAll('#simPcb .pbtn')];
  btns.forEach((p,k)=>{ p.querySelectorAll(".pb-name").forEach(x=>x.remove()); p.classList.remove("pb-mapped");
    const names=k<5 ? byPb[PB_DOM_ORDER[k]] : null; if(!names || !names.length) return;
    p.classList.add("pb-mapped");
    p.insertAdjacentHTML("beforeend", `<div class="pb-name">${esc(names.join(", "))}</div>`); });
}
/* ---- truth-table board: the input reads SIM_SW["pb:K"] ---- */
{
  const _def=simDefaultPinmap;
  simDefaultPinmap=function(tt){ const pm=_def.apply(this, arguments);
    tt.inputs.forEach(n=>{ const k=pbTargetOf(n); if(k!=null) pm.inMap[n]="pb:"+k; });
    return pm; };
  const _sync=uxSyncSimPinmap;
  uxSyncSimPinmap=function(){ _sync.apply(this, arguments);
    if(!SIM_PINMAP || !UX.lastTT) return;
    let ch=false; UX.lastTT.inputs.forEach(n=>{ const k=pbTargetOf(n);
      if(k!=null && SIM_PINMAP.inMap[n]!=="pb:"+k){ SIM_PINMAP.inMap[n]="pb:"+k; ch=true; }
      else if(k==null && typeof SIM_PINMAP.inMap[n]==="string"){ SIM_PINMAP.inMap[n]=0; ch=true; } });
    if(ch && SIM_REDRAW) try{ SIM_REDRAW(); }catch(_){}
    pbCombLabels(); };
  const _swl=simSwLabel;
  simSwLabel=function(i){ return typeof i==="string" && /^pb:/.test(i) ? pinOptLabel(i).replace(" · "," ") : _swl.apply(this, arguments); };
  const _wire=wireSimBoard;
  wireSimBoard=function(j){ const r=_wire.apply(this, arguments); if(j && j.truth_table) pbCombLabels(); return r; };
}
function pbCombLabels(){
  if(!SIM_PINMAP || !SIM_LAST_TT || SIM_SEQ) return;
  const by={}; SIM_LAST_TT.inputs.forEach(n=>{ const v=SIM_PINMAP.inMap[n]; if(typeof v==="string" && /^pb:/.test(v)) (by[+v.slice(3)]=by[+v.slice(3)]||[]).push(n); });
  pbLabelBoard(by);
}
/* ---- clock-by-clock board: the button drives that input's history from the clock on show ---- */
{
  const _wire=wireSimBoardSeq;
  wireSimBoardSeq=function(j, opts){
    const r=_wire.apply(this, arguments);
    const S=SIM_SEQ; if(!S) return r;
    S.pbOf=S.inputs.map(n=>pbTargetOf(n));
    const by={};
    S.pbOf.forEach((k,q)=>{ if(k==null) return; (by[k]=by[k]||[]).push(S.inputs[q]);
      // it had been given a free switch: take that back
      const sw=S.swOf[q]; S.swOf[q]=null;
      const u=sw!=null && document.querySelector('#simPcb .swUnit[data-sw="'+sw+'"]');
      if(u && !S.swOf.includes(sw)){ u.classList.remove("mapped"); const nm=u.querySelector(".swName"); if(nm) nm.textContent="sw["+sw+"]"; } });
    pbLabelBoard(by);
    try{ seqTable(); }catch(_){}
    return r; };
}
function pbSeqSet(k, v, from){
  const S=SIM_SEQ; if(!S || !S.hist || !S.pbOf) return false;
  const qs=S.pbOf.map((p,q)=>p===k?q:-1).filter(q=>q>=0); if(!qs.length) return false;
  for(let i=from;i<S.hist.length;i++) qs.forEach(q=>S.hist[i][q]=v);
  if(seqResim(S.hist.length)) seqShow(S.idx);
  return true;
}
document.addEventListener("mousedown", e=>{
  const p=e.target.closest && e.target.closest('#simPcb .pbtn'); if(!p) return;
  if(typeof RT==="object" && RT.on) return;                      // real-time mode has its own handler (16-…)
  const d=[...document.querySelectorAll('#simPcb .pbtn')].indexOf(p); if(d<0 || d>4) return;
  const k=PB_DOM_ORDER[d];
  let up=null;
  if(SIM_SEQ){ const at=SIM_SEQ.idx;
    if(!pbSeqSet(k, 1, at)) return;
    up=()=>pbSeqSet(k, 0, Math.max(SIM_SEQ?SIM_SEQ.idx:0, at+1)); }
  else if(SIM_PINMAP && SIM_LAST_TT && SIM_REDRAW){
    const key="pb:"+k; if(!SIM_LAST_TT.inputs.some(n=>SIM_PINMAP.inMap[n]===key)) return;
    SIM_SW[key]=1; SIM_REDRAW(); pbCombLabels();
    up=()=>{ SIM_SW[key]=0; SIM_REDRAW(); pbCombLabels(); }; }
  else return;
  p.classList.add("pb-down");
  const rel=()=>{ document.removeEventListener("mouseup", rel, true); p.classList.remove("pb-down"); up(); };
  document.addEventListener("mouseup", rel, true);
  e.preventDefault();
}, true);
