/* ===== 57. VHDL blocks: a block on the sheet whose inside is VHDL text =================================
   For the parts that are painful to draw as gates — a counter that steps by 3, a ROM / character
   table, a state machine written as a case — the user (or the AI) writes VHDL, and the block is
   placed and wired like any other. It is a custom component {name, vhdl, ports} (the core already
   emitted a custom's `vhdl` text into the design), its pins come from the entity's ports, and every
   browser simulator runs the text through 56-vhdl-sim.js: the truth-table board, clock by clock,
   the probe, specs / compare_sheets (they all go through probeModel + probeSettle). Real-time mode
   (16) does not run it (the button is hidden for such a sheet).
   Made in Tools ▸ "บล็อก VHDL" / the Modules tab / MCP vhdl_block; double-click a placed one to edit. */
const VHB={cache:new Map(), init:new WeakMap(), runErr:{}};
function vhdlCompileCached(text){
  let r=VHB.cache.get(text);
  if(!r){ try{ r={M:vhCompile(text)}; }catch(e){ r={error:e.message, line:e.line||0}; }
    VHB.cache.set(text, r); if(VHB.cache.size>64) VHB.cache.delete(VHB.cache.keys().next().value); }
  return r;
}
/* the custom behind a CUSTOM:<name> type when it is a VHDL block (compiled or not) */
function vhdlCustomOf(type){
  if(typeof type!=="string" || !type.startsWith("CUSTOM:")) return null;
  const cc=(state.project.customs||{})[type.slice(7)];
  return cc && typeof cc.vhdl==="string" && !cc.schematic ? cc : null;
}
function vhdlBlockOf(c){
  const cc=c && vhdlCustomOf(c.type); if(!cc) return null;
  const r=vhdlCompileCached(cc.vhdl);
  if(r.M){ if(r.M.sequential) PROBE_SEQ[c.type]=1; else delete PROBE_SEQ[c.type]; }
  return r.M||null;
}
function vhdlInitState(M){ let s=VHB.init.get(M); if(!s){ s=vhInitState(M); VHB.init.set(M, s); } return s; }
/* pin id on the sheet (the port name as written) ↔ the model's port (lower case) */
const vhdlPinOf=p=>p.raw;
function vhdlNum(x){ return !x ? 0 : x.k==="sl" ? x.v : x.k==="vec" ? x.v>>>0 : x.k==="bool" ? (x.v?1:0) : 0; }
function vhdlInputs(c, M, get){ const o={}; M.ports.filter(p=>p.dir==="in").forEach(p=>{ const v=get(vhdlPinOf(p)); o[p.name]=v==null?0:v; }); return o; }
/* one output pin of a placed VHDL block, at the inputs it sees now (outputs of other parts) */
function vhdlBlockOut(c, pid, get){
  const M=vhdlBlockOf(c); if(!M) return null;
  const ins=vhdlInputs(c, M, get), st=PROBE_FF[c.id]||vhdlInitState(M);
  let byIns=VHB.memo && VHB.memo.get(st); if(!byIns){ VHB.memo=VHB.memo||new WeakMap(); byIns=new Map(); VHB.memo.set(st, byIns); }
  const key=JSON.stringify(ins);
  let out=byIns.get(key);
  if(!out){ try{ out=vhRun(M, st, ins, null).sig; delete VHB.runErr[c.type]; }catch(e){ VHB.runErr[c.type]=e.message; return null; }
    byIns.set(key, out); if(byIns.size>4096) byIns.clear(); }
  const p=M.ports.find(x=>x.raw===pid||x.name===String(pid).toLowerCase()); if(!p) return null;
  return vhdlNum(out[p.name]);
}
/* flip-flops and VHDL blocks see the same pre-edge values; async resets / combinational state settle first */
{
  const _settle=probeSettle;
  probeSettle=function(fsch, st){
    const vbs=(fsch.components||[]).filter(c=>vhdlBlockOf(c));
    if(!vbs.length) return _settle.apply(this, arguments);
    const ffs=fsch.components.filter(c=>PROBE_SEQ[c.type] && !vhdlCustomOf(c.type));
    st=st||probeStruct(fsch);
    const stEq=(a,b)=>a===b || JSON.stringify(a)===JSON.stringify(b);
    for(let round=0; round<48; round++){
      const m=probeModel(fsch, st); let moved=false;
      ffs.forEach(c=>{ const p=c.params||{};
        const r=p.reset?m.inVal(c.id,"rst"):null, s=p.preset?m.inVal(c.id,"pre"):null;
        const want = r===1?0 : s===1?1 : null;
        if(want!=null && (PROBE_FF[c.id]?1:0)!==want){ PROBE_FF[c.id]=want; moved=true; } });
      vbs.forEach(c=>{ const M=vhdlBlockOf(c), old=PROBE_FF[c.id]||vhdlInitState(M);
        let ns; try{ ns=vhRun(M, old, vhdlInputs(c, M, p=>m.inVal(c.id,p)), null); }catch(e){ VHB.runErr[c.type]=e.message; return; }
        if(!stEq(old, ns)){ PROBE_FF[c.id]=ns; moved=true; } });
      if(moved) continue;
      const edges=[];
      ffs.forEach(c=>{ const clk=m.inVal(c.id,"clk"), prev=PROBE_PREV[c.id]; PROBE_PREV[c.id]=clk;
        if(prev==null||clk==null||prev===clk) return;
        const rising=!(c.params&&c.params.edge==="falling");
        if((clk===1)===rising) edges.push(c); });
      const vEdges=[];
      vbs.forEach(c=>{ const M=vhdlBlockOf(c), ins=vhdlInputs(c, M, p=>m.inVal(c.id,p)), prevIns=Object.assign({}, ins); let any=false;
        M.clockPorts.forEach(n=>{ const k=c.id+"|"+n, pv=PROBE_PREV[k]; PROBE_PREV[k]=ins[n]; if(pv!=null && pv!==ins[n]){ prevIns[n]=pv; any=true; } });
        if(any) vEdges.push({c, M, ins, prevIns}); });
      if(!edges.length && !vEdges.length) return;
      const next=new Map();
      edges.forEach(c=>{
        const p=c.params||{}, q=PROBE_FF[c.id]?1:0, g=pin=>m.inVal(c.id,pin);
        let n=null;
        if(c.type==="DFF"){ n=g("d"); }
        else if(c.type==="TFF"){ const t=g("t"); n=t==null?null:(t?1-q:q); }
        else if(c.type==="JKFF"){ const j=g("j"), k=g("k"); n=(j==null||k==null)?null:((j&&k)?1-q:(j?1:(k?0:q))); }
        else if(c.type==="SRFF"){ const s=g("s"), r=g("r"); n=(s==null||r==null)?null:((s&&!r)?1:(!s&&r?0:q)); }
        const held=(p.reset&&g("rst")===1)||(p.preset&&g("pre")===1);
        if(n!=null && !held) next.set(c.id,n?1:0);
      });
      vEdges.forEach(({c, M, ins, prevIns})=>{ try{ next.set(c.id, vhRun(M, PROBE_FF[c.id]||vhdlInitState(M), ins, prevIns)); }catch(e){ VHB.runErr[c.type]=e.message; } });
      next.forEach((v,id)=>{ PROBE_FF[id]=v; });
    }
  };
}
/* the sheet INPUTs that drive a VHDL block's clock port are clocks too (stepped by clientSeqSim) */
{
  const _pe=probeEval;
  probeEval=function(sch){
    const r=_pe.apply(this, arguments);
    try{ const flat=flattenSchematic(sch).sch, vbs=flat.components.filter(c=>vhdlBlockOf(c));
      if(vbs.length){ const m=probeModel(flat, probeStruct(flat));
        vbs.forEach(c=>{ const M=vhdlBlockOf(c); M.clockPorts.forEach(n=>{ const p=M.portBy.get(n), s=m.source(c.id, vhdlPinOf(p)); if(s && s.type==="IN") r.clocks.add(s.cid); }); }); } }catch(_){}
    return r; };
  // register sequential VHDL blocks before anyone asks PROBE_SEQ whether a sheet has flip-flops
  const _flat=flattenSchematic;
  flattenSchematic=function(top){
    const r=_flat.apply(this, arguments);
    (r.sch.components||[]).forEach(c=>{ const cc=vhdlCustomOf(c.type); if(!cc) return;
      if(!vhdlBlockOf(c)){ const e=vhdlCompileCached(cc.vhdl).error; const w=`บล็อก VHDL ${cc.name}: ${e}`; if(!r.warns.includes(w)) r.warns.push(w); } });
    return r; };
  // the simulators say why a VHDL block gave no value
  const note=(sch, j)=>{ try{ if(!j || !j.ok) return j;
      const flat=flattenSchematic(sch), msgs=[...flat.warns.filter(w=>/^บล็อก VHDL/.test(w))];
      new Set(flat.sch.components.map(c=>c.type)).forEach(t=>{ if(VHB.runErr[t]) msgs.push(`บล็อก VHDL ${t.slice(7)}: ${VHB.runErr[t]}`); });
      if(msgs.length) j.note=[j.note, ...msgs].filter(Boolean).join(" · "); }catch(_){} return j; };
  const _cs=clientCombSim; clientCombSim=function(sch){ return note(sch, _cs.apply(this, arguments)); };
  const _ss=clientSeqSim;  clientSeqSim=function(sch){ return note(sch, _ss.apply(this, arguments)); };
  // real-time mode does not run VHDL text
  if(typeof rtAvailable==="function"){ const _rt=rtAvailable;
    rtAvailable=function(sch){ try{ if(flattenSchematic(sch).sch.components.some(c=>vhdlCustomOf(c.type))) return null; }catch(_){} return _rt.apply(this, arguments); }; }
}
/* drawn with "(VHDL)" under the name; double-click opens the text */
{
  const _td=customTypeDef;
  customTypeDef=function(cc){ const td=_td.apply(this, arguments);
    if(cc && typeof cc.vhdl==="string" && !cc.schematic){ const sh=td.shape; td.shape=p=>sh(p).replace("(custom)","(VHDL)").replace("<rect ", "<title>บล็อก VHDL — ดับเบิลคลิกเพื่อแก้โค้ด</title><rect "); }
    return td; };
  const _wiz=openWizard;
  openWizard=function(name){ const cc=name && (state.project.customs||{})[name];
    if(cc && typeof cc.vhdl==="string" && !cc.schematic) return vhdlBlockDialog(name);
    return _wiz.apply(this, arguments); };
}

