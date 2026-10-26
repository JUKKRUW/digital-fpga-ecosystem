/* ===== 56. A small VHDL simulator for VHDL blocks (pure: no DOM, no editor state) ====================
   A "VHDL block" is a block on a sheet whose inside is VHDL text instead of gates (57-…). The
   browser simulators (truth table, clock by clock, probe, board) evaluate it through this file.
   It reads the synthesizable subset the course writes: one entity (+ generics with defaults) and its
   architecture; signals / constants / enum and array types (ROM tables); concurrent assignments
   (plain, when-else, with-select); processes with if / case / for / variables; rising_edge,
   falling_edge, clk'event; numeric_std and std_logic_unsigned arithmetic, conversions, resize,
   shifts, aggregates (others => '0'). Not supported (refused with a message): component / entity
   instantiation inside the block, wait, generate, inout, vectors over 32 bits.
   Semantics: delta cycles — every process runs, signal assignments take effect together at the
   end of the delta, a signal that changed is an event in the next delta (so a clock made inside
   the block works); a clocked process sees the inputs as they were just before the edge. */

/* ---------------- lexer ---------------- */
function vhLex(src){
  const T=[]; let i=0, line=1;
  const isId=c=>/[A-Za-z0-9_]/.test(c);
  while(i<src.length){
    const c=src[i];
    if(c==="\n"){ line++; i++; continue; }
    if(/\s/.test(c)){ i++; continue; }
    if(c==="-" && src[i+1]==="-"){ while(i<src.length && src[i]!=="\n") i++; continue; }
    if(/[A-Za-z]/.test(c)){
      let j=i; while(j<src.length && isId(src[j])) j++;
      const w=src.slice(i,j);
      if(/^[xXbBoO]$/.test(w) && src[j]==='"'){            // bit-string literal x"1F", b"0101", o"17"
        let k=j+1; while(k<src.length && src[k]!=='"') k++;
        const body=src.slice(j+1,k).replace(/_/g,""), base=w.toLowerCase();
        let bits="";
        if(base==="b") bits=body;
        else for(const ch of body){ const v=parseInt(ch, base==="x"?16:8); if(isNaN(v)) throw vhErr(line, `เลข ${w}"${body}" ไม่ถูกต้อง`);
          bits+=v.toString(2).padStart(base==="x"?4:3,"0"); }
        T.push({k:"str", v:bits, line}); i=k+1; continue;
      }
      T.push({k:"id", v:w.toLowerCase(), raw:w, line}); i=j; continue;
    }
    if(/[0-9]/.test(c)){
      let j=i; while(j<src.length && /[0-9_]/.test(src[j])) j++;
      if(src[j]==="#"){ const base=+src.slice(i,j).replace(/_/g,""); let k=j+1; while(k<src.length && src[k]!=="#") k++;
        T.push({k:"num", v:parseInt(src.slice(j+1,k).replace(/_/g,""), base), line}); i=k+1; continue; }
      T.push({k:"num", v:+src.slice(i,j).replace(/_/g,""), line}); i=j; continue;
    }
    if(c==='"'){ let k=i+1; while(k<src.length && src[k]!=='"') k++; T.push({k:"str", v:src.slice(i+1,k).replace(/_/g,""), line}); i=k+1; continue; }
    if(c==="'"){
      const prev=T[T.length-1];
      const tick=prev && (prev.k==="id" || prev.v===")") && src[i+2]!=="'";
      if(!tick && src[i+2]==="'"){ T.push({k:"chr", v:src[i+1], line}); i+=3; continue; }
      T.push({k:"op", v:"'", line}); i++; continue;
    }
    const two=src.slice(i,i+2);
    if(["<=",":=","=>","/=",">=","**"].includes(two)){ T.push({k:"op", v:two, line}); i+=2; continue; }
    if("()[],;:+-*/=<>&|.".includes(c)){ T.push({k:"op", v:c, line}); i++; continue; }
    throw vhErr(line, `อ่านตัวอักษร '${c}' ไม่ได้`);
  }
  T.push({k:"eof", v:"", line});
  return T;
}
function vhErr(line, msg){ const e=new Error((line?`บรรทัด ${line}: `:"")+msg); e.vhdl=true; e.line=line; return e; }

