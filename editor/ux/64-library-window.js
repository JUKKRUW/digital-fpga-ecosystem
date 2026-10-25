/* ===== 64. The part / module library as a window (Tools ▸ คลังชิ้นส่วนและโมดูล), not a side tab =========
   The Modules tab squeezed 50 parts and the user's modules into a 240 px column, under groups that made little
   sense (debounce under "เก็บข้อมูล"). Now: a big window, categories on the left (regrouped by what a part is
   FOR), cards on the right, one search over everything. The user's own modules sit in the category they pick
   when saving (or "กองกลาง" — not sorted), or in a category of their own; the project's VHDL blocks have one.
   The Modules tab is gone; #modulesPane stays (hidden) so older code that renders it still works. */
const LIB_CATS=[
  {id:"arith", icon:"±", label:"บวก / ลบ / คูณ", kinds:["half_adder","full_adder","adder","half_subtractor","full_subtractor","subtractor","addsub","multiplier"]},
  {id:"alu", icon:"ƒ", label:"ALU", kinds:["alu_slice","alu"]},
  {id:"cmp", icon:"≷", label:"เปรียบเทียบ / ตรวจสอบ", kinds:["cmp_slice","comparator","bcd2_compare","bcd_valid","parity","majority"]},
  {id:"sel", icon:"⇶", label:"MUX / DEMUX / Decoder / Encoder", kinds:["mux","mux_bus","demux","decoder","encoder"]},
  {id:"conv", icon:"⇄", label:"แปลงรหัส", kinds:["bin2bcd","add3","tc_decode","bcd_ascii"]},
  {id:"seg", icon:"8", label:"จอ 7-segment", kinds:["bcd_7seg","hex_7seg","char_7seg","seg7_mux4","text_scroll"]},
  {id:"led", icon:"◉", label:"ไฟ LED / PWM", kinds:["led_pattern","pwm"]},
  {id:"ff", icon:"▤", label:"Flip-flop / Register", kinds:["toggle","register","register_en","shift_register"]},
  {id:"cnt", icon:"↻", label:"ตัวนับ", kinds:["binary_counter","mod_counter","bcd_counter","counter_digit","bcd_counter_multi","seq_counter","jk_counter"]},
  {id:"clk", icon:"÷", label:"นาฬิกา / หารความถี่", kinds:["clock_divider","divider_chain"]},
  {id:"btn", icon:"⊓", label:"ปุ่มกด / ขอบสัญญาณ", kinds:["debounce","one_pulse","edge_detector"]},
  {id:"lab", icon:"◈", label:"ระบบทั้งแลป", kinds:["lab6_counter","lab7_countdown"]},
];
const LIB_COMMON="กองกลาง";
const LIB={cat:"all", q:""};
/* the parts take the new groups (the agent's list_parts and the old pane read P.group) */
function libRegroup(){
  const seen=new Set();
  LIB_CATS.forEach(c=>c.kinds.forEach(k=>{ if(PARTS[k]){ PARTS[k].group=c.label; seen.add(k); } }));
  Object.entries(PARTS).forEach(([k,P])=>{ if(!seen.has(k)) P.group=P.group||"อื่นๆ"; });
}
libRegroup();
function libPartCat(k){ const c=LIB_CATS.find(c=>c.kinds.includes(k)); return c ? c.id : "other"; }
function libModCat(m){ const c=String(m.cat||"").trim(); if(!c || c===LIB_COMMON) return "mine";
  const b=LIB_CATS.find(x=>x.label===c || x.id===c); return b ? b.id : "u:"+c; }
function libCustomCats(){ loadModules(); return [...new Set(Object.values(state.modules||{}).map(libModCat).filter(c=>c.startsWith("u:")))].sort(); }
function libVhdlBlocks(){ return Object.values(state.project.customs||{}).filter(cc=>typeof cc.vhdl==="string" && !cc.schematic); }
function libHit(text){ const q=LIB.q.trim().toLowerCase(); return !q || q.split(/\s+/).every(w=>text.toLowerCase().includes(w)); }

