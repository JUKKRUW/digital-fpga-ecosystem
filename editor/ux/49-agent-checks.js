/* ===== 49. What the agent checked, said plainly ==================================================
   From testing the fine-tuned 4B (SFT1) on lab 7: asked "ถ้า sec>59 ไฟ error ติดมั้ย", it called check_spec
   on a sheet with no spec, read back "pass undefined" and answered as if it had tested; it also said
   "พร้อมลงบอร์ด" without running board_check. So:
     - check_spec on a sheet with no spec answers pass:null + NO SPEC + what to call instead (probe), and the
       step in the chat says so;
     - probe takes a numbered INPUT group as one number (lab7's sw0..sw15 → sw:0x1260), like a bus;
     - an answer that talks about the board, from a run that never ran board_check, gets the board doctor's
       own verdict appended (the app checks; the model does not get to sound sure). */
{
  const _cs=MCP_OPS.check_spec;
  const none=s=>({sheet:s.name, spec:null, pass:null, checked:false,
    note:`NO SPEC on sheet '${s.name}' — nothing was checked. To test given input values (e.g. "if sw = … is led_error on?") `+
      "call probe {inputs:{…}} and read the outputs (a numbered group like sw0..sw15 or a bus takes one number); "+
      "for clocked behaviour call simulate. set_spec first if you want an acceptance test."});
  MCP_OPS.check_spec=a=>{
    if(a.all_sheets){ const r=_cs(a); if(!r.sheets.length) return {sheets:[], pass:null, checked:false, note:"NO SPEC on any sheet — nothing was checked"}; return r; }
    const s=mcpSheet(a.sheet); if(!s.spec) return none(s);
    return _cs(a);
  };
  const _sum=aiagSummary;
  aiagSummary=function(tool, r){
    if(tool==="check_spec" && r && r.checked===false) return "NO SPEC — nothing was checked (to test given inputs: probe)";
    return _sum.apply(this, arguments);
  };
}

/* ---- probe: a numbered INPUT group (sw0..sw15, a_0..a_3) as one number ---- */
function acNumber(v, w){
  if(typeof v==="number") return v;
  const t=String(v).trim().replace(/_/g,"");
  if(/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2),16);
  if(/^0b[01]+$/i.test(t)) return parseInt(t.slice(2),2);
  if(/^[01]+$/.test(t) && t.length===w) return parseInt(t,2);
  if(/^\d+$/.test(t)) return parseInt(t,10);
  return NaN;
}
function acSplitGroups(sch, inputs){
  if(!inputs || typeof inputs!=="object") return inputs;
  const ins=sch.components.filter(c=>c.type==="IN"), has=n=>ins.some(c=>String(c.params.name).toLowerCase()===String(n).toLowerCase());
  const out={}, bus={};
  const groupBits=n=>{ const bits=[]; ins.forEach(c=>{ const m=/^(.*?)_?(\d+)$/.exec(String(c.params.name)); if(m && m[1].toLowerCase()===String(n).toLowerCase() && (c.params.width||1)===1) bits[+m[2]]=c.params.name; }); return bits; };
  Object.entries(inputs).forEach(([n,v])=>{
    // a bit range: sw[7:4] / sw[3] — of a bus INPUT, or of a numbered group sw0..sw15
    const r=/^\s*([A-Za-z_][\w]*)\s*\[\s*(\d+)\s*(?::\s*(\d+)\s*)?\]\s*$/.exec(n);
    if(r && !has(n)){
      const base=r[1], hi=Math.max(+r[2], +(r[3]??r[2])), lo=Math.min(+r[2], +(r[3]??r[2])), w=hi-lo+1;
      const x=acNumber(v, w);
      if(isNaN(x)) mcpFail(`'${n}' is ${w} bit(s): give one number`, `e.g. "${n}": ${Math.min(5,(1<<w)-1)} or "0b${"1".repeat(w)}"`);
      if(x>=2**w) mcpFail(`${x} does not fit in ${n} (${w} bit${w>1?"s":""})`);
      const c=ins.find(q=>String(q.params.name).toLowerCase()===base.toLowerCase());
      if(c && (c.params.width||1)>1){ const W=c.params.width; if(hi>=W) mcpFail(`${base} is ${base}[${W-1}:0]: no bit ${hi}`);
        const k=c.params.name, m=((2**w)-1)*2**lo; bus[k]=bus[k]||{v:0, m:0}; bus[k].v=(bus[k].v & ~m) | (x*2**lo); bus[k].m|=m; return; }
      const bits=groupBits(base);
      if(bits.length && bits.slice(lo, hi+1).length===w && bits.slice(lo, hi+1).every(Boolean)){
        for(let i=lo;i<=hi;i++) out[bits[i]]=Math.floor(x/2**(i-lo))&1; return; }
      mcpFail(`no INPUT bits '${n}'`, "inputs: "+ins.map(q=>q.params.name+((q.params.width||1)>1?`[${q.params.width-1}:0]`:"")).join(", "));
    }
    if(has(n)){ out[n]=v; return; }
    const bits=groupBits(n);
    if(bits.length<2 || bits.some(b=>!b)){ out[n]=v; return; }                 // not a group: the core says "no INPUT"
    const x=acNumber(v, bits.length);
    if(isNaN(x)) mcpFail(`'${n}' is the group ${bits[0]}..${bits[bits.length-1]}: give one number`, `e.g. ${n}: 4704, "0x1260" or "0b${"0".repeat(bits.length)}"`);
    bits.forEach((b,i)=>{ out[b]=(x>>i)&1; });
  });
  // slices of one bus INPUT add up; a whole value given beside them is the base
  Object.entries(bus).forEach(([k,o])=>{ const whole=out[k]!=null ? acNumber(out[k], 64) : 0; out[k]=((isNaN(whole)?0:whole) & ~o.m) | o.v; });
  return out;
}
{
  const _probe=MCP_OPS.probe;
  MCP_OPS.probe=a=>{ const sch=mcpSheet(a.sheet); return _probe(Object.assign({}, a, {inputs:acSplitGroups(sch, a.inputs)})); };
}