/* ---------------- parser ---------------- */
function vhParse(src){
  const T=vhLex(src); let p=0;
  const peek=(o=0)=>T[p+o], at=v=>T[p].v===v && (T[p].k==="id"||T[p].k==="op"), next=()=>T[p++];
  const want=v=>{ if(!at(v)) throw vhErr(T[p].line, `ต้องมี '${v}' ตรงนี้ (เจอ '${T[p].v||"จบไฟล์"}')`); return next(); };
  const opt=v=>{ if(at(v)){ next(); return true; } return false; };
  const ident=()=>{ const t=T[p]; if(t.k!=="id") throw vhErr(t.line, `ต้องเป็นชื่อ (เจอ '${t.v||"จบไฟล์"}')`); p++; return t; };
  const UNSUP=new Set(["component","generate","wait","block","inout","linkage","function","procedure","package","signal_unused"]);
  const skipTo=v=>{ while(!at(v) && T[p].k!=="eof") p++; want(v); };

  // ---- expressions ----
  const LOGIC=["and","or","xor","nand","nor","xnor"], REL=["=","/=","<","<=",">",">="], SHIFT=["sll","srl","sla","sra","rol","ror"];
  function expr(){ let a=rel(); while(T[p].k==="id" && LOGIC.includes(T[p].v)){ const op=next().v; a={t:"bin", op, a, b:rel(), line:T[p].line}; } return a; }
  function rel(){ let a=shift(); if(T[p].k==="op" && REL.includes(T[p].v)){ const op=next().v; a={t:"bin", op, a, b:shift(), line:T[p].line}; } return a; }
  function shift(){ let a=add(); if(T[p].k==="id" && SHIFT.includes(T[p].v)){ const op=next().v; a={t:"bin", op, a, b:add(), line:T[p].line}; } return a; }
  function add(){
    let a; if(at("+")||at("-")){ const op=next().v; a={t:"un", op, a:mul()}; } else a=mul();
    while(at("+")||at("-")||at("&")){ const op=next().v; a={t:"bin", op, a, b:mul(), line:T[p].line}; } return a; }
  function mul(){ let a=unary(); while(at("*")||at("/")||at("mod")||at("rem")){ const op=next().v; a={t:"bin", op, a, b:unary(), line:T[p].line}; } return a; }
  function unary(){
    if(at("not")){ next(); return {t:"un", op:"not", a:unary()}; }
    if(at("abs")){ next(); return {t:"un", op:"abs", a:unary()}; }
    let a=primary(); if(at("**")){ next(); a={t:"bin", op:"**", a, b:primary(), line:T[p].line}; } return a; }
  function args(){
    const L=[];
    if(at(")")){ next(); return L; }
    do{
      if(at("others")){ next(); want("=>"); L.push({others:true, v:expr()}); continue; }
      const a=expr();
      if(at("downto")||at("to")){ const dir=next().v; L.push({t:"range", a, b:expr(), dir}); continue; }
      if(at("=>")){ next(); L.push({named:a, v:expr()}); continue; }
      L.push(a);
    } while(opt(","));
    want(")"); return L;
  }
  function primary(){
    const t=T[p];
    if(t.k==="num"){ next(); return {t:"num", v:t.v}; }
    if(t.k==="chr"){ next(); return {t:"chr", v:t.v}; }
    if(t.k==="str"){ next(); return {t:"str", v:t.v, line:t.line}; }
    if(at("(")){ next(); const L=args();
      if(L.length===1 && !L[0].others && !L[0].named && L[0].t!=="range") return L[0];
      return {t:"agg", items:L, line:t.line}; }
    if(t.k==="id"){
      next(); let n={t:"name", id:t.v, raw:t.raw, line:t.line};
      for(;;){
        if(at("(")){ next(); n={t:"call", f:n, args:args(), line:t.line}; continue; }
        if(at("'")){ next(); const a=ident(); n={t:"attr", base:n, attr:a.v, line:t.line}; continue; }
        if(at(".")){ next(); const a=ident(); n={t:"name", id:a.v, raw:a.raw, line:a.line}; continue; }   // ieee.numeric_std.x → x
        return n;
      }
    }
    throw vhErr(t.line, `อ่านนิพจน์ไม่ได้ตรง '${t.v||"จบไฟล์"}'`);
  }
  // ---- types ----
  function subtype(){
    const t=ident(), name=t.v;
    if(at("(")){ next(); const a=expr(); const dir=next().v; if(dir!=="downto" && dir!=="to") throw vhErr(t.line, "ช่วงต้องเป็น downto หรือ to"); const b=expr(); want(")");
      return {name, range:{a, b, dir}, line:t.line}; }
    if(at("range")){ next(); const a=expr(); const dir=next().v; const b=expr(); return {name, irange:{a, b, dir}, line:t.line}; }
    return {name, line:t.line};
  }
  // ---- sequential statements ----
  function target(){ const t=T[p]; const n=primary(); if(!["name","call"].includes(n.t)) throw vhErr(t.line, "ด้านซ้ายของการกำหนดค่าต้องเป็นชื่อสัญญาณ"); return n; }
  function seqBlock(...ends){ const L=[]; while(!ends.some(e=>at(e))){ if(T[p].k==="eof") throw vhErr(T[p].line, "ไม่เจอ end ที่ปิดบล็อก"); L.push(seqStmt()); } return L; }
  function seqStmt(){
    const t=T[p];
    if(t.k==="id" && peek(1).v===":" && peek(2).k==="id" && ["for","while","loop"].includes(peek(2).v)){ next(); next(); }   // label: for …
    if(at("if")){ next(); const arms=[]; let c=expr(); want("then"); arms.push({c, body:seqBlock("elsif","else","end")});
      let els=null;
      for(;;){ if(at("elsif")){ next(); c=expr(); want("then"); arms.push({c, body:seqBlock("elsif","else","end")}); continue; }
        if(at("else")){ next(); els=seqBlock("end"); } break; }
      want("end"); want("if"); want(";"); return {t:"if", arms, els, line:t.line}; }
    if(at("case")){ next(); const e=expr(); want("is"); const arms=[];
      while(at("when")){ next(); const ch=choices(); want("=>"); arms.push({ch, body:seqBlock("when","end")}); }
      want("end"); want("case"); if(T[p].k==="id") next(); want(";"); return {t:"case", e, arms, line:t.line}; }
    if(at("for")){ next(); const v=ident().v; want("in"); const a=expr(); const dir=next().v; const b=expr(); want("loop");
      const body=seqBlock("end"); want("end"); want("loop"); if(T[p].k==="id") next(); want(";"); return {t:"for", v, a, b, dir, body, line:t.line}; }
    if(at("null")){ next(); want(";"); return {t:"null"}; }
    if(at("report")||at("assert")){ skipTo(";"); return {t:"null"}; }
    if(at("wait")) throw vhErr(t.line, "ไม่รองรับ wait — ใช้ process(clk) กับ rising_edge(clk) แทน");
    if(at("while")||at("exit")||at("next")||at("return")) throw vhErr(t.line, `ไม่รองรับคำสั่ง ${t.v} ในบล็อก VHDL`);
    const tg=target();
    if(at("<=")){ next(); const v=expr(); if(at("after")) skipTo(";"); else if(at("when")){ return condRest(tg, v, t.line, true); } else want(";"); return {t:"sa", tg, v, line:t.line}; }
    if(at(":=")){ next(); const v=expr(); want(";"); return {t:"va", tg, v, line:t.line}; }
    throw vhErr(t.line, `ต้องมี <= หรือ := หลัง ${t.raw||t.v}`);
  }
  function choices(){ const L=[];
    do{ if(at("others")){ next(); L.push({others:true}); continue; }
      const a=expr(); if(at("to")||at("downto")){ const dir=next().v; L.push({range:{a, b:expr(), dir}}); } else L.push({e:a}); } while(opt("|"));
    return L; }
  // target <= v when c else v2 when c2 else v3;  → an if-chain
  function condRest(tg, v, line){
    const arms=[]; let els=null, cur=v;
    while(at("when")){ next(); const c=expr();
      if(at("else")){ next(); arms.push({c, body:[{t:"sa", tg, v:cur, line}]}); cur=expr(); continue; }
      want(";"); arms.push({c, body:[{t:"sa", tg, v:cur, line}]}); return {t:"if", arms, els:null, line}; }
    want(";"); els=[{t:"sa", tg, v:cur, line}]; return {t:"if", arms, els, line};
  }
  // ---- declarations ----
  function decls(D, inProcess){
    for(;;){
      const t=T[p];
      if(at("signal") && !inProcess){ next(); const names=[ident()]; while(opt(",")) names.push(ident()); want(":"); const ty=subtype(); let init=null; if(opt(":=")) init=expr(); want(";");
        names.forEach(n=>D.push({k:"signal", name:n.v, raw:n.raw, ty, init, line:n.line})); continue; }
      if(at("variable") || (at("shared")&&peek(1).v==="variable")){ if(at("shared")) next(); next(); const names=[ident()]; while(opt(",")) names.push(ident()); want(":"); const ty=subtype(); let init=null; if(opt(":=")) init=expr(); want(";");
        names.forEach(n=>D.push({k:"var", name:n.v, ty, init, line:n.line})); continue; }
      if(at("constant")){ next(); const names=[ident()]; while(opt(",")) names.push(ident()); want(":"); const ty=subtype(); want(":="); const init=expr(); want(";");
        names.forEach(n=>D.push({k:"const", name:n.v, ty, init, line:n.line})); continue; }
      if(at("type")){ next(); const n=ident(); want("is");
        if(at("(")){ next(); const lits=[ident().v]; while(opt(",")) lits.push(ident().v); want(")"); want(";"); D.push({k:"enum", name:n.v, lits, line:n.line}); continue; }
        if(at("array")){ next(); want("("); const a=expr(); const dir=next().v; if(dir!=="to"&&dir!=="downto") throw vhErr(n.line, "array ต้องกำหนดช่วงเป็นตัวเลข เช่น (0 to 15)"); const b=expr(); want(")"); want("of"); const el=subtype(); want(";");
          D.push({k:"array", name:n.v, range:{a, b, dir}, el, line:n.line}); continue; }
        if(at("range")){ next(); const a=expr(); const dir=next().v; const b=expr(); want(";"); D.push({k:"subtype", name:n.v, ty:{name:"integer", irange:{a, b, dir}}, line:n.line}); continue; }
        throw vhErr(n.line, "รองรับ type แบบ enum (S0, S1, …), array หรือ range เท่านั้น"); }
      if(at("subtype")){ next(); const n=ident(); want("is"); const ty=subtype(); want(";"); D.push({k:"subtype", name:n.v, ty, line:n.line}); continue; }
      if(at("attribute")||at("alias")){ skipTo(";"); continue; }
      if(T[p].k==="id" && UNSUP.has(T[p].v)) throw vhErr(t.line, T[p].v==="component" ? "ไม่รองรับ component ข้างในบล็อก VHDL — วางบล็อกย่อยบนแผ่นวงจรแล้วต่อสายแทน" : `ไม่รองรับ ${T[p].v} ในบล็อก VHDL`);
      return D;
    }
  }
  function concurrent(){
    const S=[];
    while(!at("end")){
      const t=T[p]; if(t.k==="eof") throw vhErr(t.line, "ไม่เจอ end ของ architecture");
      let label=null;
      if(t.k==="id" && peek(1).v===":"){ label=t.v; next(); next(); }
      if(at("process")){ next(); let sens=null; if(at("(")){ next(); sens=[]; if(!at(")")) do{ sens.push(ident().v); } while(opt(",")); want(")"); }
        opt("is"); const D=decls([], true); want("begin"); const body=seqBlock("end"); want("end"); want("process"); if(T[p].k==="id") next(); want(";");
        S.push({t:"proc", label, sens, decls:D, body, line:t.line}); continue; }
      if(at("with")){ next(); const e=expr(); want("select"); const tg=target(); want("<="); const arms=[];
        do{ const v=expr(); want("when"); const ch=choices(); arms.push({ch, body:[{t:"sa", tg, v, line:t.line}]}); } while(opt(","));
        want(";"); S.push({t:"proc", label, sens:null, decls:[], body:[{t:"case", e, arms, line:t.line}], line:t.line, conc:true}); continue; }
      if(at("entity") || (label && T[p].k==="id" && (peek(1).v==="port"||peek(1).v==="generic"||(T[p].v==="component")))) throw vhErr(t.line, "ไม่รองรับการเรียกบล็อกย่อย (port map) ข้างในบล็อก VHDL — วางบล็อกย่อยบนแผ่นวงจรแล้วต่อสายแทน");
      if(at("assert")){ skipTo(";"); continue; }
      if(at("generate")||at("block")||(label && at("for"))||(label && at("if"))) throw vhErr(t.line, "ไม่รองรับ generate ในบล็อก VHDL");
      const tg=target(); want("<="); const v=expr();
      if(at("after")){ while(!at("when") && !at(";")) p++; }
      if(at("when")){ S.push({t:"proc", label, sens:null, decls:[], body:[condRest(tg, v, t.line)], line:t.line, conc:true}); continue; }
      want(";"); S.push({t:"proc", label, sens:null, decls:[], body:[{t:"sa", tg, v, line:t.line}], line:t.line, conc:true});
    }
    return S;
  }
  // ---- design file ----
  let ent=null, arch=null;
  while(T[p].k!=="eof"){
    if(at("library")||at("use")){ skipTo(";"); continue; }
    if(at("entity")){ const line=T[p].line; next(); if(ent) throw vhErr(line, "มี entity ได้ตัวเดียวต่อบล็อก"); const n=ident(); want("is");
      const generics=[], ports=[];
      if(at("generic")){ next(); want("(");
        do{ if(at(")")) break; const names=[ident()]; while(opt(",")) names.push(ident()); want(":"); const ty=subtype(); let init=null; if(opt(":=")) init=expr();
          names.forEach(x=>generics.push({name:x.v, ty, init, line:x.line})); } while(opt(";"));
        want(")"); want(";"); }
      if(at("port")){ next(); want("(");
        do{ if(at(")")) break; const names=[ident()]; while(opt(",")) names.push(ident()); want(":");
          const mt=T[p]; let mode="in"; if(mt.k==="id" && ["in","out","inout","buffer","linkage"].includes(mt.v)){ mode=mt.v; next(); }
          if(mode==="inout"||mode==="linkage") throw vhErr(mt.line, `ไม่รองรับขาแบบ ${mode} — ใช้ in หรือ out`);
          const ty=subtype(); if(opt(":=")) expr();
          names.forEach(x=>ports.push({name:x.v, raw:x.raw, mode:mode==="buffer"?"out":mode, ty, line:x.line})); } while(opt(";"));
        want(")"); want(";"); }
      want("end"); opt("entity"); if(T[p].k==="id") next(); want(";");
      ent={name:n.v, raw:n.raw, generics, ports, line}; continue; }
    if(at("architecture")){ const line=T[p].line; next(); const an=ident(); want("of"); const of=ident(); want("is");
      if(arch) throw vhErr(line, "มี architecture ได้ตัวเดียวต่อบล็อก");
      const D=decls([], false); want("begin"); const S=concurrent(); want("end"); opt("architecture"); if(T[p].k==="id") next(); want(";");
      arch={name:an.v, of:of.v, decls:D, stmts:S, line}; continue; }
    throw vhErr(T[p].line, `ต้องขึ้นต้นด้วย library / use / entity / architecture (เจอ '${T[p].v}')`);
  }
  if(!ent) throw vhErr(0, "ไม่เจอ entity — บล็อก VHDL ต้องมี entity … is port(…); end;");
  if(!arch) throw vhErr(0, "ไม่เจอ architecture ของ "+ent.raw);
  if(arch.of!==ent.name) throw vhErr(arch.line, `architecture เป็นของ ${arch.of} แต่ entity ชื่อ ${ent.raw}`);
  return {ent, arch};
}

