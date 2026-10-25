/* ===== 71. ASCII and music: circuits for the tables the exam room hands out ===========================
   "ตามที่แนบไปสองสิ่งนี้ให้โหลดเข้าห้องสอบด้วย (ASCII table, note frequency chart) ฝากทำวงจรที่น่าจะเกี่ยวข้อง":
   two library categories. ASCII: gate-level parts checked on every row (upper / lower case, value → hex
   character, '0'–'9' / 'A'–'F' → value, character → 7-seg) and VHDL blocks (the character of a switch code
   on the LCD with its hex / decimal, a text sent over UART). Music: VHDL blocks for the EDGE buzzer — one
   note from switches (octave fixed or from switches), a piano on 8 keys, and a song written as notes
   ("C4 D4 E4:2 R G4") — each frequency from the chart (A4 = 440 Hz, equal temperament), the half-period
   = clk / (2f) rounded; checked by running the VHDL and measuring the buzzer, at a small clk_hz. */

/* ---- the note chart ---- */
const NOTE_NAMES=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const noteFreq=(oct, k)=>440*Math.pow(2, (oct*12+k-57)/12);                     // k = 0 (C) … 11 (B)
const noteHalf=(clk, f)=>Math.max(1, Math.round(clk/(2*f)));
/* "C4", "C#4", "Db4", "R" (rest), optional ":beats" (0.5 … 4) → {k, oct, hb} (hb = half-beats), k = -1 for a rest */
function noteParse(tok, defOct){
  const m=/^(R|-|[A-Ga-g])([#b]?)(\d)?(?::(\d+(?:\.5)?|\.5))?$/.exec(tok);
  if(!m) throw new Error(`อ่านโน้ต "${tok}" ไม่ได้ — เขียนแบบ C4, F#4, Bb3, R (พัก), ต่อด้วย :2 = 2 จังหวะ`);
  const beats=m[4]!=null ? +m[4] : 1, hb=Math.round(beats*2);
  if(!(hb>=1 && hb<=8)) throw new Error(`"${tok}": ความยาว 0.5 ถึง 4 จังหวะ`);
  if(m[1]==="R" || m[1]==="-") return {k:-1, oct:0, hb};
  let k=NOTE_NAMES.indexOf(m[1].toUpperCase()), oct=m[3]!=null ? +m[3] : defOct;
  if(m[2]==="#") k++; else if(m[2]==="b") k--;
  if(k<0){ k+=12; oct--; } if(k>11){ k-=12; oct++; }
  if(!(oct>=0 && oct<=8)) throw new Error(`"${tok}": octave 0–8`);
  return {k, oct, hb};
}
const songNotes=p=>String(p.song).trim().split(/[\s,]+/).filter(Boolean).map(t=>noteParse(t, 4));

/* ---- ASCII parts (gate level, every row checked) ---- */
const ASCII_PRINT=c=>c>=32 && c<127;
Object.assign(PARTS, {
  ascii_case:{ label:"ASCII ตัวพิมพ์ใหญ่ ↔ เล็ก", group:"ASCII / ตัวอักษร",
    desc:"a = รหัส ASCII 7 บิต → y · upper = a–z เป็น A–Z (ลบ 0x20) · lower = A–Z เป็น a–z · swap = สลับทั้งคู่ · ตัวอื่นผ่านไปเหมือนเดิม — ต่างกันแค่บิต 5",
    params:{mode:{options:["upper","lower","swap"],def:"upper"}},
    ports:()=>({in:{a:7}, out:{y:7}}),
    ref:(v,p)=>{ const c=v.a, up=c>=65&&c<=90, lo=c>=97&&c<=122;
      return {y:(p.mode!=="lower"&&lo) ? c-32 : (p.mode!=="upper"&&up) ? c+32 : c}; },
    build:p=>ptFromTable("ascii_"+p.mode, bitNames("a",7), bitNames("y",7), v=>{ const y=PARTS.ascii_case.ref({a:ptGather(v,"a",7)}, p).y, o={};
      for(let i=0;i<7;i++) o["y"+i]=ptBits(y,i); return o; }) },
  hex_ascii:{ label:"ค่า 0–15 → ตัวอักษร ASCII ('0'–'9', 'A'–'F')", group:"ASCII / ตัวอักษร",
    desc:"v 4 บิต → ascii 8 บิต: 0–9 = 0x30–0x39, 10–15 = 'A'–'F' (0x41–0x46) หรือ 'a'–'f' ถ้า lower · ใช้ส่งเลขฐาน 16 ออก UART / แสดงบน LCD",
    params:{lower:{bool:true,def:false}},
    ports:()=>({in:{v:4}, out:{ascii:8}}),
    ref:(v,p)=>({ascii:v.v<10 ? 0x30+v.v : (p.lower?0x61:0x41)+v.v-10}),
    build:p=>ptFromTable("hex_ascii"+(p.lower?"_lower":""), bitNames("v",4), bitNames("ascii",8), v=>{ const a=PARTS.hex_ascii.ref({v:ptGather(v,"v",4)}, p).ascii, o={};
      for(let i=0;i<8;i++) o["ascii"+i]=ptBits(a,i); return o; }) },
  ascii_value:{ label:"ตัวอักษร ASCII → ค่า ('0'–'9' / 'A'–'F')", group:"ASCII / ตัวอักษร",
    desc:"ascii 8 บิต → v 4 บิต + valid · '0'–'9' = 0–9 · hex: 'A'–'F' และ 'a'–'f' = 10–15 · ตัวอื่น valid = 0, v = 0 — ใช้รับเลขจาก UART / คีย์บอร์ด",
    params:{hex:{bool:true,def:true}},
    ports:()=>({in:{ascii:8}, out:{v:4, valid:1}}),
    ref:(v,p)=>{ const c=v.ascii; let x=-1;
      if(c>=48&&c<=57) x=c-48; else if(p.hex && c>=65&&c<=70) x=c-55; else if(p.hex && c>=97&&c<=102) x=c-87;
      return {v:x<0?0:x, valid:x<0?0:1}; },
    build:p=>ptFromTable("ascii_value"+(p.hex?"_hex":""), bitNames("ascii",8), bitNames("v",4).concat(["valid"]), v=>{ const r=PARTS.ascii_value.ref({ascii:ptGather(v,"ascii",8)}, p), o={valid:r.valid};
      for(let i=0;i<4;i++) o["v"+i]=ptBits(r.v,i); return o; }) },
});
/* one note as gates: the library's divider at N = clk / f (50 MHz → C4 = ÷191 113), its own small-N check */
Object.assign(PARTS, {
  note_divider:{ label:"โน้ตจากตัวหารความถี่ (วงจรเกต)", group:"เสียง / โน้ตดนตรี",
    desc:"clk_in 50 MHz ÷ N → clk_out = ความถี่ของโน้ตที่เลือก (duty 50 %) ต่อ buzzer ได้เลย · N = 50 000 000 / f ปัดเป็นคู่ · เช่น A4 440 Hz = ÷113 636 · ไม่ใช้ VHDL",
    params:{note:{options:NOTE_NAMES, def:"A"}, octave:{min:0, max:8, def:4}, n:{min:0, max:2147483648, def:0, quiet:true, hide:true}},
    noteN:p=>2*Math.round(50e6/noteFreq(p.octave, NOTE_NAMES.indexOf(p.note))/2),
    plan:p=>{ const N=p.n||PARTS.note_divider.noteN(p), f=noteFreq(p.octave, NOTE_NAMES.indexOf(p.note));
      return `${p.note}${p.octave} ในตาราง ${f.toFixed(2)} Hz → ÷${N.toLocaleString("en")} = ${(50e6/N).toFixed(2)} Hz ที่ clk 50 MHz`; },
    ports:()=>({in:{clk_in:1}, out:{clk_out:1}}),
    build:p=>{ const r=dividerIntent(p.n||PARTS.note_divider.noteN(p)); if(r.error) throw new Error(r.error); r.module="note_"+p.note.replace("#","s")+p.octave; return r; },
    seq:p=>{ const S=PARTS.clock_divider.seq({n:p.n||PARTS.note_divider.noteN(p)}); if(S.small) S.small={n:S.small}; return S; } },
});
LIB_CATS.forEach(c=>{ if(c.id==="conv") c.kinds=c.kinds.filter(k=>k!=="bcd_ascii"); });
if(!LIB_CATS.some(c=>c.id==="ascii")) LIB_CATS.splice(LIB_CATS.findIndex(c=>c.id==="seg"), 0, {id:"ascii", icon:"A", label:"ASCII / ตัวอักษร", kinds:["ascii_case","hex_ascii","ascii_value","bcd_ascii"]});
if(!LIB_CATS.some(c=>c.id==="music")) LIB_CATS.splice(LIB_CATS.findIndex(c=>c.id==="dev"), 0, {id:"music", icon:"♪", label:"เสียง / โน้ตดนตรี", kinds:["note_divider"]});
Object.assign(LIB_SVG, {
  ascii:'<svg class="lib-svg" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13l3-10 3 10M3 10h4"/><path d="M10 4h4M12 4v9M10 13h4"/></svg>',
  music:'<svg class="lib-svg" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12V3l7-1.5V10.5"/><circle cx="4.3" cy="12.2" r="1.8"/><circle cx="11.3" cy="10.7" r="1.8"/></svg>' });

/* ---- VHDL: music ---- */
const vlRom=(name, W, vals)=>`  type ${name}_t is array (0 to ${vals.length-1}) of std_logic_vector(${W-1} downto 0);
  constant ${name} : ${name}_t := (
      ${vals.length===1 ? `0 => "${vlBin(vals[0],W)}"` : vals.map(v=>`"${vlBin(v,W)}"`).reduce((a,x,i)=>a+(i?(i%8?", ":",\n      "):"")+x, "")});`;
/* a half-period counter on the buzzer; `lim` = half-period − 1 or −1 for silent (a signal the block sets) */
const VL_TONE_PROC=W=>`  process(clk)
  begin
    if rising_edge(clk) then
      if quiet = '1' then
        cnt <= (others => '0');
        t   <= '0';
      elsif cnt >= lim then
        cnt <= (others => '0');
        t   <= not t;
      else
        cnt <= cnt + 1;
      end if;
    end if;
  end process;
  buzzer <= t;`;
/* measure a buzzer: the clocks between its toggles, per window */
function vlToggles(L, a, b){ const at=[]; for(let i=Math.max(1,a); i<b; i++) if(L[i]!==L[i-1]) at.push(i); return at; }
function vlHalfOf(L, a, b){ const at=vlToggles(L, a, b); if(at.length<3) return at.length ? -1 : 0;
  const d=at.slice(1).map((x,i)=>x-at[i]); return d.every(x=>x===d[0]) ? d[0] : -1; }
Object.assign(VLIB, {
  note_tone:{ label:"เล่นโน้ตจากสวิตช์ (VHDL)", cat:"music",
    desc:"note = 1–12 → C, C#, D, D#, E, F, F#, G, G#, A, A#, B (0 = เงียบ) · octave ตั้งไว้ หรือ oct_in = เลือกจากขา oct (0–8) · ความถี่ตามตาราง (A4 = 440 Hz) → buzzer ของบอร์ด EDGE",
    params:{octave:{label:"octave", min:0, max:8, def:4}, oct_in:{label:"เลือก octave จากขา oct", bool:true, def:false}, clk_hz:{label:"clk (Hz)", min:1000, max:200000000, def:50000000}},
    name:p=>p.oct_in?"note_tone_oct":"note_tone_o"+p.octave, board:true,
    plan:p=>p.oct_in ? "C0 = 16.35 Hz … B8 = 7902 Hz" : NOTE_NAMES.map((n,k)=>n+p.octave+" "+noteFreq(p.octave,k).toFixed(2)).join(" · "),
    vhdl:(p,E)=>{ const octs=p.oct_in?[0,1,2,3,4,5,6,7,8]:[p.octave], H=[]; octs.forEach(o=>{ for(let k=0;k<12;k++) H.push(noteHalf(p.clk_hz, noteFreq(o,k))-1); });
      const W=vlW(Math.max(...H)+1);
      return VL_HEAD+`-- ${E}: โน้ตจากสวิตช์ → buzzer (clk = ${p.clk_hz} Hz)
--   note = 1..12 → C C# D D# E F F# G G# A A# B, 0 หรือ 13..15 = เงียบ${p.oct_in?"\n--   oct = 0..8 (9..15 = เงียบ)":`\n--   octave ${p.octave}: `+NOTE_NAMES.map((n,k)=>n+" "+noteFreq(p.octave,k).toFixed(2)+" Hz").join(", ")}
--   ครึ่งคาบ = clk / (2 f) clock, ตาราง HALF เก็บค่านั้นลบ 1
entity ${E} is
  port ( clk    : in  std_logic;
         note   : in  std_logic_vector(3 downto 0);${p.oct_in?"\n         oct    : in  std_logic_vector(3 downto 0);":""}
         buzzer : out std_logic );
end ${E};

architecture rtl of ${E} is
${vlRom("HALF", W, H)}
  signal cnt   : unsigned(${W-1} downto 0) := (others => '0');
  signal lim   : unsigned(${W-1} downto 0);
  signal t     : std_logic := '0';
  signal quiet : std_logic;
begin
  process(note${p.oct_in?", oct":""})
    variable k : integer;
  begin
    k := to_integer(unsigned(note));
    if k >= 1 and k <= 12${p.oct_in?" and to_integer(unsigned(oct)) <= 8":""} then
      quiet <= '0';
      lim   <= unsigned(HALF(${p.oct_in?"to_integer(unsigned(oct)) * 12 + ":""}k - 1));
    else
      quiet <= '1';
      lim   <= (others => '0');
    end if;
  end process;

${VL_TONE_PROC(W)}
end rtl;
`; },
    pins:p=>{ const m={clk:"clk", buzzer:"buzzer"}; for(let i=0;i<4;i++) m[`note[${i}]`]="sw:"+i; if(p.oct_in) for(let i=0;i<4;i++) m[`oct[${i}]`]="sw:"+(4+i); return m; } },
  piano:{ label:"เปียโน 8 คีย์ (โด เร มี … โด) (VHDL)", cat:"music",
    desc:"key[0..7] = C D E F G A B C (octave ถัดไป) ของ octave ที่ตั้ง · กดหลายคีย์ = คีย์เลขน้อยดัง · ไม่กด = เงียบ · ต่อสวิตช์หรือปุ่ม → buzzer",
    params:{octave:{label:"octave", min:0, max:7, def:4}, clk_hz:{label:"clk (Hz)", min:1000, max:200000000, def:50000000}},
    name:p=>"piano_o"+p.octave, board:true,
    plan:p=>["C","D","E","F","G","A","B","C"].map((n,i)=>`key${i} = ${n}${p.octave+(i===7?1:0)}`).join(" · "),
    keys:p=>[0,2,4,5,7,9,11,12].map(s=>noteFreq(p.octave+(s>=12?1:0), s%12)),
    vhdl:(p,E)=>{ const F=VLIB.piano.keys(p), H=F.map(f=>noteHalf(p.clk_hz,f)-1), W=vlW(Math.max(...H)+1);
      return VL_HEAD+`-- ${E}: เปียโน 8 คีย์ → buzzer (clk = ${p.clk_hz} Hz)
--   ${F.map((f,i)=>`key${i} ${f.toFixed(2)} Hz`).join(", ")}
--   กดหลายคีย์ = คีย์เลขน้อยดัง
entity ${E} is
  port ( clk    : in  std_logic;
         key    : in  std_logic_vector(7 downto 0);
         buzzer : out std_logic );
end ${E};

architecture rtl of ${E} is
${vlRom("HALF", W, H)}
  signal cnt   : unsigned(${W-1} downto 0) := (others => '0');
  signal lim   : unsigned(${W-1} downto 0);
  signal t     : std_logic := '0';
  signal quiet : std_logic;
begin
  process(key)
  begin
    quiet <= '0';
${[0,1,2,3,4,5,6,7].map(i=>`    ${i?"elsif":"if"} key(${i}) = '1' then
      lim <= unsigned(HALF(${i}));`).join("\n")}
    else
      lim   <= (others => '0');
      quiet <= '1';
    end if;
  end process;

${VL_TONE_PROC(W)}
end rtl;
`; },
    pins:()=>{ const m={clk:"clk", buzzer:"buzzer"}; for(let i=0;i<8;i++) m[`key[${i}]`]="sw:"+i; return m; } },
  melody:{ label:"เล่นเพลงจากโน้ต (VHDL)", cat:"music",
    desc:"เขียนเพลงเป็นโน้ต เช่น \"C4 C4 G4 G4 A4 A4 G4:2\" (R = พัก, :2 = 2 จังหวะ, :0.5 = ครึ่งจังหวะ, # / b ได้) · bpm ตั้งได้ · en = 1 เล่น, 0 = หยุดและกลับต้นเพลง · loop = วนซ้ำ ไม่งั้น done = 1 เมื่อจบ · เว้นช่วงสั้น ๆ ท้ายทุกโน้ตให้ได้ยินโน้ตซ้ำ",
    params:{song:{label:"โน้ต", text:true, maxlen:400, def:"C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2"},
      bpm:{label:"ความเร็ว (bpm)", min:30, max:300, def:120}, loop:{label:"วนซ้ำ", bool:true, def:true}, clk_hz:{label:"clk (Hz)", min:1000, max:200000000, def:50000000}},
    check:p=>{ let N; try{ N=songNotes(p); }catch(e){ return e.message; } if(!N.length) return "ใส่โน้ตอย่างน้อย 1 ตัว"; if(N.length>128) return "ยาวได้ไม่เกิน 128 โน้ต"; return null; },
    name:p=>"melody", board:true,
    plan:p=>{ const N=songNotes(p), hb=N.reduce((s,n)=>s+n.hb,0); return `${N.length} โน้ต · ${hb/2} จังหวะ ≈ ${(hb/2*60/p.bpm).toFixed(1)} วินาที`; },
    vhdl:(p,E)=>{ const N=songNotes(p), HB=p.hb_clocks||Math.round(p.clk_hz*60/p.bpm/2), GAP=Math.max(1, Math.floor(HB/4));
      const H=N.map(n=>n.k<0 ? 0 : noteHalf(p.clk_hz, noteFreq(n.oct, n.k))), W=vlW(Math.max(1,...H)), DW=4, LAST=N.length-1, IW=vlW(LAST), CW=vlW(HB);
      return VL_HEAD+`-- ${E}: เล่นเพลงทาง buzzer (clk = ${p.clk_hz} Hz, ${p.bpm} bpm, ครึ่งจังหวะ = ${HB} clock)
--   ${N.map(n=>(n.k<0?"R":NOTE_NAMES[n.k]+n.oct)+(n.hb!==2?":"+n.hb/2:"")).join(" ")}
--   en = '1' เล่น, '0' หยุดและกลับต้นเพลง · ${p.loop?"จบแล้ววนใหม่":"จบแล้ว done = '1' และเงียบ"} · ${GAP} clock สุดท้ายของแต่ละโน้ตเงียบ
entity ${E} is
  port ( clk    : in  std_logic;
         en     : in  std_logic;
         buzzer : out std_logic;
         done   : out std_logic );
end ${E};

architecture rtl of ${E} is
${vlRom("HALF", W, H)}   -- ครึ่งคาบของแต่ละโน้ต (0 = พัก)
${vlRom("DUR", DW, N.map(n=>n.hb-1))}   -- ความยาว (ครึ่งจังหวะ) ลบ 1
  signal idx   : unsigned(${IW-1} downto 0) := (others => '0');
  signal dcnt  : unsigned(${CW-1} downto 0) := (others => '0');
  signal hb    : unsigned(${DW-1} downto 0) := (others => '0');
  signal fin   : std_logic := '0';
  signal cnt   : unsigned(${W-1} downto 0) := (others => '0');
  signal t     : std_logic := '0';
  signal hp    : unsigned(${W-1} downto 0);
  signal endn  : std_logic;
begin
  hp   <= unsigned(HALF(to_integer(idx)));
  endn <= '1' when hb = unsigned(DUR(to_integer(idx))) else '0';

  process(clk)
  begin
    if rising_edge(clk) then
      if en = '0' then
        idx <= (others => '0'); dcnt <= (others => '0'); hb <= (others => '0'); fin <= '0';
        cnt <= (others => '0'); t <= '0';
      else
        -- the tone: silent on a rest, after the end, and in the gap at the end of each note
        if hp = 0 or fin = '1' or (endn = '1' and dcnt >= ${HB-GAP}) then
          cnt <= (others => '0');
          t   <= '0';
        elsif cnt >= hp - 1 then
          cnt <= (others => '0');
          t   <= not t;
        else
          cnt <= cnt + 1;
        end if;
        -- the time: half-beats, then the next note
        if fin = '0' then
          if dcnt = ${HB-1} then
            dcnt <= (others => '0');
            if endn = '1' then
              hb  <= (others => '0');
              cnt <= (others => '0');
              t   <= '0';
              if idx = ${LAST} then
${p.loop?`                idx <= (others => '0');`:`                fin <= '1';`}
              else
                idx <= idx + 1;
              end if;
            else
              hb <= hb + 1;
            end if;
          else
            dcnt <= dcnt + 1;
          end if;
        end if;
      end if;
    end if;
  end process;
  buzzer <= t;
  done   <= fin;
end rtl;
`; },
    pins:()=>({clk:"clk", en:"sw:0", buzzer:"buzzer", done:"led:0"}) },

  /* ---- VHDL: ASCII ---- */
  ascii_7seg:{ label:"ตัวอักษร ASCII → 7-segment (VHDL)", cat:"ascii",
    desc:"code 8 บิต → seg (a = บิต 0 … g = บิต 6) · '0'–'9', 'A'–'Z' และ 'a'–'z' (ตามตารางตัวอักษรของวิชา), '-' '_' '=' ช่องว่าง · ตัวที่แสดงไม่ได้ = ดับ · active-low สำหรับบอร์ด EDGE (เป็นตารางใน VHDL — แบบเกตใช้ ~400 เกต)",
    params:{active_low:{label:"active-low (บอร์ด EDGE)", bool:true, def:true}},
    name:p=>"ascii_7seg"+(p.active_low?"":"_ah"), board:true,
    seg:(p, c)=>{ const s=c<128 ? (char7(String.fromCharCode(c))||"") : ""; let v=0; [..."abcdefg"].forEach((x,i)=>{ if(s.includes(x)) v|=1<<i; }); return p.active_low ? (~v)&127 : v; },
    vhdl:(p,E)=>VL_HEAD+`-- ${E}: ASCII → 7-segment (a = seg(0) … g = seg(6), ${p.active_low?"active-low: 0 = ติด":"active-high: 1 = ติด"})
--   0-9, A-Z, a-z (ตารางตัวอักษรของวิชา), '-' '_' '=' ช่องว่าง; ตัวอื่นดับ
entity ${E} is
  port ( code : in  std_logic_vector(7 downto 0);
         seg  : out std_logic_vector(6 downto 0) );
end ${E};

architecture rtl of ${E} is
${vlRom("SEGS", 7, Array.from({length:128},(_,c)=>VLIB.ascii_7seg.seg(p, c)))}
begin
  seg <= SEGS(to_integer(unsigned(code(6 downto 0)))) when code(7) = '0' else "${p.active_low?"1111111":"0000000"}";
end rtl;
`, ref:(v,p)=>({seg:VLIB.ascii_7seg.seg(p, v.code)}),
    pins:()=>{ const m={}; for(let i=0;i<7;i++) m[`seg[${i}]`]="seg:"+"abcdefg"[i]; for(let i=0;i<8;i++) m[`code[${i}]`]="sw:"+i; return m; } },
  lcd_ascii:{ label:"จอ LCD: ตัวอักษรจากรหัส ASCII (VHDL)", cat:"ascii",
    desc:"code 8 บิต (เช่นจากสวิตช์) → จอ LCD 16×2 · ในข้อความ @ = ตัวอักษรของ code, % = เลขฐาน 16 (ใส่ %% = 2 หลัก), # = เลขฐาน 10 (### = 3 หลัก), ~ = เลขฐาน 2 (8 ตัว = 8 บิต) · รหัสต่ำกว่า 0x20 แสดงเป็นช่องว่าง",
    params:{line1:{label:"บรรทัด 1", text:true, def:"CHAR: @"}, line2:{label:"บรรทัด 2", text:true, def:"HEX:%% DEC:###"},
      clk_hz:{label:"clk (Hz)", min:1000, max:200000000, def:50000000}},
    check:p=>{ for(const [k,t] of [["บรรทัด 1",p.line1],["บรรทัด 2",p.line2]]){ if(t.length>16) return `${k} ยาวเกิน 16 ตัว`;
        if(/[^\x20-\x7e]/.test(t)) return `${k}: จอ LCD แสดงได้แค่ตัวอังกฤษ ตัวเลข และเครื่องหมาย`; }
      const all=p.line1+p.line2, c=ch=>(all.match(new RegExp("\\"+ch,"g"))||[]).length;
      if(c("%")>2) return "% ได้ไม่เกิน 2 ตัว (8 บิต = 2 หลักฐาน 16)"; if(c("#")>3) return "# ได้ไม่เกิน 3 ตัว (0–255)"; if(c("~")>8) return "~ ได้ไม่เกิน 8 ตัว";
      return null; },
    name:()=>"lcd_ascii", board:true,
    // each special position → what it shows, digits counted from the right of their group (left = high)
    slots:p=>{ const all=(p.line1.padEnd(16," ")+p.line2.padEnd(16," ")), n={"%":0,"#":0,"~":0}, k={"%":0,"#":0,"~":0}, out=[];
      [...all].forEach(ch=>{ if(ch in n) n[ch]++; });
      [...all].forEach((ch,i)=>{ if(ch==="@") out.push({i, what:"char"}); else if(ch in n){ out.push({i, what:ch, pw:n[ch]-1-k[ch]}); k[ch]++; } });
      return out; },
    show:(p, code)=>{ const all=[...(p.line1.padEnd(16," ")+p.line2.padEnd(16," "))];
      VLIB.lcd_ascii.slots(p).forEach(s=>{ all[s.i] = s.what==="char" ? String.fromCharCode(code<32?32:code)
        : s.what==="%" ? ((code>>(4*s.pw))&15).toString(16).toUpperCase() : s.what==="#" ? String(Math.floor(code/10**s.pw)%10) : String((code>>s.pw)&1); });
      return [all.slice(0,16).join(""), all.slice(16).join("")]; },
    vhdl:(p,E)=>{
      const L1=p.line1.padEnd(16," "), L2=p.line2.padEnd(16," "), S=VLIB.lcd_ascii.slots(p);
      const STEP=Math.max(8, Math.round(p.clk_hz/4000)), LONG=Math.max(4*STEP, Math.round(p.clk_hz/500)), EON=Math.max(1, Math.round(p.clk_hz/1e6)), CW=vlW(LONG);
      const seq=[[0,0x38],[0,0x38],[0,0x38],[0,0x0C],[0,0x01],[0,0x06]], at=[];
      seq.push([0,0x80]); [...L1].forEach((ch,i)=>{ at[i]=seq.length; seq.push([1,ch.charCodeAt(0)]); });
      seq.push([0,0xC0]); [...L2].forEach((ch,i)=>{ at[16+i]=seq.length; seq.push([1,ch.charCodeAt(0)]); });
      const LAST=seq.length-1, LOOP=6, IW=vlW(LAST), rom=seq.map(([rs,d])=>`"${rs}${vlBin(d,8)}"`).join(",\n      ");
      const expr=s=>s.what==="char" ? "ch"
        : s.what==="%" ? `hx${s.pw}`
        : s.what==="#" ? `std_logic_vector(resize(${vlDigitsVhdl(0, s.pw, "n")}, 8) + 48)`
        : `"0011000" & c(${s.pw})`;
      return VL_HEAD+`-- ${E}: จอ LCD 16x2 แสดงตัวอักษรของ code (ASCII) — เขียนทั้งจอซ้ำทุก ~8.5 ms
--   บรรทัด 1: "${L1}"   บรรทัด 2: "${L2}"
--   @ = ตัวอักษร, % = เลขฐาน 16, # = เลขฐาน 10, ~ = เลขฐาน 2 (clk = ${p.clk_hz} Hz)
entity ${E} is
  port ( clk      : in  std_logic;
         code     : in  std_logic_vector(7 downto 0);
         lcd_data : out std_logic_vector(7 downto 0);
         lcd_rs   : out std_logic;
         lcd_e    : out std_logic );
end ${E};

architecture rtl of ${E} is
  type rom_t is array (0 to ${LAST}) of std_logic_vector(8 downto 0);
  constant ROM : rom_t := (
      ${rom});
  signal cnt  : unsigned(${CW-1} downto 0) := (others => '0');
  signal idx  : unsigned(${IW-1} downto 0) := (others => '0');
  signal boot : unsigned(3 downto 0) := (others => '0');
  signal cur  : std_logic_vector(8 downto 0);
  signal c    : std_logic_vector(7 downto 0);
  signal n    : unsigned(7 downto 0);
  signal ch   : std_logic_vector(7 downto 0);
  signal hx0  : std_logic_vector(7 downto 0);
  signal hx1  : std_logic_vector(7 downto 0);
begin
  process(clk)
  begin
    if rising_edge(clk) then
      if (idx < ${LOOP} and cnt = ${LONG-1}) or (idx >= ${LOOP} and cnt = ${STEP-1}) then
        cnt <= (others => '0');
        if boot < 10 then
          boot <= boot + 1;
        elsif idx = ${LAST} then
          idx <= to_unsigned(${LOOP}, ${IW});
        else
          idx <= idx + 1;
        end if;
      else
        cnt <= cnt + 1;
      end if;
    end if;
  end process;

  cur    <= ROM(to_integer(idx));
  lcd_rs <= cur(8);
  lcd_e  <= '1' when boot = 10 and cnt >= ${EON} and cnt < ${3*EON} else '0';
  c      <= code;
  n      <= unsigned(code);
  ch     <= code when unsigned(code) >= 32 else x"20";
  -- a hex digit as its character: 0-9 → '0'-'9' (+48), A-F → 'A'-'F' (+55)
  hx0    <= std_logic_vector(resize(unsigned(code(3 downto 0)), 8) + 48) when unsigned(code(3 downto 0)) < 10
            else std_logic_vector(resize(unsigned(code(3 downto 0)), 8) + 55);
  hx1    <= std_logic_vector(resize(unsigned(code(7 downto 4)), 8) + 48) when unsigned(code(7 downto 4)) < 10
            else std_logic_vector(resize(unsigned(code(7 downto 4)), 8) + 55);
  process(idx, cur, c, n, ch, hx0, hx1)
  begin
${S.map((s,j)=>`    ${j?"elsif":"if"} idx = ${at[s.i]} then
      lcd_data <= ${expr(s)};`).join("\n")}${S.length?"\n    else\n  ":""}    lcd_data <= cur(7 downto 0);
${S.length?"    end if;\n":""}  end process;
end rtl;
`; },
    pins:()=>{ const m={clk:"clk", lcd_rs:"lcd:rs", lcd_e:"lcd:e"}; for(let i=0;i<8;i++){ m[`lcd_data[${i}]`]="lcd:d"+i; m[`code[${i}]`]="sw:"+i; } return m; } },
  uart_text:{ label:"ส่งข้อความออก UART (VHDL)", cat:"ascii",
    desc:"กด start (ขอบขาขึ้น) → ส่งข้อความทีละตัว (ASCII, 8N1) ไปที่คอม · ต่อท้ายด้วยขึ้นบรรทัดใหม่ (CR LF) ได้ · busy = 1 ระหว่างส่ง · ดูในโปรแกรม serial terminal ที่ baud เดียวกัน",
    params:{text:{label:"ข้อความ", text:true, maxlen:48, def:"HELLO FPGA"}, crlf:{label:"ขึ้นบรรทัดใหม่ท้ายข้อความ", bool:true, def:true},
      baud:{label:"baud", options:[9600,19200,57600,115200], def:115200}, clk_hz:{label:"clk (Hz)", min:10000, max:200000000, def:50000000}},
    check:p=>!p.text.length ? "ใส่ข้อความ" : /[^\x20-\x7e]/.test(p.text) ? "ข้อความเป็น ASCII (อังกฤษ ตัวเลข เครื่องหมาย) เท่านั้น" : null,
    name:p=>"uart_text_"+p.baud, board:true,
    bytes:p=>vlAscii(p.text).concat(p.crlf?[13,10]:[]),
    vhdl:(p,E)=>{ const B=VLIB.uart_text.bytes(p), BIT=Math.max(2, Math.round(p.clk_hz/p.baud)), BW=vlW(BIT), LAST=B.length-1, IW=vlW(LAST);
      return VL_HEAD+`-- ${E}: กด start → ส่ง "${p.text.replace(/"/g,"'")}"${p.crlf?" + CR LF":""} ทาง UART 8N1 ${p.baud} baud (clk = ${p.clk_hz} Hz, ${BIT} clock ต่อบิต)
entity ${E} is
  port ( clk   : in  std_logic;
         start : in  std_logic;
         tx    : out std_logic;
         busy  : out std_logic );
end ${E};

architecture rtl of ${E} is
${vlRom("MSG", 8, B)}
  signal cnt   : unsigned(${BW-1} downto 0) := (others => '0');
  signal bit_n : unsigned(3 downto 0) := (others => '0');
  signal idx   : unsigned(${IW-1} downto 0) := (others => '0');
  signal sh    : std_logic_vector(9 downto 0) := (others => '1');
  signal bz    : std_logic := '0';
  signal prev  : std_logic := '0';
begin
  process(clk)
  begin
    if rising_edge(clk) then
      prev <= start;
      if bz = '0' then
        if start = '1' and prev = '0' then
          sh    <= '1' & MSG(0) & '0';
          idx   <= (others => '0');
          bz    <= '1';
          cnt   <= (others => '0');
          bit_n <= (others => '0');
        end if;
      elsif cnt = ${BIT-1} then
        cnt <= (others => '0');
        if bit_n = 9 then
          bit_n <= (others => '0');
          if idx = ${LAST} then
            bz <= '0';
            sh <= (others => '1');
          else
            idx <= idx + 1;
            sh  <= '1' & MSG(to_integer(idx) + 1) & '0';
          end if;
        else
          bit_n <= bit_n + 1;
          sh    <= '1' & sh(9 downto 1);
        end if;
      else
        cnt <= cnt + 1;
      end if;
    end if;
  end process;
  tx   <= sh(0) when bz = '1' else '1';
  busy <= bz;
end rtl;
`; },
    pins:()=>({clk:"clk", start:"pb:4", tx:"uart:txd", busy:"led:0"}) },
});

/* ---- the checks ---- */
Object.assign(VL_SEQCHECK, {
  note_tone:p=>{ const C=8*noteFreq(p.oct_in?8:p.octave, 11)*2, q=Object.assign({}, p, {clk_hz:Math.ceil(C)}), M=vhCompile(vlText("note_tone", q, "chk"));
    const cases=p.oct_in ? [[0,1],[4,10],[8,12],[3,0],[9,5],[5,7]] : [[p.octave,1],[p.octave,10],[p.octave,12],[p.octave,0],[p.octave,13],[p.octave,8]];
    for(const [o,k] of cases){
      const want=(k>=1&&k<=12&&o<=8) ? noteHalf(q.clk_hz, noteFreq(o,k-1)) : 0, L=[]; let st=vhInitState(M);
      const ins=Object.assign({note:k}, p.oct_in?{oct:o}:{});
      vlRunClock(M, st, ins, Math.max(40, want*8), s=>{ L.push(vlOut(M,s,"buzzer")); });
      const got=vlHalfOf(L, 0, L.length);
      if(got!==want) return {pass:false, why:`note ${k}${p.oct_in?` oct ${o}`:""}: ครึ่งคาบ ${got} clock ควรเป็น ${want} (clk ${q.clk_hz} Hz)`}; }
    return {pass:true, how:`วัดครึ่งคาบ buzzer ${cases.length} กรณี (รวมเงียบ) ตรงกับ clk / (2f) ของตารางโน้ต`}; },
  piano:p=>{ const F=VLIB.piano.keys(p), q=Object.assign({}, p, {clk_hz:Math.ceil(16*F[7])}), M=vhCompile(vlText("piano", q, "chk"));
    const H=F.map(f=>noteHalf(q.clk_hz,f));
    for(const [key,want] of [[1,H[0]],[4,H[2]],[128,H[7]],[0,0],[0b10100000,H[5]],[0b01000010,H[1]]]){
      const L=[]; vlRunClock(M, vhInitState(M), {key}, Math.max(40, (want||10)*8), s=>{ L.push(vlOut(M,s,"buzzer")); });
      const got=vlHalfOf(L, 0, L.length); if(got!==want) return {pass:false, why:`key ${vlBin(key,8)}: ครึ่งคาบ ${got} ควรเป็น ${want}`}; }
    return {pass:true, how:"วัดครึ่งคาบ buzzer: คีย์เดียว, หลายคีย์ (เลขน้อยดัง), ไม่กด = เงียบ"}; },
  melody:p=>{ const N=songNotes(p).slice(0, 48), fmax=Math.max(1,...N.filter(n=>n.k>=0).map(n=>noteFreq(n.oct,n.k)));
    const clk=Math.ceil(fmax*8), q=Object.assign({}, p, {clk_hz:clk, hb_clocks:0}), H=N.map(n=>n.k<0?0:noteHalf(clk, noteFreq(n.oct,n.k)));
    const hbc=Math.max(64, 6*Math.max(...H)); q.hb_clocks=hbc; q.song=N.map(n=>(n.k<0?"R":NOTE_NAMES[n.k]+n.oct)+":"+n.hb/2).join(" ");
    const M=vhCompile(vlText("melody", q, "chk")), total=N.reduce((s,n)=>s+n.hb,0)*hbc, L=[], D=[];
    vlRunClock(M, vhInitState(M), {en:1}, total+hbc*3, s=>{ L.push(vlOut(M,s,"buzzer")); D.push(vlOut(M,s,"done")); });
    let at=0;
    for(let i=0;i<N.length;i++){ const len=N[i].hb*hbc, gap=Math.floor(hbc/4);
      const got=vlHalfOf(L, at+2, at+len-gap), want=H[i];
      if(got!==want) return {pass:false, why:`โน้ตที่ ${i+1}: ครึ่งคาบ ${got} clock ควรเป็น ${want}`};
      if(vlToggles(L, at+len-gap+2, at+len).length) return {pass:false, why:`โน้ตที่ ${i+1}: ช่วงเว้นท้ายโน้ตมีเสียง`};
      at+=len; }
    const after=vlToggles(L, at+2, at+hbc*2).length;
    if(p.loop ? (H[0] && !after) : (after || D[at+2]!==1)) return {pass:false, why:p.loop?"จบเพลงแล้วไม่วนกลับ":"จบเพลงแล้วยังมีเสียง หรือ done ไม่เป็น 1"};
    return {pass:true, how:`จำลองทั้งเพลง ${N.length} โน้ต: ครึ่งคาบทุกโน้ต, ความยาว, ช่วงเว้น และ${p.loop?"วนกลับต้นเพลง":"หยุด + done"} ถูกต้อง`}; },
  lcd_ascii:p=>{ const q=Object.assign({}, p, {clk_hz:16000}), M=vhCompile(vlText("lcd_ascii", q, "chk")), STEP=8, LONG=32;
    for(const code of [0x41, 0x7A, 0x30, 0x0A, 0xFF]){
      const screen=[[..." ".repeat(16)],[..." ".repeat(16)]], frames=[]; let addr=0, lastE=0;
      vlRunClock(M, vhInitState(M), {code}, 16*LONG+4*34*STEP+50, s=>{ const e=vlOut(M,s,"lcd_e");
        if(lastE===1 && e===0){ const rs=vlOut(M,s,"lcd_rs"), d=vlOut(M,s,"lcd_data");
          if(rs===0){ if(d===0x80) frames.push(screen.map(r=>r.join(""))); if(d&0x80) addr=d&0x7F; }
          else { const row=addr>=0x40?1:0, col=addr&0x3F; if(col<16) screen[row][col]=String.fromCharCode(d); addr++; } }
        lastE=e; return frames.length<3; });
      const got=frames[2]||["",""], want=VLIB.lcd_ascii.show(p, code);
      if(got[0]!==want[0] || got[1]!==want[1]) return {pass:false, why:`code 0x${code.toString(16)}: จอแสดง "${got[0]}" / "${got[1]}" ควรเป็น "${want[0]}" / "${want[1]}"`}; }
    return {pass:true, how:"ถอดสิ่งที่เขียนลงจอ 5 รหัส (A, z, 0, 0x0A, 0xFF) ตรงทุกตัว"}; },
  uart_text:p=>{ const q=Object.assign({}, p, {clk_hz:p.baud*4}), M=vhCompile(vlText("uart_text", q, "chk")), B=VLIB.uart_text.bytes(p), line=[];
    let st=vlRunClock(M, vhInitState(M), {start:0}, 3, null);
    st=vlRunClock(M, st, {start:1}, 1, s=>{ line.push(vlOut(M,s,"tx")); });
    vlRunClock(M, st, {start:1}, B.length*40+20, s=>{ line.push(vlOut(M,s,"tx")); });     // held: sends once
    // decode 8N1 at 4 clocks a bit: find each start bit's fall, sample the middle of every bit
    line.unshift(1); const got=[]; for(let i=1;i<line.length;){ if(line[i-1]===1 && line[i]===0){ let b=0; for(let k=0;k<8;k++) b|=line[i+1+4*(k+1)]<<k;
        if(line[i+1+36]!==1) return {pass:false, why:`ตัวที่ ${got.length+1}: ไม่มี stop bit`}; got.push(b); i+=38; } else i++; }
    if(got.join()!==B.join()) return {pass:false, why:`ส่งได้ ${got.map(x=>x.toString(16)).join(" ")} ควรเป็น ${B.map(x=>x.toString(16)).join(" ")}`};
    return {pass:true, how:`ถอดสาย tx: ${B.length} ตัว (8N1) ตรงข้อความ และกดค้างส่งครั้งเดียว`}; },
});