/* ---------- create / update ---------- */
/* compile → {name, ports} or throws (message in Thai, with the line) */
function vhdlBlockCheck(text){
  const r=vhdlCompileCached(String(text||""));
  if(r.error){ const e=new Error(r.error); e.line=r.line; throw e; }
  const M=r.M, name=M.raw;
  if(sanId(name)!==name.toLowerCase()) throw new Error(`ชื่อ entity '${name}' ใช้ไม่ได้ (เป็นคำสงวนของ VHDL หรือมีตัวอักษรพิเศษ) — เปลี่ยนชื่อ entity`);
  const clash=Object.values(state.project.schematics).find(s=>sanId(s.name)===sanId(name));
  if(clash) throw new Error(`ชื่อ entity '${name}' ซ้ำกับแผ่น '${clash.name}' — VHDL จะมี entity ชื่อเดียวกันสองตัว เปลี่ยนชื่อ entity`);
  return {M, name, ports:M.ports.map(p=>({name:p.raw, dir:p.dir, width:p.width}))};
}
/* save the text as a VHDL block (new, or replacing `old`); returns the block's name */
function vhdlBlockSave(text, old){
  const k=vhdlBlockCheck(text), C=state.project.customs=state.project.customs||{};
  const other=Object.keys(C).find(n=>n.toLowerCase()===k.name.toLowerCase() && n!==old);
  if(other) throw new Error(`มีคอมโพเนนต์ชื่อ ${other} อยู่แล้ว — ตั้งชื่อ entity ใหม่ หรือแก้ตัวเดิม`);
  const prev=old && C[old];
  if(prev && !(typeof prev.vhdl==="string" && !prev.schematic)) throw new Error(`${old} ไม่ใช่บล็อก VHDL`);
  const cc={name:k.name, vhdl:String(text), ports:k.ports, description:(prev&&prev.description)||"บล็อก VHDL"};
  if(old && old!==k.name){ delete C[old]; C[k.name]=cc; rewriteInstanceType("CUSTOM:"+old, "CUSTOM:"+k.name); delete PROBE_SEQ["CUSTOM:"+old]; }
  else C[k.name]=cc;
  // wires on pins the new text no longer has are dropped (the block's pins come from its ports)
  const keep=new Set(k.ports.map(p=>p.name));
  Object.values(state.project.schematics).forEach(s=>{
    const ids=new Set(s.components.filter(c=>c.type==="CUSTOM:"+k.name).map(c=>c.id)); if(!ids.size) return;
    s.wires=s.wires.filter(w=>!((ids.has(w.from.cid)&&!keep.has(w.from.pid)) || (ids.has(w.to.cid)&&!keep.has(w.to.pid)))); });
  return {name:k.name, ports:k.ports, sequential:k.M.sequential, clocks:k.M.clockPorts, warnings:k.M.warns.slice()};
}
/* place one on a sheet at a free spot; returns the component */
function vhdlBlockPlace(name, sch, at){
  sch=sch||activeSch(); const type="CUSTOM:"+name, td=customTypeDef(state.project.customs[name]);
  const sz=td.size({}), p=at || (typeof mcpFreeSpot==="function" ? mcpFreeSpot(sch, sz.w, sz.h, type) : {x:snap(120), y:snap(120)});
  const c={id:uid("c"), type, x:p.x, y:p.y, params:{}, label:""};
  sch.components.push(c); return c;
}
const VHDL_TEMPLATE=`library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- ตัวอย่าง: ตัวนับ 0, 3, 6, … , 99 แล้วกลับ 0 (นับเมื่อ en = '1', clr = ล้าง)
entity count3 is
  port ( clk : in  std_logic;
         en  : in  std_logic;
         clr : in  std_logic;
         q   : out std_logic_vector(6 downto 0) );
end count3;

architecture rtl of count3 is
  signal cnt : unsigned(6 downto 0) := (others => '0');
begin
  process(clk)
  begin
    if rising_edge(clk) then
      if clr = '1' or cnt = 99 then
        cnt <= (others => '0');
      elsif en = '1' then
        cnt <= cnt + 3;
      end if;
    end if;
  end process;
  q <= std_logic_vector(cnt);
end rtl;
`;
function vhdlBlockDialog(editName){
  const cc=editName ? state.project.customs[editName] : null;
  const m=uxModal(cc?`แก้บล็อก VHDL — ${esc(editName)}`:"บล็อก VHDL ใหม่", `
    <div class="muted" style="margin-bottom:6px">เขียน entity + architecture หนึ่งชุด — ขาของบล็อกมาจาก port ของ entity (std_logic / std_logic_vector / unsigned / signed) ·
      จำลองในโปรแกรมได้ทุกโหมด ยกเว้นเล่นเวลาจริง · ใช้ได้: signal, constant, type enum / array (ตาราง ROM), process + if / case / for, rising_edge, when-else, with-select, numeric_std</div>
    <textarea class="vhb-text" spellcheck="false" wrap="off">${esc(cc?cc.vhdl:VHDL_TEMPLATE)}</textarea>
    <div class="vhb-status" id="vhbStatus"></div>`,
    {width:760, foot:`<button class="btn" id="vhbCheck">ตรวจโค้ด</button>${cc?"":`<button class="btn" id="vhbSave">บันทึก</button>`}<button class="btn btn-primary" id="vhbPlace">${cc?"บันทึก":"บันทึกแล้ววางบนแผ่นนี้"}</button>`, sticky:true});
  const ta=m.querySelector(".vhb-text"), st=m.querySelector("#vhbStatus");
  ta.addEventListener("keydown", e=>{ if(e.key==="Tab"){ e.preventDefault(); const a=ta.selectionStart; ta.setRangeText("  ", a, ta.selectionEnd, "end"); } });
  const show=()=>{ try{ const k=vhdlBlockCheck(ta.value);
      const io=d=>k.ports.filter(p=>p.dir===d).map(p=>p.width>1?`${p.name}[${p.width-1}:0]`:p.name).join(", ")||"—";
      st.className="vhb-status ok";
      st.innerHTML=`✓ <b>${esc(k.name)}</b> · ขาเข้า ${esc(io("in"))} · ขาออก ${esc(io("out"))} · ${k.M.sequential?`มี clock (${esc(k.M.clockPorts.join(", ")||"สัญญาณภายใน")})`:"combinational"}`
        +(k.M.warns.length?`<br>⚠ ${k.M.warns.map(esc).join("<br>⚠ ")}`:"");
      return k; }
    catch(e){ st.className="vhb-status bad"; st.textContent="✗ "+e.message;
      if(e.line){ const L=ta.value.split("\n"); let a=0; for(let i=0;i<e.line-1&&i<L.length;i++) a+=L[i].length+1; ta.focus(); ta.setSelectionRange(a, a+((L[e.line-1]||"").length)); }
      return null; } };
  let tm=null; ta.addEventListener("input", ()=>{ clearTimeout(tm); tm=setTimeout(show, 500); });
  m.querySelector("#vhbCheck").onclick=show; show();
  const save=place=>{ if(!show()) return;
    try{ const r=vhdlBlockSave(ta.value, editName||null);
      if(place && !editName){ const c=vhdlBlockPlace(r.name, activeSch()); snapshot(); renderAll(); try{ focusComp(activeSch().id, c.id); }catch(_){} }
      else { snapshot(); renderAll(); }
      try{ renderModulesPane(); }catch(_){}
      m.close(); toast(`${editName?"บันทึก":"สร้าง"}บล็อก VHDL ${r.name} แล้ว${place&&!editName?" — วางบนแผ่นนี้แล้ว ต่อสายได้เลย":""}`,"ok",4000);
    }catch(e){ st.className="vhb-status bad"; st.textContent="✗ "+e.message; } };
  m.querySelector("#vhbPlace").onclick=()=>save(true);
  const sv=m.querySelector("#vhbSave"); if(sv) sv.onclick=()=>save(false);
  setTimeout(()=>ta.focus(), 30);
}
/* Tools menu + the Modules tab */
GENERATORS.push({id:"vhdl_block", icon:"⌨", name:"บล็อก VHDL (เขียนโค้ด)", desc:"บล็อกที่ข้างในเป็นโค้ด VHDL — วางบนแผ่นแล้วต่อสายได้ จำลองได้", run:()=>vhdlBlockDialog(null)});
{
  const last=[...document.querySelectorAll('#menu [data-gen]')].pop();
  if(last && !document.querySelector('#menu [data-gen="vhdl_block"]')){
    last.insertAdjacentHTML("afterend", `<button class="gen-mi" data-gen="vhdl_block" title="บล็อกที่ข้างในเป็นโค้ด VHDL"><span class="gi">⌨</span>บล็อก VHDL (เขียนโค้ด)…</button>`);
    document.querySelector('#menu [data-gen="vhdl_block"]').addEventListener("click", ()=>runGenerator("vhdl_block"));
  }
}
{
  const _cards=moduleCardsHtml;
  moduleCardsHtml=function(){
    const h=_cards.apply(this, arguments);
    const L=Object.values(state.project.customs||{}).filter(cc=>typeof cc.vhdl==="string" && !cc.schematic);
    const vb=`<div class="pt-sec vhb-sec"><div class="pt-h">บล็อก VHDL ในโปรเจกต์นี้ <button class="btn2 vhb-new" data-vhb="new">＋ บล็อก VHDL ใหม่</button></div>`
      +(L.length?L.map(cc=>`<div class="vhb-row"><b>${esc(cc.name)}</b><small>${esc((cc.ports||[]).map(p=>p.width>1?`${p.name}[${p.width-1}:0]`:p.name).join(", "))}</small>
        <button class="btn2" data-vhb="place" data-n="${escA(cc.name)}">วาง</button><button class="btn2" data-vhb="edit" data-n="${escA(cc.name)}">แก้</button></div>`).join(""):`<div class="muted" style="font-size:11.5px">ยังไม่มี — เขียนโค้ดสำหรับส่วนที่วาดเป็นเกตยาก (นับทีละ 3, ตาราง ROM, FSM)</div>`)
      +`</div>`;
    // after the ready-made parts, before the user's own modules
    const sec=vb, at=h.indexOf('<div class="pt-h pt-mine">');
    return at>=0 ? h.slice(0,at)+sec+h.slice(at) : sec+h;
  };
  document.addEventListener("click", ev=>{
    const b=ev.target.closest && ev.target.closest("[data-vhb]"); if(!b) return;
    const a=b.dataset.vhb, n=b.dataset.n;
    if(a==="new") vhdlBlockDialog(null);
    else if(a==="edit") vhdlBlockDialog(n);
    else if(a==="place"){ const sch=activeSch(); if(!sch) return; const c=vhdlBlockPlace(n, sch); snapshot(); renderAll(); try{ focusComp(sch.id, c.id); }catch(_){} toast(`วาง ${n} แล้ว`,"ok"); }
  });
}