/* ---------------- values ----------------
   sl {k:"sl",v} · vec {k:"vec",v,w,s(signed),hi,lo,asc} · int {k:"int",v} · bool · enum {k:"enum",v} · arr {k:"arr",a,lo,hi,asc} */
const VH_MAXW=32;
const vhMask=w=>w>=32?0xFFFFFFFF:((1<<w)>>>0)-1;
const vhSL=v=>({k:"sl", v:v?1:0}), vhInt=v=>({k:"int", v:Math.trunc(v)}), vhBool=v=>({k:"bool", v:!!v});
function vhVec(v, w, s, r){ v=Number(v); const m=vhMask(w); const x=((v%4294967296)+4294967296)%4294967296; const o={k:"vec", v:(x>>>0)&m, w, s:!!s};
  if(r){ if(r.hi!=null){ o.hi=r.hi; o.lo=r.lo; o.asc=r.asc; } if(r.t) o.t=r.t; } return o; }
function vhNum(x){        // a vec's numeric value: signed → two's complement
  if(x.k==="vec") return x.s && x.w>0 && (x.v>>>(x.w-1))&1 ? x.v-2**x.w : x.v;
  if(x.k==="sl"||x.k==="int") return x.v;
  if(x.k==="bool") return x.v?1:0;
  throw new Error("ใช้ค่า "+x.k+" เป็นตัวเลขไม่ได้");
}
function vhEq(a, b){
  if(a===b) return true; if(!a||!b) return false;
  if(a.k==="arr"||b.k==="arr"){ if(a.k!==b.k||a.a.length!==b.a.length) return false; return a.a.every((x,i)=>vhEq(x,b.a[i])); }
  if(a.k==="enum"||b.k==="enum") return a.k===b.k && a.v===b.v;
  if(a.k==="vec" && b.k==="vec" && !a.s && !b.s && a.w!==b.w) return a.v===b.v;
  return vhNum(a)===vhNum(b);
}
function vhStr(x){ if(!x) return "?"; if(x.k==="vec") return x.v.toString(2).padStart(x.w,"0"); if(x.k==="arr") return "("+x.a.map(vhStr).join(",")+")"; return String(x.k==="bool"?x.v:x.v); }