/* ---- an answer about the board from a run that never ran board_check ---- */
function aiagBoardVerdict(run){
  if(!run.final || !/บอร์ด|board|\.bit|ลงชิป|fpga/i.test(run.final)) return "";
  if((run.steps||[]).some(s=>s.tool==="board_check" && s.ok)) return "";
  const sch=activeSch(); if(!sch || !sch.components.some(c=>c.type==="IN"||c.type==="OUT")) return "";
  let F; try{ F=boardDoctor(sch); }catch(_){ return ""; }
  const err=F.filter(f=>f.lvl==="err"), warn=F.filter(f=>f.lvl!=="err");
  return `\n\n🩺 โปรแกรมตรวจการลงบอร์ดให้ (แผ่น ${sch.name}): `+
    (err.length ? `ยังไม่พร้อม — พบปัญหา ${err.length} ข้อ: ${err.slice(0,3).map(f=>f.title).join(" · ")}` : "ไม่พบปัญหา")+
    (warn.length ? ` (ข้อควรดู ${warn.length} ข้อ)` : "")+" — ดูรายละเอียดที่หน้า ลงบอร์ด ▸ 🩺";
}
{
  const _v=aiagVerdict;
  aiagVerdict=function(run){ let s=_v.apply(this, arguments); try{ s+=aiagBoardVerdict(run); }catch(e){ console.warn("board verdict", e); } return s; };
}

/* ---- run the model the way it was trained ----
   SFT1 was fine-tuned with enable_thinking=False (tools/dataset/train_lora.py), but the agent asked it to
   think on the first call and after every error / nudge — the slow part of a 40–50 s call, in a mode the
   training never showed it. A fine-tuned model (catalog `trained`, or "sft" in the file name) now runs
   without thinking and at a lower temperature; others as before. ai_chat {think, temperature} or
   localStorage schstudio.agentThink ("0"/"1") / schstudio.agentTemp override. */
async function aiagProfile(opts){
  const out={};
  let st=null; try{ st=typeof aiagModelStatus==="function" ? await aiagModelStatus() : null; }catch(_){}
  const base=p=>String(p||"").split(/[\\/]/).pop().toLowerCase();
  const cur=st && st.model ? base(st.model) : "";
  const cat=st && st.catalog ? st.catalog.find(m=>base(m.path)===cur) : null;
  if((cat && cat.trained) || /sft|lora|finetune|ft\d/.test(cur)){ out.think=false; out.temperature=0.3; out.trained=true; }
  try{ const t=localStorage.getItem("schstudio.agentThink"); if(t==="0"||t==="1") out.think=t==="1";
    const k=parseFloat(localStorage.getItem("schstudio.agentTemp")); if(k>=0 && k<=2) out.temperature=k; }catch(_){}
  if(opts && typeof opts.think==="boolean") out.think=opts.think;
  if(opts && opts.temperature!=null && +opts.temperature>=0 && +opts.temperature<=2) out.temperature=+opts.temperature;
  if(cur) out.model=cur;
  return out;
}