/* ---------- MCP ---------- */
MCP_OPS.vhdl_block = a=>{
  const text=String(a.vhdl||"");
  if(!text.trim()) mcpFail("vhdl is required: one entity + its architecture", "ports: std_logic / std_logic_vector / unsigned / signed");
  let k; try{ k=vhdlBlockCheck(text); }catch(e){ mcpFail("VHDL: "+e.message, "fix the text and call again (the block was not saved)"); }
  const old=a.replace||((state.project.customs||{})[k.name] ? k.name : null);
  mcpBeforeChange("บล็อก VHDL "+k.name);
  let r; try{ r=vhdlBlockSave(text, old); }catch(e){ mcpFail(e.message); }
  let placed=null;
  if(a.sheet){ const sch=mcpUse(a.sheet); const c=vhdlBlockPlace(r.name, sch, a.x!=null&&a.y!=null?{x:snap(a.x), y:snap(a.y)}:null);
    if(a.label) c.label=String(a.label); placed={sheet:sch.name, id:c.id, label:c.label||null}; mcpCommit(sch); }
  else { snapshot(); renderAll(); }
  return Object.assign(r, {placed, type:"CUSTOM:"+r.name,
    note:"pins = the entity's ports; place more with add_component {type:'vhdl:"+r.name+"'}; simulate / probe / compare_sheets run the VHDL in the browser"});
};
{
  const _add=MCP_OPS.add_component;
  MCP_OPS.add_component=function(a){
    const t=String((a&&a.type)||"");
    const m=/^(?:vhdl|custom):(.+)$/i.exec(t);
    if(m){ const n=Object.keys(state.project.customs||{}).find(x=>x.toLowerCase()===m[1].trim().toLowerCase());
      if(!n) mcpFail(`no VHDL block '${m[1]}'`, "create it with vhdl_block first");
      const sch=mcpUse(a.sheet); mcpBeforeChange("วาง "+n);
      const c=vhdlBlockPlace(n, sch, a.x!=null&&a.y!=null?{x:snap(a.x), y:snap(a.y)}:null); if(a.label||a.name) c.label=String(a.label||a.name);
      mcpCommit(sch);
      return {id:c.id, type:c.type, label:c.label||null, pins:customPorts(state.project.customs[n]).map(p=>({pin:p.name, dir:p.dir, width:p.width}))}; }
    return _add.apply(this, arguments);
  };
}