/* ---------------- elaboration ---------------- */
function vhCompile(src){
  const {ent, arch}=vhParse(src);
  const consts=new Map(), types=new Map(), sigs=new Map(), warns=[];
  const ce=e=>vhEval(e, {look:n=>consts.has(n)?{val:consts.get(n), ty:null}:(enumLit.has(n)?{val:{k:"enum", v:n}}:null), types, events:new Set(), consts:true});
  const enumLit=new Map();
  // a type from its indication
  function tyOf(st, line){
    const n=st.name;
    if(types.has(n) && !st.range){ const T0=types.get(n); if(st.irange) return Object.assign({}, T0, irange(st.irange)); return T0; }
    if(["std_logic","std_ulogic","bit"].includes(n)) return {kind:"sl"};
    if(n==="boolean") return {kind:"bool"};
    if(["integer","natural","positive"].includes(n)){ const r=st.irange?irange(st.irange):{lo:n==="integer"?-2147483648:(n==="positive"?1:0), hi:2147483647}; return Object.assign({kind:"int"}, r); }
    if(["std_logic_vector","std_ulogic_vector","bit_vector","unsigned","signed"].includes(n)){
      if(!st.range) throw vhErr(st.line||line, `${n} ต้องบอกขนาด เช่น ${n}(7 downto 0)`);
      const a=vhNum(ce(st.range.a)), b=vhNum(ce(st.range.b)), asc=st.range.dir==="to", hi=asc?b:a, lo=asc?a:b, w=hi-lo+1;
      if(w<1) throw vhErr(st.line||line, "ช่วงของเวกเตอร์ว่าง");
      if(w>VH_MAXW) throw vhErr(st.line||line, `ตัวจำลองรองรับเวกเตอร์ไม่เกิน ${VH_MAXW} บิต (${n} นี้ ${w} บิต)`);
      return {kind:"vec", w, hi, lo, asc, s:n==="signed", t:n==="unsigned"?"uns":n==="signed"?"sgn":"slv"};
    }
    if(types.has(n)) return types.get(n);
    throw vhErr(st.line||line, `ไม่รู้จักชนิดข้อมูล ${n}`);
  }
  function irange(r){ const a=vhNum(ce(r.a)), b=vhNum(ce(r.b)); return {lo:Math.min(a,b), hi:Math.max(a,b)}; }
  function initOf(ty){
    if(ty.kind==="sl") return vhSL(0);
    if(ty.kind==="bool") return vhBool(false);
    if(ty.kind==="int") return vhInt(Math.max(ty.lo, Math.min(ty.hi, 0)));
    if(ty.kind==="vec") return vhVec(0, ty.w, ty.s, ty);
    if(ty.kind==="enum") return {k:"enum", v:ty.lits[0]};
    if(ty.kind==="arr"){ const a=[]; for(let i=ty.lo;i<=ty.hi;i++) a.push(initOf(ty.el)); return {k:"arr", a, lo:ty.lo, hi:ty.hi, asc:ty.asc}; }
  }
  const fit=(v, ty, line)=>vhFit(v, ty, line, warns);
  ent.generics.forEach(g=>{ if(!g.init) throw vhErr(g.line, `generic ${g.name} ต้องมีค่าเริ่มต้น (:= …)`); const ty=tyOf(g.ty, g.line); consts.set(g.name, fit(ce(g.init), ty, g.line)); });
  const ports=ent.ports.map(pt=>{ const ty=tyOf(pt.ty, pt.line);
    if(!["sl","vec"].includes(ty.kind)) throw vhErr(pt.line, `ขา ${pt.raw} ต้องเป็น std_logic หรือ std_logic_vector / unsigned / signed (ขาบนแผ่นวงจรต้องรู้จำนวนบิต)`);
    return {name:pt.name, raw:pt.raw, dir:pt.mode, ty, width:ty.kind==="vec"?ty.w:1}; });
  const portBy=new Map(ports.map(x=>[x.name,x]));
  arch.decls.forEach(d=>{
    if(portBy.has(d.name)||consts.has(d.name)||sigs.has(d.name)) throw vhErr(d.line, `ชื่อ ${d.name} ซ้ำ`);
    if(d.k==="enum"){ const ty={kind:"enum", lits:d.lits, name:d.name}; types.set(d.name, ty); d.lits.forEach(l=>enumLit.set(l, d.name)); return; }
    if(d.k==="array"){ const a=vhNum(ce(d.range.a)), b=vhNum(ce(d.range.b)); const asc=d.range.dir==="to";
      types.set(d.name, {kind:"arr", lo:Math.min(a,b), hi:Math.max(a,b), asc, el:tyOf(d.el, d.line), name:d.name}); return; }
    if(d.k==="subtype"){ types.set(d.name, tyOf(d.ty, d.line)); return; }
    const ty=tyOf(d.ty, d.line);
    if(d.k==="const"){ consts.set(d.name, fit(vhEval(d.init, {look:n=>consts.has(n)?{val:consts.get(n)}:(enumLit.has(n)?{val:{k:"enum", v:n}}:null), types, events:new Set(), consts:true, want:ty}), ty, d.line)); return; }
    if(d.k==="signal") sigs.set(d.name, {ty, init:d.init ? fit(vhEval(d.init, {look:n=>consts.has(n)?{val:consts.get(n)}:(enumLit.has(n)?{val:{k:"enum", v:n}}:null), types, events:new Set(), consts:true, want:ty}), ty, d.line) : initOf(ty), raw:d.raw, line:d.line});
  });
  ports.filter(x=>x.dir==="out").forEach(x=>sigs.set(x.name, {ty:x.ty, init:initOf(x.ty), port:true, raw:x.raw}));
  // processes: their variables, what they assign, whether they wait for an edge
  const procs=arch.stmts.map((s,k)=>{
    const vars=new Map();
    s.decls.forEach(d=>{ if(d.k==="const"){ const ty=tyOf(d.ty, d.line); consts.set(d.name, fit(ce(d.init), ty, d.line)); return; }
      if(d.k==="var"){ const ty=tyOf(d.ty, d.line); vars.set(d.name, {ty, init:d.init?fit(vhEval(d.init,{look:n=>consts.has(n)?{val:consts.get(n)}:(enumLit.has(n)?{val:{k:"enum", v:n}}:null), types, events:new Set(), consts:true, want:ty}), ty, d.line):initOf(ty)}); return; }
      if(d.k==="enum"||d.k==="array"||d.k==="subtype") throw vhErr(d.line, "ประกาศ type ไว้ใน architecture (ก่อน begin) แทนใน process"); });
    const assigns=new Set(), edges=new Set(); let clocked=false;
    const walkE=e=>{ if(!e||typeof e!=="object") return;
      if(e.t==="call" && e.f.t==="name" && ["rising_edge","falling_edge"].includes(e.f.id)){ clocked=true; const a=e.args[0]; if(a&&a.t==="name") edges.add(a.id); }
      if(e.t==="attr" && e.attr==="event"){ clocked=true; if(e.base.t==="name") edges.add(e.base.id); }
      Object.values(e).forEach(x=>{ if(Array.isArray(x)) x.forEach(walkE); else if(x&&typeof x==="object") walkE(x); }); };
    const walkS=L=>L.forEach(st=>{ if(st.t==="sa"){ const b=vhBaseName(st.tg); assigns.add(b); walkE(st.v); walkE(st.tg); }
      else if(st.t==="va"){ walkE(st.v); }
      else if(st.t==="if"){ st.arms.forEach(a=>{ walkE(a.c); walkS(a.body); }); if(st.els) walkS(st.els); }
      else if(st.t==="case"){ walkE(st.e); st.arms.forEach(a=>walkS(a.body)); }
      else if(st.t==="for") walkS(st.body); });
    walkS(s.body);
    return {k, body:s.body, vars, assigns, edges, clocked, line:s.line, conc:!!s.conc};
  });
  // drivers: one process per signal (Vivado: "multiple drivers")
  const driver=new Map();
  procs.forEach(pr=>pr.assigns.forEach(n=>{
    if(portBy.has(n) && portBy.get(n).dir==="in") throw vhErr(pr.line, `กำหนดค่าให้ขา in '${portBy.get(n).raw}' ไม่ได้`);
    if(!sigs.has(n)) throw vhErr(pr.line, `ไม่รู้จักสัญญาณ ${n} (ต้องประกาศ signal ก่อน begin หรือเป็นขา out)`);
    if(driver.has(n) && driver.get(n)!==pr.k) throw vhErr(pr.line, `สัญญาณ ${sigs.get(n).raw||n} ถูกกำหนดค่าจากหลาย process / หลายบรรทัด (multiple drivers — Vivado จะ error)`);
    driver.set(n, pr.k); }));
  ports.filter(x=>x.dir==="out" && !driver.has(x.name)).forEach(x=>warns.push(`ขา out ${x.raw} ไม่ได้ถูกกำหนดค่า (จะเป็น 0)`));
  const clockPorts=new Set(); procs.forEach(pr=>pr.edges.forEach(n=>{ if(portBy.has(n) && portBy.get(n).dir==="in") clockPorts.add(n); }));
  return {name:ent.name, raw:ent.raw, ports, portBy, consts, types, sigs, procs, enumLit, warns,
    sequential:procs.some(pr=>pr.clocked), clockPorts:[...clockPorts]};
}
const vhBaseName=n=>n.t==="name" ? n.id : vhBaseName(n.f);
function vhFit(v, ty, line, warns){
  if(!ty) return v;
  if(ty.kind==="sl"){ if(v.k==="sl") return v; if(v.k==="vec" && v.w===1) return vhSL(v.v&1); throw vhErr(line, `ต้องเป็น std_logic ('0' / '1') แต่ได้ ${v.k==="vec"?v.w+" บิต":v.k}`); }
  if(ty.kind==="bool"){ if(v.k==="bool") return v; throw vhErr(line, "ต้องเป็นค่า boolean (true / false หรือเงื่อนไข)"); }
  if(ty.kind==="int"){ if(v.k!=="int") throw vhErr(line, `ต้องเป็นจำนวนเต็ม (ใช้ to_integer(unsigned(x)) แปลงเวกเตอร์)`);
    if(v.v<ty.lo || v.v>ty.hi){ if(warns && !warns.some(w=>w.includes("เกินช่วง"))) warns.push(`บรรทัด ${line}: ค่า ${v.v} เกินช่วง ${ty.lo} to ${ty.hi} — บนบอร์ดจะวนกลับตามจำนวนบิต ตรวจเงื่อนไขรีเซ็ต`);
      const bits=Math.max(1, Math.ceil(Math.log2(ty.hi+1))); return vhInt(((v.v%2**bits)+2**bits)%2**bits); }
    return v; }
  if(ty.kind==="vec"){
    if(v.k==="vec"){ if(v.w!==ty.w) throw vhErr(line, `ความกว้างไม่ตรง: ด้านซ้าย ${ty.w} บิต, ด้านขวา ${v.w} บิต`);
      if(v.t && ty.t && v.t!==ty.t){ const N={slv:"std_logic_vector", uns:"unsigned", sgn:"signed"};
        throw vhErr(line, `ชนิดไม่ตรง: ด้านขวาเป็น ${N[v.t]} แต่ด้านซ้ายเป็น ${N[ty.t]} — แปลงด้วย ${N[ty.t]}(…)`); }
      return vhVec(v.v, ty.w, ty.s, ty); }
    if(v.k==="sl" && ty.w===1) return vhVec(v.v, 1, ty.s, ty);
    throw vhErr(line, v.k==="int" ? `กำหนดจำนวนเต็มให้เวกเตอร์ ${ty.w} บิตตรงๆ ไม่ได้ — ใช้ std_logic_vector(to_unsigned(x, ${ty.w}))` : `ต้องเป็นเวกเตอร์ ${ty.w} บิต`); }
  if(ty.kind==="enum"){ if(v.k==="enum" && ty.lits.includes(v.v)) return v; throw vhErr(line, `ค่าต้องเป็นหนึ่งใน ${ty.lits.join(", ")}`); }
  if(ty.kind==="arr"){ if(v.k!=="arr" || v.a.length!==ty.hi-ty.lo+1) throw vhErr(line, `ต้องเป็นตาราง ${ty.hi-ty.lo+1} ช่อง`);
    return {k:"arr", a:v.a.map(x=>vhFit(x, ty.el, line, warns)), lo:ty.lo, hi:ty.hi, asc:ty.asc}; }
  return v;
}
/* bit position (from the LSB) of index i in a vector with range info */
function vhPos(x, i, line){ const hi=x.hi!=null?x.hi:x.w-1, lo=x.lo!=null?x.lo:0;
  if(i<lo||i>hi) throw vhErr(line, `ดัชนี ${i} อยู่นอกช่วง ${x.asc?lo+" to "+hi:hi+" downto "+lo}`);
  return x.asc ? hi-i : i-lo; }

