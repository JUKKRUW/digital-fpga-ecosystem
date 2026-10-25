/* ===== 68. โหมดเรียบง่าย (simple / exam mode) ===========================================================
   For an exam: draw by hand, check on the canvas, pick pins, build. Off in this mode: the AI (chat, agent,
   ✨ draw from a name, MCP control from outside), the sim page (the live simulation on the canvas stays:
   switches, lit wires, ⏭ 1 clk), the part / module library and every generator, the truth table of a part, and
   Ctrl+K. Writing a VHDL block by hand (Tools ▸ บล็อก VHDL) stays — that is writing a module. Pasting stays, so circuits copied from the separate library program (ISAN) can come in.
   View ▸ โหมดเรียบง่าย turns it on (✓ while on); leaving asks first. The choice is kept
   (localStorage `schstudio.simpleMode`), so the app reopens in the same mode. */
const SIMPLE={on:false, key:"schstudio.simpleMode"};
function simpleSet(on, quiet){
  SIMPLE.on=!!on;
  try{ localStorage.setItem(SIMPLE.key, on?"1":"0"); }catch(_){}
  document.body.classList.toggle("simple-mode", SIMPLE.on);
  const b=document.getElementById("btnSimple");
  if(b){ b.classList.toggle("on", SIMPLE.on); b.innerHTML=(SIMPLE.on?"✓ ":"")+"โหมดเรียบง่าย (สอบ)";
    b.title=SIMPLE.on?"กำลังใช้โหมดเรียบง่าย (ไม่มี AI / หน้าจำลอง / ตัวสร้างวงจร) — กดเพื่อออก":"ซ่อน AI, หน้าจำลอง และตัวสร้างวงจร (สำหรับสอบ) — วาดเอง จำลองบนแผ่น เลือกขา ลงบอร์ด"; }
  if(SIMPLE.on){
    try{ if(AICHAT.open) toggleAiChat(); }catch(_){}
    try{ const pg=document.getElementById("simPage"); if(pg && pg.classList.contains("show") && !pg.classList.contains("sv-pins")) hideSimPage(); }catch(_){}
    document.querySelectorAll(".lib-bg").forEach(m=>{ try{ m.close(); }catch(_){ m.remove(); } });
  }
  if(!quiet) toast(SIMPLE.on ? "เปิดโหมดเรียบง่าย — ไม่มี AI, หน้าจำลอง และตัวสร้างวงจร (จำลองบนแผ่นวงจรยังใช้ได้)" : "ออกจากโหมดเรียบง่ายแล้ว", "ok", 4500);
}
function simpleToggle(){
  if(!SIMPLE.on){ simpleSet(true); return; }
  const m=uxModal("ออกจากโหมดเรียบง่าย?", `<div>AI, หน้าจำลอง และตัวสร้างวงจรจะกลับมา</div>`,
    {width:420, foot:`<button class="btn" id="smStay">อยู่ในโหมดเรียบง่าย</button><button class="btn btn-primary" id="smLeave">ออก</button>`});
  m.querySelector("#smStay").onclick=()=>m.close();
  m.querySelector("#smLeave").onclick=()=>{ m.close(); simpleSet(false); };
}
/* the switch: View ▸ โหมดเรียบง่าย (after the zoom items) */
{
  const dd=document.querySelector('#menu .mi > button[data-menu="view"]'), box=dd && dd.parentElement.querySelector(".dd");
  if(box && !document.getElementById("btnSimple")){
    const hr=box.querySelector("hr");
    const html=`<button id="btnSimple" class="simple-mi"></button><hr>`;
    if(hr) hr.insertAdjacentHTML("afterend", html); else box.insertAdjacentHTML("beforeend", html);
    document.getElementById("btnSimple").addEventListener("click", simpleToggle);
  }
}
/* what the mode turns off, where hiding the button is not enough */
{
  const no=what=>{ toast(`${what} ปิดอยู่ในโหมดเรียบง่าย`, "warn", 3000); };
  const _sim=showSimPage;
  showSimPage=function(tab){ if(SIMPLE.on && !(tab==="board" || tab==="pins")){ no("หน้าจำลอง"); return; } return _sim.apply(this, arguments); };
  const _ai=toggleAiChat;
  toggleAiChat=function(){ if(SIMPLE.on && !AICHAT.open){ no("AI"); return; } return _ai.apply(this, arguments); };
  const _lib=openLibrary;
  openLibrary=function(){ if(SIMPLE.on){ no("คลังชิ้นส่วน"); return; } return _lib.apply(this, arguments); };
  const _gen=runGenerator;
  // writing a VHDL block by hand is writing a module, not generating one: it stays
  runGenerator=function(id){ if(SIMPLE.on && id!=="vhdl_block"){ no("ตัวสร้างวงจร"); return; } return _gen.apply(this, arguments); };
  if(typeof realizeBlock==="function"){ const _rb=realizeBlock; realizeBlock=function(){ if(SIMPLE.on){ no("วาดวงจรจากชื่อ"); return; } return _rb.apply(this, arguments); }; }
  if(typeof partTruthShow==="function"){ const _pt=partTruthShow; partTruthShow=function(){ if(SIMPLE.on){ no("ตารางความจริงของชิ้นส่วน"); return; } return _pt.apply(this, arguments); }; }
  // Ctrl+K and the command palette
  window.addEventListener("keydown", e=>{ if(SIMPLE.on && (e.ctrlKey||e.metaKey) && (e.code==="KeyK" || (e.key||"").toLowerCase()==="k")){ e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  // MCP: nothing from outside drives the editor (Claude, the agent's tools)
  Object.keys(MCP_OPS).forEach(k=>{ const f=MCP_OPS[k]; if(typeof f!=="function") return;
    MCP_OPS[k]=function(){ if(SIMPLE.on) mcpFail("the editor is in โหมดเรียบง่าย (simple / exam mode): tools are off", "the user turns it off with the button in the top bar"); return f.apply(this, arguments); }; });
}
try{ simpleSet(localStorage.getItem(SIMPLE.key)==="1", true); }catch(_){ simpleSet(false, true); }