/* ---- the items of a category (or all, or the search) ---- */
function libItems(cat){
  loadModules();
  const parts=Object.entries(PARTS).filter(([k,P])=>(cat==="all" || libPartCat(k)===cat) && libHit(k+" "+P.label+" "+P.desc+" "+P.group))
    .map(([k,P])=>({kind:"part", k, P}));
  const mods=Object.values(state.modules||{}).filter(m=>(cat==="all" || libModCat(m)===cat) && (!LIB.q.trim() || moduleMatch(m, LIB.q.trim())))
    .sort((a,b)=>(b.ts||0)-(a.ts||0)).map(m=>({kind:"mod", m}));
  const vhb=(cat==="all" || cat==="vhdl") ? libVhdlBlocks().filter(cc=>libHit(cc.name+" vhdl "+(cc.ports||[]).map(p=>p.name).join(" "))).map(cc=>({kind:"vhdl", cc})) : [];
  return mods.concat(parts, vhb);
}
function libCatList(){
  const n=c=>libItems(c).length;
  const L=LIB_CATS.map(c=>({id:c.id, icon:c.icon, label:c.label}));
  L.push({sep:true});
  L.push({id:"mine", icon:"▣", label:"โมดูลของฉัน — "+LIB_COMMON});
  libCustomCats().forEach(c=>L.push({id:c, icon:"▢", label:c.slice(2)}));
  L.push({id:"vhdl", icon:"‹›", label:"บล็อก VHDL ในโปรเจกต์นี้"});
  return [{id:"all", icon:"▦", label:"ทั้งหมด"}].concat(L).map(x=>x.sep ? x : Object.assign(x, {n:n(x.id)}));
}
/* the part's pins at the form's starting settings: "Input: a[3:0], b[3:0], cin · Output: s[3:0], cout" */
function libPortsHtml(k){
  try{ const P=PARTS[k], d={}; Object.entries(P.params||{}).forEach(([n,s])=>d[n]=s.uiDef!==undefined?s.uiDef:s.def);
    const pp=P.ports(partParams(k, d)), fmt=o=>Object.entries(o).filter(([,w])=>w>0).map(([b,w])=>w>1?`${b}[${w-1}:0]`:b).join(", ");
    return `<div class="lib-io"><div><b>Input:</b> ${esc(fmt(pp.in))||"—"}</div><div><b>Output:</b> ${esc(fmt(pp.out))||"—"}</div></div>`; }
  catch(_){ return ""; }
}
function libCardHtml(it){
  if(it.kind==="part"){ const P=it.P;
    return `<div class="lib-card part" data-libpart="${esc(it.k)}" title="${esc(P.desc)}">
      <div class="lib-ct"><b>${esc(P.label)}</b> <span class="pt-badge ok" title="จำลองเทียบโมเดลอ้างอิงทุกครั้งที่สร้าง">✓ ตรวจทุกครั้ง</span></div>
      <div class="lib-cd">${esc(P.desc)}</div>
      ${libPortsHtml(it.k)}${LIB.q?`<div class="lib-grp muted">${esc(P.group)}</div>`:""}</div>`; }
  if(it.kind==="vhdl"){ const cc=it.cc;
    return `<div class="lib-card"><div class="lib-ct"><b>${esc(cc.name)}</b> <span class="pt-badge">VHDL</span></div>
      <div class="lib-cd">${esc((cc.ports||[]).map(p=>p.width>1?`${p.name}[${p.width-1}:0]`:p.name).join(", "))}</div>
      <div class="lib-ca"><button class="btn btn-primary" data-vhb="place" data-n="${escA(cc.name)}">วางบนแผ่นนี้</button><button class="btn" data-vhb="edit" data-n="${escA(cc.name)}">แก้โค้ด</button></div></div>`; }
  const m=it.m;
  const ok=m.verified && !/^not verified/.test(m.verified);
  let old=0; try{ old=moduleInstances(m).filter(x=>x.outdated && x.projectId===state.activeProjectId).length; }catch(_){}
  const cat=libModCat(m), catName=cat==="mine" ? LIB_COMMON : cat.startsWith("u:") ? cat.slice(2) : (LIB_CATS.find(c=>c.id===cat)||{}).label;
  return `<div class="lib-card mod">
    <div class="lib-row"><div class="mod-thumb">${thumbnailSvg(m.schematic)}</div><div style="min-width:0;flex:1">
      <div class="lib-ct"><b>${esc(m.name)}</b> <span class="pt-badge ${ok?"ok":""}" title="${esc(m.verified||"ยังไม่ได้ตรวจเทียบกับข้อกำหนด")}">${ok?"✓ ตรวจแล้ว":"ยังไม่ได้ตรวจ"}</span> <span class="pt-badge">v${m.version||1}</span> <span class="pt-badge mine">ของฉัน</span></div>
      <div class="lib-cd">${esc(m.desc||"— ไม่มีคำอธิบาย —")}</div>
      <div class="mod-io">${modIoSummary(m.schematic)}${LIB.q?` · ${esc(catName)}`:""}</div></div></div>
    <div class="lib-ca"><button class="btn btn-primary" data-libuse="${esc(m.id)}" title="วางเป็นบล็อกบนแผ่นที่เปิดอยู่">วางเป็นบล็อก</button>
      <button class="btn" data-libopen="${esc(m.id)}" title="เปิดเป็นแผ่นใหม่ในโปรเจกต์นี้ (แก้ไขได้)">เปิดเป็นแผ่น</button>
      ${old?`<button class="btn" data-modupd="${esc(m.id)}" title="แผ่นในโปรเจกต์นี้ยังเป็นเวอร์ชันเก่า">อัปเดต ${old}</button>`:""}
      <button class="btn" data-libedit="${esc(m.id)}" title="แก้ชื่อ / คำอธิบาย / หมวด">✎</button>
      <button class="btn" data-libdel="${esc(m.id)}" title="ลบออกจากคลัง">🗑</button></div></div>`;
}
function libRender(win){
  win=win||document.querySelector(".lib-win"); if(!win) return;
  const cats=libCatList();
  if(LIB.cat!=="all" && !cats.some(c=>c.id===LIB.cat)) LIB.cat="all";
  win.querySelector(".lib-side").innerHTML=cats.map(c=>c.sep?`<div class="lib-sep">ของฉัน</div>`:
    `<button class="lib-cat ${c.id===LIB.cat?"on":""}" data-libcat="${esc(c.id)}"><span class="ic">${c.icon}</span><span class="lb">${esc(c.label)}</span><span class="n">${c.n}</span></button>`).join("");
  // a search looks through every category
  const cur=cats.find(c=>c.id===LIB.cat)||cats[0], items=libItems(LIB.q.trim() ? "all" : LIB.cat);
  const empty=LIB.cat==="vhdl" ? `ยังไม่มีบล็อก VHDL ในโปรเจกต์นี้ — เขียนโค้ดสำหรับส่วนที่วาดเป็นเกตยาก (นับทีละ 3, ตาราง ROM, FSM)`
    : LIB.q ? `ไม่พบ “${esc(LIB.q)}”` : `ยังไม่มีโมดูลในหมวดนี้ — เปิดแผ่นที่ต้องการ แล้วกด “＋ เก็บแผ่นที่เปิดอยู่เข้าคลัง” เลือกหมวดนี้`;
  // "ทั้งหมด": a section per category, in the sidebar's order
  const body=LIB.cat==="all" && !LIB.q.trim()
    ? cats.filter(c=>!c.sep && c.id!=="all" && c.n).map(c=>`<div class="lib-sh" data-libcat="${esc(c.id)}"><span class="ic">${c.icon}</span> ${esc(c.label)} <span class="muted">${c.n}</span></div>
        <div class="lib-grid">${libItems(c.id).map(libCardHtml).join("")}</div>`).join("")
    : `<div class="lib-grid">${items.length?items.map(libCardHtml).join(""):`<div class="muted lib-empty">${empty}</div>`}</div>`;
  win.querySelector(".lib-main").innerHTML=`<div class="lib-mh"><b><span class="ic">${cur.icon}</span> ${esc(LIB.q?`ผลค้นหา “${LIB.q}”`:cur.label)}</b>
      ${LIB.cat==="vhdl"?`<button class="btn" data-vhb="new">＋ บล็อก VHDL ใหม่</button>`:""}</div>`+body;
}
function openLibrary(cat){
  if(cat) LIB.cat=cat;
  libRegroup();                                   // parts added by later files (65) take their category too
  document.querySelectorAll(".lib-bg").forEach(x=>x.close());
  const m=uxModal("คลังชิ้นส่วนและโมดูล", `<div class="lib-win">
      <div class="lib-top"><input class="mod-search" id="libSearch" type="search" autocomplete="off" spellcheck="false" placeholder="🔍 ค้นหา (ชื่อ / คำอธิบาย / ชื่อขา) — เช่น 7-seg, หาร, mux" value="${esc(LIB.q)}">
        <button class="btn btn-primary" id="libSave">＋ เก็บแผ่นที่เปิดอยู่เข้าคลัง</button></div>
      <div class="lib-body"><div class="lib-side"></div><div class="lib-main"></div></div>
      <div class="muted lib-foot">ชิ้นส่วนสำเร็จรูปถูกสร้างด้วยโปรแกรมและจำลองเทียบโมเดลอ้างอิงทุกครั้ง · โมดูลของฉันเก็บในเครื่องนี้ ใช้ได้ทุกโปรเจกต์</div></div>`, {width:1080});
  m.classList.add("lib-bg");
  const win=m.querySelector(".lib-win");
  libRender(win);
  const si=m.querySelector("#libSearch");
  si.addEventListener("input", ()=>{ LIB.q=si.value; libRender(win); });
  m.querySelector("#libSave").onclick=()=>libSaveDialog(LIB.cat);
  m.addEventListener("click", ev=>{
    const t=ev.target.closest("button, .lib-card, .lib-sh"); if(!t) return;
    const d=t.dataset;
    if(d.libcat){ LIB.cat=d.libcat; LIB.q=""; si.value=""; libRender(win); return; }
    if(d.libpart){ partDialog(d.libpart, {onDone:()=>m.close()}); return; }
    if(d.libuse){ m.close(); moduleUse(d.libuse); return; }
    if(d.libopen){ m.close(); moduleOpen(d.libopen); return; }
    if(d.libedit){ libSaveDialog(null, d.libedit); return; }
    if(d.libdel){ moduleDelete(d.libdel); return; }
    if(d.vhb==="place" || d.vhb==="new" || d.vhb==="edit") setTimeout(()=>{ if(d.vhb==="place") m.close(); }, 0);
  });
  setTimeout(()=>si.focus(), 30);
  return m;
}
/* save the open sheet (or edit a module): name, description, category — a built-in one, กองกลาง, or a new one */
function libSaveDialog(cat, editId){
  loadModules();
  const m0=editId ? state.modules[editId] : null, sch=activeSch();
  if(!m0 && (!sch || !(sch.components||[]).length)){ toast("แผ่นที่เปิดอยู่ยังไม่มีวงจร","warn"); return; }
  const curCat=m0 ? (libModCat(m0)==="mine" ? LIB_COMMON : libModCat(m0).startsWith("u:") ? libModCat(m0).slice(2) : (LIB_CATS.find(c=>c.id===libModCat(m0))||{}).label)
    : cat && cat!=="all" && cat!=="vhdl" ? (cat==="mine" ? LIB_COMMON : cat.startsWith("u:") ? cat.slice(2) : (LIB_CATS.find(c=>c.id===cat)||{}).label) : LIB_COMMON;
  const opts=[LIB_COMMON].concat(LIB_CATS.map(c=>c.label), libCustomCats().map(c=>c.slice(2)));
  const dlg=uxModal(m0 ? "แก้โมดูล “"+esc(m0.name)+"”" : "เก็บแผ่น “"+esc(sch.name)+"” เข้าคลัง", `
    <div class="row"><label>ชื่อโมดูล</label><input id="lsName" value="${esc(m0?m0.name:sch.name||"module")}" spellcheck="false"></div>
    <div class="row"><label>คำอธิบาย</label><input id="lsDesc" value="${esc(m0?m0.desc||"":"")}" placeholder="ไม่ใส่ก็ได้"></div>
    <div class="row"><label>หมวด</label><select id="lsCat">${opts.map(o=>`<option ${o===curCat?"selected":""}>${esc(o)}</option>`).join("")}<option value="__new">＋ หมวดใหม่…</option></select></div>
    <div class="row" id="lsNewRow" style="display:none"><label>ชื่อหมวดใหม่</label><input id="lsNew" placeholder="เช่น งานโปรเจกต์จบ"></div>
    <div class="muted" style="font-size:11.5px">${LIB_COMMON} = ไม่จัดหมวด · หมวดสำเร็จรูป (เช่น ตัวนับ) = แสดงคู่กับชิ้นส่วนสำเร็จรูปของหมวดนั้น${m0?"":" · บล็อกย่อยที่แผ่นนี้ใช้ถูกเก็บไปด้วย"}</div>`,
    {width:480, foot:`<button class="btn btn-primary" id="lsOk">${m0?"บันทึก":"เก็บเข้าคลัง"}</button>`});
  const sel=dlg.querySelector("#lsCat");
  sel.onchange=()=>{ dlg.querySelector("#lsNewRow").style.display=sel.value==="__new"?"":"none"; };
  dlg.querySelector("#lsOk").onclick=()=>{
    const name=dlg.querySelector("#lsName").value.trim(), desc=dlg.querySelector("#lsDesc").value.trim();
    let c=sel.value==="__new" ? dlg.querySelector("#lsNew").value.trim() : sel.value;
    if(!name){ toast("ใส่ชื่อโมดูล","warn"); return; }
    if(sel.value==="__new" && !c){ toast("ใส่ชื่อหมวดใหม่","warn"); return; }
    const b=LIB_CATS.find(x=>x.label===c); if(c===LIB_COMMON) c="";
    let m;
    if(m0){ m=m0; m.name=name; m.desc=desc; }
    else {
      const same=moduleFind(name);
      if(same && !confirm(`มีโมดูลชื่อ “${same.name}” อยู่แล้ว — เขียนทับ (เป็นเวอร์ชันใหม่)?`)) return;
      m=moduleSave(sch, name, desc, same?same.id:null);
      // the same stamp save_module (MCP) gives: verified only when the sheet passed a real check
      try{ m.verified=sheetVerified(sch) ? sch.verified.how : "not verified (saved from the library window)"; }catch(_){}
    }
    if(c) m.cat=b?b.id:c; else delete m.cat;
    saveModules(); dlg.close();
    try{ renderModulesPane(); }catch(_){}
    LIB.cat=libModCat(m); libRender();
    toast(`${m0?"บันทึก":"เก็บ"}โมดูล “${m.name}” ${c?"ในหมวด "+c:"ไว้ใน"+LIB_COMMON}แล้ว`+(!m0 && m.deps && m.deps.length?` (รวมบล็อกย่อย ${m.deps.length} แผ่น)`:""),"ok",4000);
  };
}
/* the old entry points open the window / the save form */
moduleImportCurrent=function(){ libSaveDialog(LIB.cat); };
moduleEditDesc=function(id){ libSaveDialog(null, id); };
{
  // whatever re-renders the old pane (a save over MCP, a delete, a new VHDL block) refreshes the window too
  const _pane=renderModulesPane;
  renderModulesPane=function(){ const r=_pane.apply(this, arguments); try{ libRender(); }catch(_){} return r; };
}
/* MCP: the category is listed, and can be set */
{
  const _info=mcpModuleInfo;
  mcpModuleInfo=function(m){ const r=_info.apply(this, arguments);
    const c=libModCat(m); r.category=c==="mine" ? LIB_COMMON : c.startsWith("u:") ? c.slice(2) : (LIB_CATS.find(x=>x.id===c)||{}).label; return r; };
}
MCP_OPS.set_module_category = a=>{
  const m=mcpModule(a.module), c=String(a.category||"").trim();
  const b=LIB_CATS.find(x=>x.label===c || x.id===c);
  if(!c || c===LIB_COMMON) delete m.cat; else m.cat=b ? b.id : c;
  saveModules(); libRender();
  return {module:m.name, category:mcpModuleInfo(m).category, categories:[LIB_COMMON].concat(LIB_CATS.map(x=>x.label))};
};
/* the side tab goes; the window is the first item of Tools ▸ ตัวสร้างวงจร */
{
  const tab=document.querySelector('.pane-tabs button[data-ltab="modules"]'); if(tab) tab.style.display="none";
  const box=[...document.querySelectorAll('#menu .dd-head')].find(h=>/ตัวสร้างวงจร/.test(h.textContent));
  if(box && !document.querySelector('#menu [data-gen="library"]')){
    box.insertAdjacentHTML("afterend", `<button class="gen-mi lib-mi" data-gen="library" title="ชิ้นส่วนสำเร็จรูปที่ตรวจแล้ว แบ่งหมวด + โมดูลของฉัน"><span class="gi">▦</span><b>คลังชิ้นส่วนและโมดูล…</b></button>`);
    document.querySelector('#menu [data-gen="library"]').addEventListener("click", ()=>openLibrary());
  }
  GENERATORS.unshift({id:"library", icon:"▦", name:"คลังชิ้นส่วนและโมดูล", desc:"ชิ้นส่วนสำเร็จรูป (ตัวบวก ตัวนับ 7-seg …) แบ่งหมวด และโมดูลของฉัน", run:()=>openLibrary()});
}