/* ---- from the div50 → div5 + div10 session (SFT1): ----
   a run planned everything in its reasoning, called no tool and ended "(ไม่มีคำตอบ)"; the next one called
   no tool and answered "สร้างใหม่แล้ว … ตรวจผ่าน 256 ขั้น" with the sheet untouched; and a request with
   two goals stopped after the first because that one passed its acceptance test. */
/* tool calls the model wrote as text instead of as calls: <tool_call>{json}</tool_call>, or the
   <function=name><parameter=x>…</parameter></function> form — only names of the agent's tools */
function aiagTextCalls(content, thought){
  const known=new Set(((AIAG&&AIAG.tools)||[]).map(t=>t.function.name)), out=[];
  const scan=txt=>{ const t=String(txt||""); if(!/<tool_call>|<function=/.test(t)) return;
    for(const m of t.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)){
      const body=m[1].trim(); let name=null, args=null;
      if(body[0]==="{"){ try{ const j=JSON.parse(body); name=j.name; args=j.arguments||j.args||{}; }catch(_){ continue; } }
      else { const f=/<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body); if(!f) continue; name=f[1]; args={};
        for(const q of f[2].matchAll(/<parameter=([\w.-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)){ let v=q[2]; try{ v=JSON.parse(v); }catch(_){} args[q[1]]=v; } }
      if(name && known.has(name)) out.push({id:"text"+out.length, type:"function", function:{name, arguments:typeof args==="string"?args:JSON.stringify(args||{})}}); } };
  scan(content); if(!out.length) scan(thought);
  return out;
}
/* the request asks for a change to the circuit (not only a question) */
function aiagWantsChange(msg){
  const t=String(msg||"");
  const act=/(สร้าง|ทำ|แก้|ลบ|ต่อ|แตก|แยก|เปลี่ยน|แทน|ย้าย|วาง|ใส่|จัด|รวม|ประกอบ|เอาเลย|\b(build|make|create|delete|remove|replace|connect|fix|change|add|split)\b)/i.test(t);
  if(!act) return false;
  return !(typeof aiLooksLikeQuestion==="function" && aiLooksLikeQuestion(t) && !(typeof AIAG_MAKE_RE!=="undefined" && AIAG_MAKE_RE.test(t)) && !/(แก้|ลบ|แตก|แทน|เอาเลย|จัดไป)/.test(t));
}
/* more than one thing to do: several sheets named, or "… instead of the old one / then …" */
function aiagMultiGoal(msg){
  const t=String(msg||""), names=new Set();
  for(const m of t.matchAll(/(?:แผ่น|ชีต|ชีท|sheet)\s*(?:ใหม่\s*)?(?:ชื่อ\s*)?[`"'“]?([A-Za-z_][A-Za-z0-9_]*)/gi)) names.add(m[1].toLowerCase());
  return names.size>=2 || /(แทน|ของเดิม|อันเดิม|แตก|แยกเป็น|ต่อกับ|ต่อเข้า|แล้วให้|แล้วต่อ|แล้วเอา|แล้วก็|\breplace\b|\binstead\b|\bthen\b)/i.test(t);
}
/* an answer from a run that called no tool says so at the top — it can never claim work it did not do */
function aiagNoWorkGuard(run, final, didWork, wantsChange){
  if(didWork) return final;
  const claims=/(แล้ว|เสร็จ|เรียบร้อย|ผ่าน|ตรวจ|ยืนยัน|\b(done|passed|created|built|verified|finished)\b)/i.test(final);
  if(!wantsChange && !claims) return final;
  return "⚠ รอบนี้เอเจนต์ไม่ได้เรียกเครื่องมือเลย — ไม่มีอะไรถูกสร้าง แก้ หรือตรวจจริง"+(claims?" ข้อความด้านล่างจากโมเดลจึงเชื่อไม่ได้":"")+"\n\n"+final;
}

/* ---- a plan in words → the call, by constrained decoding ----
   Seen with SFT1 (div25 / div50): asked to rewire a sheet, it wrote the right plan in words ("clk_in → div5.clk_in,
   div5.clk_out → div10.clk_in, …") and made no call. The model knows WHAT to do; it fails at the FORMAT. So the same
   model is asked again under a grammar llama-server builds from a JSON schema (response_format): first which tool
   (an enum of the agent's tools), then that tool's arguments (the tool's own schema). It cannot produce anything
   else; what it produces then goes through the normal argument checks and the tool's own validation. */
async function aiagStructuredCall(run, messages, plan){
  const tools=(AIAG&&AIAG.tools)||[]; if(!tools.length) return null;
  const names=tools.map(t=>t.function.name);
  const opt={temperature:0, top_p:1, chat_template_kwargs:{enable_thinking:false}};
  const ask=async (msgs, schema, name, max)=>{
    let j; try{ j=await aiagPost("/api/llm/chat", Object.assign({messages:msgs, max_tokens:max,
      response_format:{type:"json_schema", json_schema:{name, schema}}}, opt), run.ctl&&run.ctl.signal); }catch(_){ return null; }
    if(!j || !j.ok) return null;
    run.model_calls++; run.model_seconds+=j.elapsed_s||0;
    try{ return JSON.parse(String((((j.choices||[])[0]||{}).message||{}).content||"").trim()); }catch(_){ return null; } };
  const base=messages.concat([{role:"assistant", content:aiagClip(plan, 3000)},
    {role:"user", content:"(system) You wrote the plan but made no tool call, so nothing happened. Which ONE tool does the next step of that plan? "
      +"Tools: "+tools.map(t=>`${t.function.name} — ${String(t.function.description).split(/(?<=\.)\s/)[0]}`).join(" | ")}]);
  const pick=await ask(base, {type:"object", properties:{tool:{type:"string", enum:names}}, required:["tool"]}, "pick", 40);
  const tool=pick && names.includes(pick.tool) ? pick.tool : null; if(!tool) return null;
  const def=tools.find(t=>t.function.name===tool).function;
  const args=await ask(base.concat([{role:"assistant", content:JSON.stringify({tool})},
    {role:"user", content:`(system) Now the arguments of ${tool}, filled from your plan and the user's request (sheet names, blocks, every connection). ${def.description}`}]),
    def.parameters, tool, 2000);
  if(!args || typeof args!=="object") return null;
  const why=aiagStructuredUnsafe(run, tool, args);
  if(why){ run.steps.push({kind:"nudge", text:"constrained call dropped: "+why}); return null; }
  return {id:"sc"+(run.structTries||0), type:"function", function:{name:tool, arguments:JSON.stringify(args)}};
}

/* after work was done: a reply that still announces a next step (not a closing summary) */
function aiagPlanAhead(plan){
  const t=String(plan||"");
  if(/(เสร็จ|เรียบร้อย|สรุป|ผ่าน|ตรวจแล้ว|ครบแล้ว|ทำงานได้|ถูกต้อง|\b(done|passed|summary|completed?|verified|finished|works)\b)/i.test(t)) return false;
  return /(ต่อไป|ขั้นต่อไป|ขั้นถัดไป|ถัดไป|จะ(ต่อ|สร้าง|วาง|แก้|เพิ่ม|ลบ|เรียก)|ต้อง(ต่อ|สร้าง|วาง|แก้|เพิ่ม)|ยังไม่ได้|\bnext\b|\bnow (I|we|let)|\bI will\b|\bI'll\b|\blet me\b|\bthen I\b)/i.test(t);
}
/* a call the app wrote for the model must never destroy work: no rebuild over a sheet with parts that this run did
   not make (build_hierarchy with no sheet goes to "top" — the user's top sheet was rebuilt that way), no deletes */
function aiagStructuredUnsafe(run, tool, args){
  if(/^(delete_|remove_|rename_|clear_)/.test(tool)) return tool+" is never written for the model";
  if(!/^build_|^vhdl_block$/.test(tool)) return null;
  const nm=String(args.sheet||args.name||"").trim();
  if(!nm && tool==="build_hierarchy") return "build_hierarchy with no sheet name";
  const P=(state&&state.project&&state.project.schematics)||{};
  const s=nm && Object.values(P).find(x=>String(x.name).toLowerCase()===nm.toLowerCase());
  const made=run.made||new Set();
  if(s && s.components.some(c=>c.type!=="JUNCTION") && !made.has(s.id)){
    if(args.replace) delete args.replace;          // the tool then refuses with "already has parts" — nothing lost
  }
  return null;
}
