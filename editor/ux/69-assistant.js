/* ===== 69. The ถาม-ตอบ assistant: streamed answers, markdown, thinking, sources ==========
   In the app (http) the chat's ถาม-ตอบ mode goes to launcher /api/assistant/chat (SSE): course notes
   (RAG) first as numbered sources, then the answer as the model writes it. Markdown is drawn (headings,
   lists, tables, code blocks with คัดลอก / วางเป็นบล็อก VHDL — the latter opens the VHDL block dialog with
   the code, which checks it with the app's simulator before anything is saved). "คิดก่อนตอบ" turns the
   model's thinking on (localStorage `schstudio.assistThink`); it is shown folded. The conversation is
   kept for the follow-up questions until ↺ บทสนทนาใหม่ (memory across sessions comes later). The old
   /ask path stays for the editor opened from disk, for the dataset and for the eval. Off in โหมดเรียบง่าย. */
const AS={history:[], ctl:null, thinkKey:"schstudio.assistThink"};
function asOn(){
  if(!/^https?:/.test(location.protocol)) return false;
  if(typeof SIMPLE!=="undefined" && SIMPLE.on) return false;
  try{ return localStorage.getItem("schstudio.assistant")!=="0"; }catch(_){ return true; }
}
function asThink(){ try{ return localStorage.getItem(AS.thinkKey)==="1"; }catch(_){ return false; } }
function asScrub(t){
  t=String(t||""); if(!/[฀-๿]/.test(t)) return t;
  return t.replace(/[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ]/g, "");
}
/* markdown → HTML, escaped first; an unclosed ``` (still streaming) runs to the end */
function asInline(t){
  return esc(t)
    .replace(/`([^`\n]+)`/g, (m,c)=>`<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\[(\d{1,2})\](?!\()/g, '<sup class="as-cite">$1</sup>');
}
function asIsVhdl(lang, code){ return /^(vhdl|vhd)$/.test(lang) || (!lang && /\bentity\b[\s\S]*\barchitecture\b/i.test(code)); }
function asMd(src, codes){
  const s=String(src||"").replace(/\r/g,"").replace(/```([\w+#-]*)[^\n]*\n?([\s\S]*?)(```|$)/g, (m,lang,code,end)=>{
    codes.push({lang:(lang||"").toLowerCase(), code:code.replace(/\n$/,""), open:!end});
    return "\n\u0000C"+(codes.length-1)+"\u0000\n"; });
  const L=s.split("\n"), out=[]; let para=[];
  const flush=()=>{ if(para.length){ out.push("<p>"+para.map(asInline).join("<br>")+"</p>"); para=[]; } };
  for(let i=0;i<L.length;i++){
    const ln=L[i], cm=/^\u0000C(\d+)\u0000$/.exec(ln);
    if(cm){ flush(); const c=codes[+cm[1]], k=+cm[1];
      out.push(`<div class="as-code"><div class="as-cbar"><span>${esc(c.lang||"code")}</span><span class="grow"></span>`
        +(c.open?"":`<button class="as-cbtn" data-as-copy="${k}">คัดลอก</button>`
          +(asIsVhdl(c.lang, c.code)?`<button class="as-cbtn" data-as-vhdl="${k}" title="เปิดหน้าต่างบล็อก VHDL พร้อมโค้ดนี้ — โปรแกรมตรวจโค้ดด้วยตัวจำลองก่อนบันทึก">วางเป็นบล็อก VHDL</button>`:""))
        +`</div><pre><code>${esc(c.code)}</code></pre></div>`); continue; }
    if(!ln.trim()){ flush(); continue; }
    let m;
    if((m=/^(#{1,4})\s+(.*)$/.exec(ln))){ flush(); out.push(`<div class="as-h as-h${m[1].length}">${asInline(m[2])}</div>`); continue; }
    if(/^\s*(-{3,}|\*{3,})\s*$/.test(ln)){ flush(); out.push("<hr>"); continue; }
    if(/^\s*\|.*\|\s*$/.test(ln) && /^\s*\|?\s*:?-{2,}/.test(L[i+1]||"")){
      flush(); const cells=r=>r.trim().replace(/^\||\|$/g,"").split("|").map(x=>x.trim());
      let h=`<table class="as-table"><tr>${cells(ln).map(c=>`<th>${asInline(c)}</th>`).join("")}</tr>`; i++;
      while(i+1<L.length && /^\s*\|.*\|\s*$/.test(L[i+1])){ i++; h+=`<tr>${cells(L[i]).map(c=>`<td>${asInline(c)}</td>`).join("")}</tr>`; }
      out.push(h+"</table>"); continue; }
    if((m=/^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(ln))){
      flush(); const ol=/\d/.test(m[1]), items=[m[2]];
      while(i+1<L.length && /^\s*([-*•]|\d+[.)])\s+/.test(L[i+1]) && /\d/.test(/^\s*([-*•]|\d+)/.exec(L[i+1])[1])===ol){ i++; items.push(L[i].replace(/^\s*([-*•]|\d+[.)])\s+/,"")); }
      out.push(`<${ol?"ol":"ul"} class="as-list">${items.map(x=>`<li>${asInline(x)}</li>`).join("")}</${ol?"ol":"ul"}>`); continue; }
    if((m=/^>\s?(.*)$/.exec(ln))){ flush(); out.push(`<blockquote>${asInline(m[1])}</blockquote>`); continue; }
    para.push(ln);
  }
  flush();
  return out.join("");
}
function asRender(b){
  const det=b.el.querySelector("details.as-think"); if(det) b.thinkOpen=det.open;
  const codes=[];
  let h="";
  if(b.think || b.thinking){
    const open=b.thinkOpen?" open":"";
    const sum=b.thinking?"กำลังคิด…":b.thinkCut?"หยุดระหว่างคิด":`คิดแล้ว${b.thinkS?" "+b.thinkS+" วินาที":""}`;
    h+=`<details class="as-think"${open}><summary>${sum}</summary><div class="as-think-body">${esc(b.think||"")}</div></details>`;
  }
  h+=`<div class="as-md">${asMd(asScrub(b.text), codes)}${b.streaming&&!b.think&&!b.text?'<span class="ac-hint">กำลังตอบ…</span>':""}</div>`;
  if(b.sources && b.sources.length && b.done)
    h+=`<div class="as-src">${b.sources.map(s=>`<span class="as-chip" title="${esc([s.title, s.source].filter(Boolean).join(" · "))}">[${s.n}] ${esc(s.topic||s.title||s.source)}${s.source&&s.topic?` · ${esc(s.source)}`:""}</span>`).join("")}</div>`;
  if(b.err) h+=`<div class="as-err">${b.err}</div>`;
  if(b.done && b.meta) h+=`<div class="as-meta">${esc(b.meta)}</div>`;
  if(b.streaming) h+=`<button class="as-stop" data-as-stop="1">⏹ หยุด</button>`;
  b.el.innerHTML=h; b.el._codes=codes;
  const log=$("#acLog"); if(log && b.stick) log.scrollTop=log.scrollHeight;
}
async function asAsk(msg){
  const el=aiAppend("ai", "", {html:true}); if(!el) return;
  el.classList.add("as-ans");
  const log=$("#acLog");
  const b={el, text:"", think:"", thinking:false, streaming:true, sources:[], stick:true, t0:Date.now()};
  if(log) log.addEventListener("scroll", b.onScroll=()=>{ b.stick=log.scrollHeight-log.scrollTop-log.clientHeight<40; });
  let tm=null; const paint=now=>{ if(now){ clearTimeout(tm); tm=null; asRender(b); } else if(!tm) tm=setTimeout(()=>{ tm=null; asRender(b); }, 70); };
  paint(true);
  const think=asThink(), ctl=new AbortController(); AS.ctl=ctl;
  AICHAT.busy=true; aiSetBusy(true);
  let sheet=""; try{ sheet=aiSheetContext(); }catch(_){}
  try{
    const r=await fetch("/api/assistant/chat", {method:"POST", headers:{"Content-Type":"application/json"}, signal:ctl.signal,
      body:JSON.stringify({message:msg, history:AS.history.slice(-8), sheet, think})});
    const rd=r.body.getReader(), dec=new TextDecoder(); let buf="";
    for(;;){
      const {value, done}=await rd.read(); if(done) break;
      buf+=dec.decode(value, {stream:true});
      let i; while((i=buf.indexOf("\n\n"))>=0){
        const line=buf.slice(0,i).trim(); buf=buf.slice(i+2);
        if(!line.startsWith("data:")) continue;
        let ev; try{ ev=JSON.parse(line.slice(5)); }catch(_){ continue; }
        if(ev.type==="sources") b.sources=ev.sources||[];
        else if(ev.type==="think"){ if(!b.thinking && !b.think) b.tThink=Date.now(); b.thinking=true; b.think+=ev.text; }
        else if(ev.type==="text"){ if(b.thinking){ b.thinking=false; b.thinkS=Math.round((Date.now()-b.tThink)/1000); } if(b.text || ev.text.trim()) b.text+=ev.text; }
        else if(ev.type==="done"){
          const t=ev.timings||{}, tps=t.predicted_per_second;
          b.meta=[ev.backend==="llama"?"":ev.backend, tps?tps.toFixed(1)+" token/วินาที":"", ev.elapsed_s?ev.elapsed_s+" วินาที":"",
                  ev.finish==="length"?"คำตอบยาวเกินที่กำหนด — ถูกตัด":""].filter(Boolean).join(" · ");
        }
        else if(ev.type==="error"){
          b.err=esc(ev.error||"error")+(ev.hint?`<br><span class="ac-hint">${esc(ev.hint)}</span>`:"");
          if(/not reachable/.test(ev.error||"")) b.err="ยังไม่ได้เปิดโมเดล AI · เปิดได้ที่ หน้าหลัก ▸ <b>ตั้งค่า</b> ▸ <b>โมเดล AI ในเครื่อง</b> — กดดาวน์โหลดแล้ว “เริ่มโมเดล”";
        }
        paint(false);
      }
    }
  }catch(e){
    if(e && e.name==="AbortError") b.meta="หยุดแล้ว";
    else b.err="ต่อโปรแกรมหลักไม่ได้: "+esc(e&&e.message||e);
  }finally{
    if(b.thinking){ b.thinking=false; b.thinkCut=true; }
    b.streaming=false; b.done=true; AS.ctl=null;
    if(log && b.onScroll) log.removeEventListener("scroll", b.onScroll);
    paint(true);
    AICHAT.busy=false; aiSetBusy(false);
    const ans=asScrub(b.text).trim();
    if(ans){ AS.history.push({role:"user", content:msg}, {role:"assistant", content:ans}); aiRemember("ai", ans); }
    if(AS.history.length>24) AS.history=AS.history.slice(-24);
  }
}
{
  const _ask=aiAsk;
  aiAsk=async function(msg){
    const sch=activeSch();
    if(!asOn() || aiSmalltalk(msg) || (/(ยังไง|อย่างไร|ทำไง|\bhow\b)/i.test(msg) && aiFaq(msg))
       || (uxAboutSheet(msg) && sch && (sch.components||[]).some(c=>c.type!=="JUNCTION")))
      return _ask.apply(this, arguments);
    return asAsk(msg);
  };
  // the chat's head: "คิดก่อนตอบ" + "บทสนทนาใหม่", shown in ถาม-ตอบ mode only
  const modes=document.querySelector("#aiChat .ac-mode");
  if(modes && !document.querySelector("#asTools")){
    modes.insertAdjacentHTML("afterend", `<span id="asTools" hidden>
      <label class="as-tg" title="ให้โมเดลคิดก่อนตอบ: ช้าลง แต่ดีขึ้นกับคำถามที่ต้องไล่เหตุผลหรือเขียนโค้ด"><input type="checkbox" id="asThink"> คิดก่อนตอบ</label>
      <button class="as-new" id="asNew" title="เริ่มบทสนทนาใหม่ (ลืมคำถามก่อนหน้าในหน้าต่างนี้)">↺</button></span>`);
    const cb=$("#asThink"); cb.checked=asThink();
    cb.addEventListener("change", ()=>{ try{ localStorage.setItem(AS.thinkKey, cb.checked?"1":"0"); }catch(_){} });
    $("#asNew").addEventListener("click", ()=>{ if(AS.ctl) AS.ctl.abort(); AS.history=[]; AICHAT.history=[];
      const log=$("#acLog"); if(log) log.innerHTML=""; aiAppend("ai", "เริ่มบทสนทนาใหม่แล้ว ถามได้เลย"); });
  }
  const _mode=aiSetMode;
  aiSetMode=function(m){ const r=_mode.apply(this, arguments); const t=$("#asTools"); if(t) t.hidden=!(m==="qa" && asOn()); return r; };
  aiSetMode(AICHAT.mode);
}
document.addEventListener("click", ev=>{
  const t=ev.target.closest && ev.target.closest("[data-as-copy],[data-as-vhdl],[data-as-stop]"); if(!t) return;
  if(t.dataset.asStop){ if(AS.ctl) AS.ctl.abort(); return; }
  const msgEl=t.closest(".ac-msg"), c=msgEl && msgEl._codes && msgEl._codes[+(t.dataset.asCopy||t.dataset.asVhdl)];
  if(!c) return;
  if(t.dataset.asCopy!=null){
    (navigator.clipboard ? navigator.clipboard.writeText(c.code) : Promise.reject()).then(
      ()=>toast("คัดลอกโค้ดแล้ว", "ok"), ()=>toast("คัดลอกไม่ได้ — เลือกข้อความแล้วกด Ctrl+C", "warn"));
    return;
  }
  // the VHDL block dialog with this code: its ตรวจโค้ด runs the app's VHDL simulator before saving
  vhdlBlockDialog(null);
  const tas=document.querySelectorAll(".vhb-text"), ta=tas[tas.length-1];
  if(ta){ ta.value=c.code; const ck=document.querySelector("#vhbCheck"); if(ck) ck.click(); }
});