/* ---------------- expressions ----------------
   C = {look(name) → {val, ty?} | null, types, events:Set, want:type|null} */
function vhEval(e, C){
  const want=C.want; C=Object.assign({}, C, {want:null});
  const line=e.line;
  switch(e.t){
    case "lit": return e.v;                 // a value already computed (shift_left & co.)
    case "num": return vhInt(e.v);
    case "chr": { const c=e.v.toUpperCase(); if(c==="1"||c==="H") return vhSL(1); if(c==="0"||c==="L") return vhSL(0); return vhSL(0); }
    case "str": { if(!/^[01]*$/.test(e.v.replace(/[-ZXUzxu]/g,"0"))) throw vhErr(line, `"${e.v}" ไม่ใช่ค่าบิต`);
      const s=e.v.replace(/[-ZXUzxu]/g,"0"); if(s.length>VH_MAXW) throw vhErr(line, "ค่าบิตยาวเกิน 32 บิต");
      return vhVec(s?parseInt(s,2):0, s.length, want&&want.kind==="vec"&&want.s); }
    case "name": {
      if(e.id==="true") return vhBool(true); if(e.id==="false") return vhBool(false);
      const o=C.look(e.id); if(o) return o.val;
      throw vhErr(line, `ไม่รู้จักชื่อ ${e.raw||e.id}`); }
    case "agg": return vhAgg(e, C, want);
    case "un": { const a=vhEval(e.a, C);
      if(e.op==="not"){ if(a.k==="sl") return vhSL(1-a.v); if(a.k==="bool") return vhBool(!a.v); if(a.k==="vec") return Object.assign({}, a, {v:(~a.v)&vhMask(a.w)}); throw vhErr(line, "not ใช้กับบิต / เวกเตอร์ / เงื่อนไข"); }
      if(e.op==="-"){ if(a.k==="int") return vhInt(-a.v); if(a.k==="vec") return vhVec(-vhNum(a), a.w, a.s, {t:a.t}); }
      if(e.op==="+") return a;
      if(e.op==="abs") return a.k==="int" ? vhInt(Math.abs(a.v)) : vhVec(Math.abs(vhNum(a)), a.w, a.s, {t:a.t});
      throw vhErr(line, "ใช้ "+e.op+" กับค่านี้ไม่ได้"); }
    case "bin": return vhBin(e, C, want);
    case "attr": {
      if(e.attr==="event"){ if(e.base.t!=="name") throw vhErr(line, "'event ใช้กับชื่อสัญญาณ"); return vhBool(C.events.has(e.base.id)); }
      const o=e.base.t==="name" ? (C.look(e.base.id)||{}) : {val:vhEval(e.base, C)};
      const x=o.val, ty=o.ty || (C.types && e.base.t==="name" && C.types.get(e.base.id));
      const R=x&&x.k==="vec" ? {lo:x.lo!=null?x.lo:0, hi:x.hi!=null?x.hi:x.w-1, asc:!!x.asc} : x&&x.k==="arr" ? x : ty&&(ty.kind==="arr"||ty.kind==="vec") ? ty : null;
      if(e.attr==="length" && R) return vhInt(R.hi-R.lo+1);
      if(e.attr==="high" && R) return vhInt(R.hi); if(e.attr==="low" && R) return vhInt(R.lo);
      if(e.attr==="left" && R) return vhInt(R.asc?R.lo:R.hi); if(e.attr==="right" && R) return vhInt(R.asc?R.hi:R.lo);
      throw vhErr(line, `ไม่รองรับ '${e.attr}`); }
    case "call": return vhCall(e, C, want);
    case "range": throw vhErr(line, "ช่วง (downto / to) ใช้ได้เฉพาะในวงเล็บหลังชื่อ");
  }
  throw vhErr(line, "นิพจน์ไม่รองรับ");
}
function vhAgg(e, C, want){
  const items=e.items;
  if(want && want.kind==="arr"){
    const n=want.hi-want.lo+1, a=new Array(n).fill(null), oth=items.find(x=>x.others);
    let k=0; items.forEach(x=>{ if(x.others) return;
      if(x.named){ const i=vhNum(vhEval(x.named, C)); a[want.asc?i-want.lo:want.hi-i]=vhFit(vhEval(x.v, Object.assign({}, C, {want:want.el})), want.el, e.line); }
      else a[k++]=vhFit(vhEval(x, Object.assign({}, C, {want:want.el})), want.el, e.line); });
    for(let i=0;i<n;i++) if(!a[i]){ if(!oth) throw vhErr(e.line, `ตารางมี ${n} ช่อง แต่ใส่ค่าไว้ ${k} ค่า (เติม others => …)`); a[i]=vhFit(vhEval(oth.v, Object.assign({}, C, {want:want.el})), want.el, e.line); }
    if(k>n) throw vhErr(e.line, `ตารางมี ${n} ช่อง แต่ใส่ค่าไว้ ${k} ค่า`);
    return {k:"arr", a, lo:want.lo, hi:want.hi, asc:want.asc};
  }
  // a vector aggregate: (others => '0'), ('1', others => '0'), (3 => '1', others => '0'), ('0','1','1')
  const w=want && want.kind==="vec" ? want.w : (items.every(x=>!x.others && !x.named) ? items.length : null);
  if(!w) throw vhErr(e.line, "ใช้ (others => …) ได้เมื่อรู้ขนาดปลายทาง — กำหนดให้สัญญาณที่ประกาศขนาดไว้");
  const R=want && want.kind==="vec" ? want : {w, hi:w-1, lo:0, asc:false};
  let v=0, set=new Array(w).fill(false), k=0;
  const bit=x=>{ const b=vhEval(x, C); if(b.k!=="sl") throw vhErr(e.line, "สมาชิกของเวกเตอร์ต้องเป็น '0' / '1'"); return b.v; };
  items.forEach(x=>{ if(x.others) return;
    if(x.named){ const i=vhNum(vhEval(x.named, C)); const pos=vhPos(Object.assign({w}, R), i, e.line); if(bit(x.v)) v|=1<<pos; set[pos]=true; }
    else { const pos=w-1-k; k++; if(bit(x)) v|=1<<pos; set[pos]=true; } });
  const oth=items.find(x=>x.others); if(oth){ const b=bit(oth.v); for(let i=0;i<w;i++) if(!set[i] && b) v|=1<<i; }
  return vhVec(v>>>0, w, R.s, R);
}
function vhBin(e, C, want){
  const op=e.op, line=e.line;
  if(["and","or","xor","nand","nor","xnor"].includes(op)){
    const a=vhEval(e.a, C);
    if(a.k==="bool" && (op==="and"||op==="or")){ if(op==="and" && !a.v) return a; if(op==="or" && a.v) return a; }   // short-circuit, like VHDL
    const b=vhEval(e.b, C);
    const f={and:(x,y)=>x&y, or:(x,y)=>x|y, xor:(x,y)=>x^y, nand:(x,y)=>~(x&y), nor:(x,y)=>~(x|y), xnor:(x,y)=>~(x^y)}[op];
    if(a.k==="bool" && b.k==="bool") return vhBool(f(a.v?1:0, b.v?1:0)&1);
    if(a.k==="sl" && b.k==="sl") return vhSL(f(a.v,b.v)&1);
    if(a.k==="vec" && b.k==="vec"){ if(a.w!==b.w) throw vhErr(line, `${op} ระหว่างเวกเตอร์ ${a.w} กับ ${b.w} บิต — ขนาดต้องเท่ากัน`); return Object.assign({}, a, {v:(f(a.v,b.v)>>>0)&vhMask(a.w)}); }
    throw vhErr(line, `${op} ใช้กับ ${a.k} และ ${b.k} ไม่ได้ (เงื่อนไขกับบิตปนกัน? เขียน a = '1' ให้เป็นเงื่อนไข)`);
  }
  const a=vhEval(e.a, C), b=vhEval(e.b, Object.assign({}, C, {want:a.k==="vec"?{kind:"vec", w:a.w, s:a.s}:a.k==="arr"?null:null}));
  if(["=","/=","<","<=",">",">="].includes(op)){
    let r;
    if(op==="="||op==="/="){ if((a.k==="bool")!==(b.k==="bool")) throw vhErr(line, "เทียบ boolean กับค่าบิตไม่ได้"); r=vhEq(a,b); if(op==="/=") r=!r; }
    else { if(a.k==="enum"||b.k==="enum"){ throw vhErr(line, "เทียบมากกว่า/น้อยกว่ากับ state ไม่ได้"); }
      const x=vhNum(a), y=vhNum(b); r=op==="<"?x<y:op==="<="?x<=y:op===">"?x>y:x>=y; }
    return vhBool(r);
  }
  if(op==="&"){
    const part=x=>x.k==="sl" ? {v:x.v, w:1} : x.k==="vec" ? {v:x.v, w:x.w} : null;
    const A=part(a), B=part(b); if(!A||!B) throw vhErr(line, "& ต่อได้เฉพาะบิตและเวกเตอร์");
    const w=A.w+B.w; if(w>VH_MAXW) throw vhErr(line, "ต่อแล้วยาวเกิน 32 บิต");
    return vhVec(A.v*2**B.w + B.v, w, false);
  }
  if(["sll","srl","sla","sra","rol","ror"].includes(op)){
    if(a.k!=="vec") throw vhErr(line, op+" ใช้กับเวกเตอร์"); const n=vhNum(b), m=vhMask(a.w);
    if(op==="sll"||op==="sla") return Object.assign({}, a, {v:(a.v<<n>>>0)&m});
    if(op==="srl") return Object.assign({}, a, {v:a.v>>>n});
    if(op==="sra") return vhVec(vhNum(Object.assign({}, a, {s:true}))>>n, a.w, a.s);
    const k=((n%a.w)+a.w)%a.w; if(op==="rol") return Object.assign({}, a, {v:((a.v<<k)|(a.v>>>(a.w-k)))&m});
    return Object.assign({}, a, {v:((a.v>>>k)|(a.v<<(a.w-k)))&m});
  }
  // arithmetic
  const num=x=>{ if(x.k==="int"||x.k==="vec") return vhNum(x); if(x.k==="sl") return x.v; throw vhErr(line, `คำนวณ ${op} กับ ${x.k} ไม่ได้`); };
  const x=num(a), y=num(b);
  let r;
  if(op==="+") r=x+y; else if(op==="-") r=x-y; else if(op==="*") r=x*y;
  else if(op==="/"){ if(y===0) throw vhErr(line, "หารด้วย 0"); r=Math.trunc(x/y); }
  else if(op==="mod"){ if(y===0) throw vhErr(line, "mod 0"); r=((x%y)+y)%y; }
  else if(op==="rem"){ if(y===0) throw vhErr(line, "rem 0"); r=x%y; }
  else if(op==="**") r=x**y;
  else throw vhErr(line, "ไม่รู้จักเครื่องหมาย "+op);
  if(a.k==="vec"||b.k==="vec"){
    const w = op==="*" ? (a.k==="vec"&&b.k==="vec" ? a.w+b.w : 2*(a.k==="vec"?a.w:b.w)) : Math.max(a.k==="vec"?a.w:0, b.k==="vec"?b.w:0);
    if(w>VH_MAXW) throw vhErr(line, "ผลคูณกว้างเกิน 32 บิต");
    const fam=[a,b].map(x=>x.k==="vec"?x.t:null), t=fam.find(f=>f==="uns"||f==="sgn")||fam.find(f=>f==="slv");
    return vhVec(r, w, (a.k==="vec"&&a.s)||(b.k==="vec"&&b.s), {t});
  }
  return vhInt(r);
}
function vhCall(e, C, want){
  const line=e.line, f=e.f.t==="name" ? e.f.id : null, A=e.args;
  const arg=(i,w)=>{ if(!A[i]) throw vhErr(line, `${f} ต้องมีอาร์กิวเมนต์ที่ ${i+1}`); return vhEval(A[i], Object.assign({}, C, {want:w||null})); };
  // a declared object indexed / sliced (signal, variable, constant, ROM table)
  const o=f ? C.look(f) : null;
  if(o || e.f.t!=="name"){
    const x=o ? o.val : vhEval(e.f, C);
    if(A.length!==1) throw vhErr(line, "ใส่ดัชนีได้ทีละตัว");
    const r=A[0];
    if(r.t==="range"){ if(x.k!=="vec") throw vhErr(line, "ตัด (slice) ได้เฉพาะเวกเตอร์");
      const i=vhNum(vhEval(r.a, C)), j=vhNum(vhEval(r.b, C)), p1=vhPos(x, i, line), p2=vhPos(x, j, line), lo=Math.min(p1,p2), w=Math.abs(p1-p2)+1;
      return vhVec((x.v>>>lo)&vhMask(w), w, x.s, {hi:Math.max(i,j), lo:Math.min(i,j), asc:r.dir==="to", t:x.t}); }
    const i=vhNum(vhEval(r, C));
    if(x.k==="vec") return vhSL((x.v>>>vhPos(x, i, line))&1);
    if(x.k==="arr"){ if(i<x.lo||i>x.hi) throw vhErr(line, `ดัชนี ${i} อยู่นอกตาราง (${x.lo} to ${x.hi})`); return x.a[x.asc?i-x.lo:x.hi-i]; }
    throw vhErr(line, `${f} ไม่ใช่เวกเตอร์หรือตาราง ใส่ดัชนีไม่ได้`);
  }
  switch(f){
    case "rising_edge": case "falling_edge": { const s=A[0]; if(!s||s.t!=="name") throw vhErr(line, f+"(…) ต้องใส่ชื่อสัญญาณ");
      const v=vhEval(s, C); return vhBool(C.events.has(s.id) && v.v===(f==="rising_edge"?1:0)); }
    case "to_integer": case "conv_integer": { const x=arg(0); if(x.k==="int") return x; if(x.k==="sl") return vhInt(x.v); if(x.k!=="vec") throw vhErr(line, f+" รับเวกเตอร์");
      return vhInt(vhNum(x)); }
    case "unsigned": case "signed": case "std_logic_vector": case "std_ulogic_vector": case "bit_vector": {
      const x=arg(0, want); if(x.k!=="vec") throw vhErr(line, `${f}(…) แปลงได้เฉพาะเวกเตอร์ — จำนวนเต็มใช้ to_unsigned(x, n)`);
      return Object.assign({}, x, {s:f==="signed", t:f==="unsigned"?"uns":f==="signed"?"sgn":"slv"}); }
    case "to_unsigned": case "to_signed": case "conv_std_logic_vector": { const x=arg(0), n=vhNum(arg(1));
      if(n<1||n>VH_MAXW) throw vhErr(line, "ขนาดต้องอยู่ระหว่าง 1 ถึง 32"); return vhVec(vhNum(x), n, f==="to_signed", {t:f==="to_unsigned"?"uns":f==="to_signed"?"sgn":"slv"}); }
    case "resize": { const x=arg(0), n=vhNum(arg(1)); if(x.k!=="vec") throw vhErr(line, "resize รับเวกเตอร์"); if(n<1||n>VH_MAXW) throw vhErr(line, "ขนาดต้องอยู่ระหว่าง 1 ถึง 32"); return vhVec(vhNum(x), n, x.s, {t:x.t}); }
    case "shift_left": case "shift_right": case "rotate_left": case "rotate_right": {
      const x=arg(0), n=vhNum(arg(1)); if(x.k!=="vec") throw vhErr(line, f+" รับเวกเตอร์");
      const op={shift_left:"sll", shift_right:x.s?"sra":"srl", rotate_left:"rol", rotate_right:"ror"}[f];
      return vhBin({t:"bin", op, a:{t:"lit", v:x}, b:{t:"lit", v:vhInt(n)}, line}, C); }
    case "std_logic": case "std_ulogic": { const x=arg(0); return x.k==="sl"?x:vhSL(x.v&1); }
    case "integer": case "natural": return vhInt(vhNum(arg(0)));
  }
  throw vhErr(line, `ไม่รู้จัก ${e.f.raw||f}(…) — ถ้าเป็นสัญญาณต้องประกาศก่อน`);
}

/* ---------------- running ----------------
   state = {sig: Map name→value, vars: [Map name→value per process]} (immutable between calls) */
function vhInitState(M){
  const sig={}; M.sigs.forEach((s,n)=>sig[n]=s.init);
  return {sig, vars:M.procs.map(pr=>{ const o={}; pr.vars.forEach((v,n)=>o[n]=v.init); return o; })};
}
function vhInputVal(M, name, raw){        // a pin value (number) → the port's type
  const pt=M.portBy.get(name); const n=raw==null?0:Number(raw)>>>0;
  return pt.ty.kind==="sl" ? vhSL(n&1) : vhVec(n, pt.ty.w, pt.ty.s, pt.ty);
}
/* run delta cycles from `state` with the inputs `ins` ({port: number}); `prevIns` = the inputs a moment
   ago (an input that differs is an event in the first delta — a clock edge). Returns the new state. */
function vhRun(M, state, ins, prevIns){
  const cur=Object.assign({}, state.sig), vars=state.vars.map(o=>Object.assign({}, o));
  const inV={}; M.ports.filter(x=>x.dir==="in").forEach(x=>inV[x.name]=vhInputVal(M, x.name, ins[x.name]));
  let events=new Set();
  if(prevIns) M.ports.filter(x=>x.dir==="in").forEach(x=>{ if(prevIns[x.name]!=null && !vhEq(vhInputVal(M, x.name, prevIns[x.name]), inV[x.name])) events.add(x.name); });
  for(let delta=0; delta<200; delta++){
    const next={};
    M.procs.forEach((pr,k)=>{
      const V=vars[k];
      const look=n=>{
        if(Object.prototype.hasOwnProperty.call(V,n)) return {val:V[n], ty:pr.vars.get(n).ty};
        if(inV[n]) return {val:inV[n], ty:M.portBy.get(n).ty};
        if(Object.prototype.hasOwnProperty.call(cur,n)) return {val:cur[n], ty:M.sigs.get(n).ty};
        if(M.consts.has(n)) return {val:M.consts.get(n)};
        if(M.enumLit.has(n)) return {val:{k:"enum", v:n}};
        return null; };
      const C={look, types:M.types, events};
      vhExec(pr.body, C, M, V, next, cur, pr);
    });
    const changed=new Set();
    Object.entries(next).forEach(([n,v])=>{ if(!vhEq(cur[n], v)){ cur[n]=v; changed.add(n); } });
    if(!changed.size) return {sig:cur, vars};
    events=changed;
  }
  throw vhErr(0, "สัญญาณในบล็อกเปลี่ยนไม่หยุด (combinational loop) — มีสัญญาณที่วนกลับมากำหนดค่าตัวเองโดยไม่ผ่าน clock");
}
function vhExec(L, C, M, V, next, cur, pr){
  for(const st of L){
    if(st.t==="null") continue;
    if(st.t==="sa"){ const n=vhBaseName(st.tg), s=M.sigs.get(n);
      const base=Object.prototype.hasOwnProperty.call(next,n) ? next[n] : cur[n];
      next[n]=vhAssign(st.tg, base, s.ty, C, st.line, M.warns, st.v); continue; }
    if(st.t==="va"){ const n=vhBaseName(st.tg); const d=pr.vars.get(n); if(!d) throw vhErr(st.line, `${n} ไม่ใช่ variable ของ process นี้ (สัญญาณใช้ <=)`);
      V[n]=vhAssign(st.tg, V[n], d.ty, C, st.line, M.warns, st.v); continue; }
    if(st.t==="if"){ let done=false;
      for(const a of st.arms){ const c=vhEval(a.c, C); if(c.k!=="bool") throw vhErr(st.line, "เงื่อนไขของ if ต้องเป็นการเทียบ เช่น a = '1' (ไม่ใช่ a เฉยๆ)");
        if(c.v){ vhExec(a.body, C, M, V, next, cur, pr); done=true; break; } }
      if(!done && st.els) vhExec(st.els, C, M, V, next, cur, pr); continue; }
    if(st.t==="case"){ const x=vhEval(st.e, C); let hit=null;
      for(const a of st.arms){
        if(a.ch.some(ch=>{ if(ch.others) return true;
          if(ch.range){ const lo=vhNum(vhEval(ch.range.a, C)), hi=vhNum(vhEval(ch.range.b, C)), v=vhNum(x); return v>=Math.min(lo,hi) && v<=Math.max(lo,hi); }
          const y=vhEval(ch.e, Object.assign({}, C, {want:x.k==="vec"?{kind:"vec", w:x.w}:null}));
          if(x.k==="vec" && y.k==="vec" && y.w!==x.w) throw vhErr(st.line, `ตัวเลือก "${vhStr(y)}" ยาว ${y.w} บิต แต่ค่าที่เทียบยาว ${x.w} บิต`);
          return vhEq(x, y); })){ hit=a; break; } }
      if(hit) vhExec(hit.body, C, M, V, next, cur, pr); continue; }
    if(st.t==="for"){ const a=vhNum(vhEval(st.a, C)), b=vhNum(vhEval(st.b, C)), step=st.dir==="downto"?-1:1;
      if(Math.abs(b-a)>4096) throw vhErr(st.line, "for loop ยาวเกินไป");
      const look0=C.look;
      for(let i=a; step>0?i<=b:i>=b; i+=step){ const iv=vhInt(i); const C2=Object.assign({}, C, {look:n=>n===st.v?{val:iv}:look0(n)}); vhExec(st.body, C2, M, V, next, cur, pr); }
      continue; }
  }
}
/* the value of `base` after writing the value of `rhs` to target tg (whole / one index / a slice) */
function vhAssign(tg, base, ty, C, line, warns, rhs){
  if(tg.t==="name") return vhFit(vhEval(rhs, Object.assign({}, C, {want:ty})), ty, line, warns);
  if(tg.f.t!=="name" || tg.args.length!==1) throw vhErr(line, "กำหนดค่าให้ดัชนีได้ชั้นเดียว เช่น q(3) <= '1'");
  const r=tg.args[0];
  if(ty.kind==="vec"){
    const R=Object.assign({}, ty);
    if(r.t==="range"){
      const i=vhNum(vhEval(r.a, C)), j=vhNum(vhEval(r.b, C)), p1=vhPos(R, i, line), p2=vhPos(R, j, line), lo=Math.min(p1,p2), w=Math.abs(p1-p2)+1;
      const v=vhFit(vhEval(rhs, Object.assign({}, C, {want:{kind:"vec", w, s:ty.s}})), {kind:"vec", w, hi:w-1, lo:0, t:ty.t}, line, warns);
      const m=(vhMask(w)*2**lo)>>>0;
      return vhVec(((base.v & ~m)>>>0) | ((v.v*2**lo)>>>0), ty.w, ty.s, ty);
    }
    const pos=vhPos(R, vhNum(vhEval(r, C)), line), b=vhEval(rhs, C);
    if(b.k!=="sl") throw vhErr(line, "บิตเดียวต้องกำหนดเป็น '0' หรือ '1'");
    const m=(2**pos)>>>0;
    return vhVec(b.v ? (base.v|m)>>>0 : (base.v & ~m)>>>0, ty.w, ty.s, ty);
  }
  if(ty.kind==="arr"){
    if(r.t==="range") throw vhErr(line, "กำหนดค่าตารางได้ทีละช่อง");
    const i=vhNum(vhEval(r, C)); if(i<ty.lo||i>ty.hi) throw vhErr(line, `ดัชนี ${i} อยู่นอกตาราง`);
    const a=base.a.slice(); a[ty.asc?i-ty.lo:ty.hi-i]=vhFit(vhEval(rhs, Object.assign({}, C, {want:ty.el})), ty.el, line, warns);
    return Object.assign({}, base, {a});
  }
  throw vhErr(line, "ใส่ดัชนีได้เฉพาะเวกเตอร์หรือตาราง");
}
