/* ===== 66. Ready-made VHDL blocks: arithmetic, numbers on the displays, the EDGE board's devices ======
   "ทำชุดสำหรับบล็อก VHDL ที่อาจจะเจอ เช่น ADC จอ LCD การแสดงคำ แสดงค่า … อยากได้วงจรทางคณิตด้วย + - * %":
   each entry writes the VHDL text from a few settings (width, text, channel, clock), the block is saved like one
   the user wrote (57) and CHECKED before it is handed over: the arithmetic on vectors against JavaScript, the
   number → digits blocks on every / sampled value, the LCD driver by decoding what it writes on each fall of E,
   the ADC reader against a model of the MCP3208 on its SPI pins. Shown in the library window (64) in their
   categories; "เปิดเป็นแผ่นใหม่" wraps the block in a sheet with a port per pin and maps the EDGE pins.
   Also: Tools ▸ ตัวสร้างวงจร keeps only the library entry — the generators are cards in the window ("เครื่องมือ"). */

const VL_HEAD="library ieee;\nuse ieee.std_logic_1164.all;\nuse ieee.numeric_std.all;\n\n";
const vlW=n=>Math.max(1, Math.ceil(Math.log2(Math.max(2, n+1))));            // bits for 0 … n
const vlBin=(v,w)=>(v>>>0).toString(2).padStart(w,"0").slice(-w);
const vlAscii=t=>[...String(t)].map(ch=>ch.charCodeAt(0));
const SEG_AL=[0x40,0x79,0x24,0x30,0x19,0x12,0x02,0x78,0x00,0x10];              // 0–9, bit0 = a … bit6 = g, active-low
/* a number's decimal digits, as the VHDL computes them: (n / 10^k) mod 10 */
function vlDigitsVhdl(n, k, vname){ return k===0 ? `${vname} mod 10` : `(${vname} / ${10**k}) mod 10`; }

const VLIB={
  add:{ label:"บวก a + b (VHDL)", cat:"arith", desc:"s = a + b แบบไม่มีเครื่องหมาย — s กว้างกว่า a, b หนึ่งบิต (บิตทด)",
    params:{n:{label:"จำนวนบิต", min:1, max:16, def:8}},
    name:p=>"add"+p.n,
    vhdl:(p,E)=>VL_HEAD+`-- ${E}: s = a + b  (${p.n} บิต, s มีบิตทดเพิ่ม 1 บิต)
entity ${E} is
  port ( a : in  std_logic_vector(${p.n-1} downto 0);
         b : in  std_logic_vector(${p.n-1} downto 0);
         s : out std_logic_vector(${p.n} downto 0) );
end ${E};

architecture rtl of ${E} is
begin
  s <= std_logic_vector(resize(unsigned(a), ${p.n+1}) + resize(unsigned(b), ${p.n+1}));
end rtl;
`, ref:(v,p)=>({s:v.a+v.b}) },
  sub:{ label:"ลบ a − b (VHDL)", cat:"arith", desc:"d = a − b (วนรอบแบบ n บิต) · neg = 1 เมื่อ a < b (ผลติดลบ)",
    params:{n:{label:"จำนวนบิต", min:1, max:16, def:8}},
    name:p=>"sub"+p.n,
    vhdl:(p,E)=>VL_HEAD+`-- ${E}: d = a - b, neg = '1' เมื่อ a < b
entity ${E} is
  port ( a   : in  std_logic_vector(${p.n-1} downto 0);
         b   : in  std_logic_vector(${p.n-1} downto 0);
         d   : out std_logic_vector(${p.n-1} downto 0);
         neg : out std_logic );
end ${E};

architecture rtl of ${E} is
begin
  d   <= std_logic_vector(unsigned(a) - unsigned(b));
  neg <= '1' when unsigned(a) < unsigned(b) else '0';
end rtl;
`, ref:(v,p)=>({d:(v.a-v.b+(1<<p.n))%(1<<p.n), neg:v.a<v.b?1:0}) },
  mul:{ label:"คูณ a × b (VHDL)", cat:"arith", desc:"p = a × b · p กว้างเป็นสองเท่าของ a, b",
    params:{n:{label:"จำนวนบิต", min:1, max:16, def:8}},
    name:p=>"mul"+p.n,
    vhdl:(p,E)=>VL_HEAD+`-- ${E}: p = a * b
entity ${E} is
  port ( a : in  std_logic_vector(${p.n-1} downto 0);
         b : in  std_logic_vector(${p.n-1} downto 0);
         p : out std_logic_vector(${2*p.n-1} downto 0) );
end ${E};

architecture rtl of ${E} is
begin
  p <= std_logic_vector(unsigned(a) * unsigned(b));
end rtl;
`, ref:(v)=>({p:v.a*v.b}) },
  divmod:{ label:"หาร a ÷ b และเศษ a % b (VHDL)", cat:"arith", desc:"q = a / b (ปัดทิ้ง), r = a mod b (เศษ, %) · b = 0 → q เป็น 1 ทุกบิต, r = a, err = 1",
    params:{n:{label:"จำนวนบิต", min:1, max:16, def:8}},
    name:p=>"divmod"+p.n,
    vhdl:(p,E)=>VL_HEAD+`-- ${E}: q = a / b, r = a mod b  (หารด้วย 0: err = '1')
entity ${E} is
  port ( a   : in  std_logic_vector(${p.n-1} downto 0);
         b   : in  std_logic_vector(${p.n-1} downto 0);
         q   : out std_logic_vector(${p.n-1} downto 0);
         r   : out std_logic_vector(${p.n-1} downto 0);
         err : out std_logic );
end ${E};

architecture rtl of ${E} is
begin
  process(a, b)
  begin
    if unsigned(b) = 0 then
      q   <= (others => '1');
      r   <= a;
      err <= '1';
    else
      q   <= std_logic_vector(unsigned(a) / unsigned(b));
      r   <= std_logic_vector(unsigned(a) mod unsigned(b));
      err <= '0';
    end if;
  end process;
end rtl;
`, ref:(v,p)=>v.b===0 ? {q:(1<<p.n)-1, r:v.a, err:1} : {q:Math.floor(v.a/v.b), r:v.a%v.b, err:0} },
  bin2dec:{ label:"เลขฐานสอง → หลักฐานสิบ (VHDL)", cat:"conv", desc:"value → d0 (หลักหน่วย) … ทีละ 4 บิต (BCD) ด้วย / 10 และ mod 10 — ไว้ส่งต่อให้จอ 7-seg หรือ LCD",
    params:{digits:{label:"จำนวนหลัก", min:1, max:5, def:4}},
    name:p=>"bin2dec"+p.digits,
    vhdl:(p,E)=>{ const W=vlW(10**p.digits-1);
      return VL_HEAD+`-- ${E}: value (0 … ${10**p.digits-1}) → BCD digits, d0 = หลักหน่วย
entity ${E} is
  port ( value : in  std_logic_vector(${W-1} downto 0);
${Array.from({length:p.digits},(_,k)=>`         d${k}    : out std_logic_vector(3 downto 0)`).join(";\n")} );
end ${E};

architecture rtl of ${E} is
  signal n : unsigned(${W-1} downto 0);
begin
  n <= unsigned(value);
${Array.from({length:p.digits},(_,k)=>`  d${k} <= std_logic_vector(resize(${vlDigitsVhdl(0,k,"n")}, 4));`).join("\n")}
end rtl;
`; }, ref:(v,p)=>{ const o={}; for(let k=0;k<p.digits;k++) o["d"+k]=Math.floor(v.value/10**k)%10; return o; },
    inRange:(v,p)=>v.value<10**p.digits },

  seg7_num:{ label:"แสดงตัวเลขบน 7-seg 4 หลัก (VHDL)", cat:"seg", desc:"value (0–9999) แสดงบนจอ 7-seg 4 หลักของบอร์ด EDGE: สแกนเองจาก clk 50 MHz, seg / an active-low · ดับเลข 0 นำหน้าได้",
    params:{blank:{label:"ดับเลข 0 นำหน้า", bool:true, def:true}, clk_hz:{label:"clk (Hz)", min:1000, max:200000000, def:50000000}},
    name:p=>"seg7_num"+(p.blank?"_b":""), board:true,
    vhdl:(p,E)=>{ const SCAN=Math.max(1, Math.round(p.clk_hz/1000)), CW=vlW(SCAN);
      const rom=SEG_AL.map(x=>`"${vlBin(x,7)}"`).join(", ");
      return VL_HEAD+`-- ${E}: value (0-9999) บนจอ 7-seg 4 หลัก (บอร์ด EDGE: seg / an active-low)
--   seg(0) = a … seg(6) = g · an(0) = หลักขวาสุด · สลับหลักทุก 1 ms (clk = ${p.clk_hz} Hz)
entity ${E} is
  port ( clk   : in  std_logic;
         value : in  std_logic_vector(13 downto 0);
         seg   : out std_logic_vector(6 downto 0);
         an    : out std_logic_vector(3 downto 0) );
end ${E};

architecture rtl of ${E} is
  type rom_t is array (0 to 9) of std_logic_vector(6 downto 0);
  constant SEGS : rom_t := (${rom});
  signal cnt : unsigned(${CW-1} downto 0) := (others => '0');
  signal dig : unsigned(1 downto 0) := (others => '0');
  signal n   : unsigned(13 downto 0);
  signal d   : unsigned(13 downto 0);
begin
  process(clk)
  begin
    if rising_edge(clk) then
      if cnt = ${SCAN-1} then
        cnt <= (others => '0');
        dig <= dig + 1;
      else
        cnt <= cnt + 1;
      end if;
    end if;
  end process;

  n <= unsigned(value);
  process(dig, n)
  begin
    case dig is
      when "00"   => d <= ${vlDigitsVhdl(0,0,"n")};  an <= "1110";
      when "01"   => d <= ${vlDigitsVhdl(0,1,"n")};  an <= "1101";
      when "10"   => d <= ${vlDigitsVhdl(0,2,"n")};  an <= "1011";
      when others => d <= ${vlDigitsVhdl(0,3,"n")};  an <= "0111";
    end case;
  end process;

  process(dig, n, d)
  begin
    if d > 9 then
      seg <= "0111111";                          -- เกิน 9999: ขีดกลาง
${p.blank?`    elsif (dig = "11" and n < 1000) or (dig = "10" and n < 100) or (dig = "01" and n < 10) then
      seg <= "1111111";                          -- ดับเลข 0 นำหน้า
`:""}    else
      seg <= SEGS(to_integer(d));
    end if;
  end process;
end rtl;
`; },
    pins:()=>{ const m={clk:"clk"}; for(let i=0;i<7;i++) m[`seg[${i}]`]="seg:"+"abcdefg"[i]; for(let i=0;i<4;i++) m[`an[${i}]`]="an:"+i; return m; } },

  lcd16x2:{ label:"จอ LCD 16×2: ข้อความ + ตัวเลข (VHDL)", cat:"dev", desc:"เขียน 2 บรรทัดบนจอ LCD ของบอร์ด EDGE (HD44780, 8 บิต) วนซ้ำทุก ~80 ms · ใส่ # ในข้อความ = หลักของตัวเลขจากขา value (เช่น \"LIGHT: ####\") — แลป 8",
    params:{line1:{label:"บรรทัด 1", text:true, def:"FPGA EDGE"}, line2:{label:"บรรทัด 2 (# = หลักตัวเลข)", text:true, def:"VALUE: ####"},
      clk_hz:{label:"clk (Hz)", min:1000, max:200000000, def:50000000}},
    check:p=>{ for(const [k,t] of [["บรรทัด 1",p.line1],["บรรทัด 2",p.line2]]){
        if(t.length>16) return `${k} ยาวเกิน 16 ตัว`;
        if(/[^\x20-\x7e]/.test(t)) return `${k}: จอ LCD แสดงได้แค่ตัวอังกฤษ ตัวเลข และเครื่องหมาย (ไม่มีภาษาไทย)`; }
      const h=(p.line1+p.line2).match(/#/g)||[]; if(h.length>5) return "ใส่ # ได้ไม่เกิน 5 หลัก"; return null; },
    name:p=>"lcd16x2_"+(((p.line1+p.line2).match(/#/g)||[]).length?"num":"text"), board:true,
    plan:p=>{ const k=((p.line1+p.line2).match(/#/g)||[]).length; return k ? `ขา value ${vlW(10**k-1)} บิต (0–${10**k-1}) แสดงแทน # ${k} หลัก` : "ข้อความคงที่ (ไม่มี # = ไม่มีขา value)"; },
    vhdl:(p,E)=>{
      const L1=p.line1.padEnd(16," "), L2=p.line2.padEnd(16," "), text=L1+L2;
      const nd=(text.match(/#/g)||[]).length, W=nd?vlW(10**nd-1):0;
      const STEP=Math.max(8, Math.round(p.clk_hz/500)), EON=Math.max(1, Math.round(p.clk_hz/1e6)), CW=vlW(STEP);
      // the write sequence: rs & data — function set ×3, display on, clear, entry mode, line 1, 16 chars, line 2, 16 chars
      const seq=[[0,0x38],[0,0x38],[0,0x38],[0,0x0C],[0,0x01],[0,0x06],[0,0x80]];
      const pos=[]; let k=nd;
      [...L1].forEach(ch=>{ if(ch==="#"){ pos.push({at:seq.length, pw:--k}); seq.push([1,0x30]); } else seq.push([1,ch.charCodeAt(0)]); });
      seq.push([0,0xC0]);
      [...L2].forEach(ch=>{ if(ch==="#"){ pos.push({at:seq.length, pw:--k}); seq.push([1,0x30]); } else seq.push([1,ch.charCodeAt(0)]); });
      const LAST=seq.length-1, LOOP=6, IW=vlW(LAST);
      const rom=seq.map(([rs,d],i)=>`"${rs}${vlBin(d,8)}"`).join(",\n      ");
      return VL_HEAD+`-- ${E}: จอ LCD 16x2 (HD44780, 8 บิต, R/W ต่อกราวด์บนบอร์ด) — เขียนข้อความวนซ้ำ
--   บรรทัด 1: "${L1}"
--   บรรทัด 2: "${L2}"${nd?`\n--   # = หลักของ value (หลักซ้าย = หลักสูง)`:""}
--   เขียน 1 ตัวทุก 2 ms, E สูงช่วง 1–3 us ของแต่ละตัว (clk = ${p.clk_hz} Hz), รอเปิดเครื่อง 20 ms
entity ${E} is
  port ( clk      : in  std_logic;${nd?`\n         value    : in  std_logic_vector(${W-1} downto 0);`:""}
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
  signal cur  : std_logic_vector(8 downto 0);${nd?`\n  signal n    : unsigned(${W-1} downto 0);`:""}
begin
  process(clk)
  begin
    if rising_edge(clk) then
      if cnt = ${STEP-1} then
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
${nd?`  n <= unsigned(value);
  process(idx, cur, n)
  begin
${pos.map((q,i)=>`    ${i?"elsif":"if"} idx = ${q.at} then
      lcd_data <= std_logic_vector(resize(${vlDigitsVhdl(0,q.pw,"n")}, 8) + 48);`).join("\n")}
    else
      lcd_data <= cur(7 downto 0);
    end if;
  end process;`:`  lcd_data <= cur(7 downto 0);`}
end rtl;
`; },
    pins:()=>{ const m={clk:"clk", lcd_rs:"lcd:rs", lcd_e:"lcd:e"}; for(let i=0;i<8;i++) m[`lcd_data[${i}]`]="lcd:d"+i; return m; } },

  adc_mcp3208:{ label:"อ่าน ADC MCP3208 (SPI) (VHDL)", cat:"dev", desc:"อ่านค่า 12 บิต (0–4095) จากช่อง ch ของ MCP3208 บนบอร์ด EDGE ซ้ำไปเรื่อย ๆ · done = 1 หนึ่ง clock ทุกครั้งที่ได้ค่าใหม่ · SCK 500 kHz — แลป 8 (LDR ช่อง 6)",
    params:{ch:{label:"ช่อง (0–7)", min:0, max:7, def:6}, clk_hz:{label:"clk (Hz)", min:2000000, max:200000000, def:50000000}},
    name:p=>"adc_mcp3208_ch"+p.ch, board:true,
    vhdl:(p,E)=>{ const HALF=Math.max(1, Math.round(p.clk_hz/1e6)), HW=vlW(HALF);
      const cmd="11"+vlBin(p.ch,3);
      return VL_HEAD+`-- ${E}: อ่าน MCP3208 ช่อง ${p.ch} (single-ended) ทาง SPI ซ้ำไปเรื่อย ๆ
--   ส่ง start, SGL, D2, D1, D0 = "${cmd}" ทาง adc_din ที่ขอบขาขึ้นที่ 1–5 ของ SCK,
--   ขอบที่ 6 = sample, 7 = null bit, อ่าน B11 … B0 จาก adc_dout ที่ขอบขาขึ้นที่ 8 … 19 แล้วยก CS
--   SCK = clk / ${2*HALF} (clk = ${p.clk_hz} Hz)
entity ${E} is
  port ( clk      : in  std_logic;
         adc_dout : in  std_logic;
         adc_sck  : out std_logic;
         adc_cs   : out std_logic;
         adc_din  : out std_logic;
         value    : out std_logic_vector(11 downto 0);
         done     : out std_logic );
end ${E};

architecture rtl of ${E} is
  constant CMD : std_logic_vector(4 downto 0) := "${cmd}";
  signal div   : unsigned(${HW-1} downto 0) := (others => '0');
  signal sck_i : std_logic := '0';
  signal cs_i  : std_logic := '1';
  signal din_i : std_logic := '0';
  signal n     : unsigned(4 downto 0) := (others => '0');
  signal sh    : std_logic_vector(11 downto 0) := (others => '0');
  signal val   : std_logic_vector(11 downto 0) := (others => '0');
  signal dn    : std_logic := '0';
begin
  process(clk)
  begin
    if rising_edge(clk) then
      dn <= '0';
      if div = ${HALF-1} then
        div <= (others => '0');
        if cs_i = '1' then                     -- เริ่มอ่านรอบใหม่: CS ลง, บิตแรก (start) รอที่ DIN
          cs_i  <= '0';
          sck_i <= '0';
          n     <= (others => '0');
          din_i <= CMD(4);
        elsif sck_i = '0' then                 -- ขอบขาขึ้นของ SCK
          sck_i <= '1';
          n     <= n + 1;
          if n >= 7 and n <= 18 then           -- ขอบที่ 8 … 19: B11 … B0
            sh <= sh(10 downto 0) & adc_dout;
          end if;
        else                                   -- ขอบขาลงของ SCK
          sck_i <= '0';
          if n < 5 then
            din_i <= CMD(4 - to_integer(n));
          else
            din_i <= '0';
          end if;
          if n = 19 then                       -- ครบ 12 บิต: CS ขึ้น, ได้ค่า
            cs_i <= '1';
            val  <= sh;
            dn   <= '1';
          end if;
        end if;
      else
        div <= div + 1;
      end if;
    end if;
  end process;

  adc_sck <= sck_i;
  adc_cs  <= cs_i;
  adc_din <= din_i;
  value   <= val;
  done    <= dn;
end rtl;
`; },
    pins:()=>({clk:"clk", adc_dout:"adc:dout", adc_sck:"adc:sck", adc_cs:"adc:cs", adc_din:"adc:din"}) },

  uart_tx:{ label:"ส่งข้อมูลออก UART (ไปคอม) (VHDL)", cat:"dev", desc:"start = 1 → ส่ง data 8 บิตทาง tx (8N1) ไปที่คอมผ่าน USB · busy = 1 ระหว่างส่ง · baud เลือกได้",
    params:{baud:{label:"baud", options:[9600,19200,57600,115200], def:115200}, clk_hz:{label:"clk (Hz)", min:1000000, max:200000000, def:50000000}},
    name:p=>"uart_tx_"+p.baud, board:true,
    vhdl:(p,E)=>{ const BIT=Math.max(2, Math.round(p.clk_hz/p.baud)), BW=vlW(BIT);
      return VL_HEAD+`-- ${E}: UART ส่ง 8N1 ที่ ${p.baud} baud (clk = ${p.clk_hz} Hz, ${BIT} clock ต่อบิต)
entity ${E} is
  port ( clk   : in  std_logic;
         start : in  std_logic;
         data  : in  std_logic_vector(7 downto 0);
         tx    : out std_logic;
         busy  : out std_logic );
end ${E};

architecture rtl of ${E} is
  signal cnt : unsigned(${BW-1} downto 0) := (others => '0');
  signal bit_n : unsigned(3 downto 0) := (others => '0');
  signal sh  : std_logic_vector(9 downto 0) := (others => '1');
  signal bz  : std_logic := '0';
begin
  process(clk)
  begin
    if rising_edge(clk) then
      if bz = '0' then
        if start = '1' then
          sh    <= '1' & data & '0';          -- stop, data (LSB ออกก่อน), start
          bz    <= '1';
          cnt   <= (others => '0');
          bit_n <= (others => '0');
        end if;
      elsif cnt = ${BIT-1} then
        cnt <= (others => '0');
        sh  <= '1' & sh(9 downto 1);
        if bit_n = 9 then
          bz <= '0';
        else
          bit_n <= bit_n + 1;
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
    pins:()=>({clk:"clk", tx:"uart:txd"}) },

  tone:{ label:"เสียงบัซเซอร์ (ความถี่ที่ตั้งไว้) (VHDL)", cat:"dev", desc:"en = 1 → buzzer เป็นคลื่นสี่เหลี่ยมความถี่ f Hz (ต่อขา buzzer ของบอร์ด EDGE)",
    params:{f:{label:"ความถี่ (Hz)", min:20, max:20000, def:440}, clk_hz:{label:"clk (Hz)", min:100000, max:200000000, def:50000000}},
    name:p=>"tone"+p.f, board:true,
    vhdl:(p,E)=>{ const HALF=Math.max(1, Math.round(p.clk_hz/(2*p.f))), W=vlW(HALF);
      return VL_HEAD+`-- ${E}: buzzer ${p.f} Hz เมื่อ en = '1' (clk = ${p.clk_hz} Hz, สลับทุก ${HALF} clock)
entity ${E} is
  port ( clk    : in  std_logic;
         en     : in  std_logic;
         buzzer : out std_logic );
end ${E};

architecture rtl of ${E} is
  signal cnt : unsigned(${W-1} downto 0) := (others => '0');
  signal t   : std_logic := '0';
begin
  process(clk)
  begin
    if rising_edge(clk) then
      if cnt = ${HALF-1} then
        cnt <= (others => '0');
        t   <= not t;
      else
        cnt <= cnt + 1;
      end if;
    end if;
  end process;
  buzzer <= t when en = '1' else '0';
end rtl;
`; },
    pins:()=>({clk:"clk", buzzer:"buzzer"}) },
};

/* ---- settings, text, checks ---- */
function vlParams(kind, a){
  const L=VLIB[kind], p={};
  Object.entries(L.params||{}).forEach(([k,s])=>{ let v=a&&a[k]!=null?a[k]:s.def;
    if(s.bool) v=v===true||v==="true"||v===1||v==="on";
    else if(s.text) v=String(v);
    else if(s.options){ v=+v; if(!s.options.includes(v)) throw new Error(`${s.label}: เลือกได้ ${s.options.join(", ")}`); }
    else { v=Math.floor(+v); if(!(v>=s.min && v<=s.max)) throw new Error(`${s.label} ต้องอยู่ระหว่าง ${s.min} ถึง ${s.max}`); }
    p[k]=v; });
  const e=L.check && L.check(p); if(e) throw new Error(e);
  return p;
}
function vlText(kind, p, name){ return VLIB[kind].vhdl(p, name||VLIB[kind].name(p)); }
/* a port value from the VHDL simulator's state */
function vlOut(M, st, name){ const v=st.sig[name]; return v==null ? null : (v.k==="sl" ? v.v : v.v>>>0); }
/* the check each block passes before it is saved */
function vlVerify(kind, p, text){
  const L=VLIB[kind], M=vhCompile(text), ins=M.ports.filter(x=>x.dir==="in");
  if(L.ref){                                   // combinational: every row up to 12 input bits, else sampled
    const bits=ins.reduce((s,x)=>s+x.width,0), rows=[];
    if(bits<=12) for(let r=0;r<2**bits;r++){ let k=0; const v={}; ins.forEach(x=>{ v[x.name]=(r>>>k)&((2**x.width)-1); k+=x.width; }); rows.push(v); }
    else { let seed=99; const rnd=()=>(seed=(Math.imul(seed,1103515245)+12345)>>>0);
      [0,1].forEach(z=>rows.push(Object.fromEntries(ins.map(x=>[x.name, z?(2**x.width)-1:0]))));
      for(let i=0;i<400;i++) rows.push(Object.fromEntries(ins.map(x=>[x.name, rnd()%(2**x.width)]))); }
    let st=vhInitState(M), n=0;
    for(const v of rows){ if(L.inRange && !L.inRange(v,p)) continue;
      st=vhRun(M, st, v, null); const want=L.ref(v,p); n++;
      for(const [o,w] of Object.entries(want)){ const g=vlOut(M, st, o); if(g!==w) return {pass:false, why:`${o} ได้ ${g} ควรเป็น ${w} เมื่อ ${JSON.stringify(v)}`}; } }
    return {pass:true, how:`จำลอง VHDL ${n} แถวเทียบกับเลขคณิตจริง`};
  }
  return (VL_SEQCHECK[kind]||(()=>({pass:true, how:"คอมไพล์และรันได้"})))(p);
}
/* clocked checks run the same generator at a small clk_hz (the board's 50 MHz would take millions of clocks) */
function vlRunClock(M, st, ins, cycles, each){
  let prev=Object.assign({}, ins, {clk:0});
  for(let i=0;i<cycles;i++){
    const lo=Object.assign({}, ins, {clk:0}), hi=Object.assign({}, ins, {clk:1});
    st=vhRun(M, st, lo, prev); st=vhRun(M, st, hi, lo); prev=hi;
    if(each){ const r=each(st, i, ins); if(r===false) break; }
  }
  return st;
}
const VL_SEQCHECK={
  seg7_num:p=>{ const q=Object.assign({}, p, {clk_hz:4000}), M=vhCompile(vlText("seg7_num", q, "chk"));
    for(const value of [0, 7, 42, 305, 9999, 1234]){
      const seen={}; let st=vhInitState(M);
      st=vlRunClock(M, st, {value}, 20, (s)=>{ const an=vlOut(M,s,"an"), seg=vlOut(M,s,"seg"); seen[an]=seg; });
      for(let k=0;k<4;k++){ const an=0xF & ~(1<<k), d=Math.floor(value/10**k)%10, lead=p.blank && k>0 && value<10**k;
        const want=lead ? 0x7F : SEG_AL[d];
        if(seen[an]!==want) return {pass:false, why:`value ${value} หลักที่ ${k}: seg ${vlBin(seen[an]||0,7)} ควรเป็น ${vlBin(want,7)}`}; } }
    return {pass:true, how:"สแกนครบ 4 หลัก 6 ค่า (0, 7, 42, 305, 9999, 1234) ตรงตามตาราง 7-seg"}; },
  lcd16x2:p=>{ const q=Object.assign({}, p, {clk_hz:20000}), M=vhCompile(vlText("lcd16x2", q, "chk"));
    const nd=((p.line1+p.line2).match(/#/g)||[]).length, value=nd ? Math.min(10**nd-1, 1234 % 10**nd + 5) : 0;
    const screen=[" ".repeat(16)," ".repeat(16)].map(s=>[...s]); let addr=0, lastE=0, writes=0, inited=false;
    let st=vhInitState(M);
    st=vlRunClock(M, st, nd?{value}:{}, 40*(10+60), s=>{ const e=vlOut(M,s,"lcd_e");
      if(lastE===1 && e===0){ const rs=vlOut(M,s,"lcd_rs"), d=vlOut(M,s,"lcd_data");
        if(rs===0){ if(d===0x01) inited=true; if(d&0x80) addr=d&0x7F; }
        else { const row=addr>=0x40?1:0, col=addr&0x3F; if(col<16) screen[row][col]=String.fromCharCode(d); addr++; writes++; } }
      lastE=e; });
    let k=nd; const want=[p.line1, p.line2].map(t=>t.padEnd(16," ").replace(/#/g,()=>String(Math.floor(value/10**(--k))%10)));
    const got=screen.map(r=>r.join(""));
    if(!inited || got[0]!==want[0] || got[1]!==want[1]) return {pass:false, why:`จอแสดง "${got[0]}" / "${got[1]}" ควรเป็น "${want[0]}" / "${want[1]}"`};
    return {pass:true, how:`ถอดสิ่งที่เขียนลงจอทุกขอบขาลงของ E: "${got[0]}" / "${got[1]}"${nd?` (value = ${value})`:""}`}; },
  adc_mcp3208:p=>{ const q=Object.assign({}, p, {clk_hz:2000000}), M=vhCompile(vlText("adc_mcp3208", q, "chk"));
    const sample=[0x5A3, 0xFFF, 0x001, 0x800];
    let st=vhInitState(M), dout=0, rises=0, cmd=[], frame=0, lastSck=0, lastCs=1, got=[], bad=null;
    st=vlRunClock(M, st, {adc_dout:0}, 4*2*22*2+40, (s, i, ins)=>{
      const sck=vlOut(M,s,"adc_sck"), cs=vlOut(M,s,"adc_cs");
      if(lastCs===1 && cs===0){ rises=0; cmd=[]; }
      if(cs===0 && lastSck===0 && sck===1){ rises++; if(rises<=5) cmd.push(vlOut(M,s,"adc_din")); }
      if(cs===0 && lastSck===1 && sck===0){            // the chip shifts its next bit out on SCK's fall
        const v=sample[frame%sample.length]; dout = rises===6 ? 0 : rises>=7 && rises<=18 ? (v>>(18-rises))&1 : 0; }
      if(lastCs===0 && cs===1){ frame++; if(cmd.join("")!=="11"+vlBin(p.ch,3)) bad=`คำสั่งที่ส่ง ${cmd.join("")} ควรเป็น 11${vlBin(p.ch,3)}`; }
      if(vlOut(M,s,"done")===1) got.push(vlOut(M,s,"value"));
      ins.adc_dout=dout; lastSck=sck; lastCs=cs; return got.length<4 && !bad; });
    if(bad) return {pass:false, why:bad};
    if(got.join()!==sample.join()) return {pass:false, why:`อ่านได้ ${got.map(x=>x.toString(16)).join(", ")} ควรเป็น ${sample.map(x=>x.toString(16)).join(", ")}`};
    return {pass:true, how:`ต่อกับแบบจำลอง MCP3208: คำสั่ง 11${vlBin(p.ch,3)} และอ่าน 4 ค่าได้ตรง (5A3, FFF, 001, 800)`}; },
  uart_tx:p=>{ const q=Object.assign({}, p, {clk_hz:p.baud*4}), M=vhCompile(vlText("uart_tx", q, "chk"));
    let st=vhInitState(M); const line=[];
    st=vlRunClock(M, st, {start:1, data:0xA5}, 1, null);
    st=vlRunClock(M, st, {start:0, data:0}, 44, s=>{ line.push(vlOut(M,s,"tx")); });
    // 4 clocks a bit: the start bit, then 8 data bits LSB first, then the stop bit
    const bits=[]; for(let b=0;b<10;b++) bits.push(line[b*4+1]);
    const want=[0, ...[0,1,2,3,4,5,6,7].map(i=>(0xA5>>i)&1), 1];
    return bits.join("")===want.join("") ? {pass:true, how:"ส่ง 0xA5 ได้ start + 10100101 (LSB ก่อน) + stop ตรงจังหวะ baud"}
      : {pass:false, why:`tx ได้ ${bits.join("")} ควรเป็น ${want.join("")}`}; },
  tone:p=>{ const q=Object.assign({}, p, {clk_hz:p.f*8}), M=vhCompile(vlText("tone", q, "chk"));
    let st=vhInitState(M); const L=[];
    vlRunClock(M, st, {en:1}, 32, s=>{ L.push(vlOut(M,s,"buzzer")); });
    const edges=L.filter((x,i)=>i&&x===1&&L[i-1]===0).length;
    return edges>=3 && edges<=5 ? {pass:true, how:`ที่ clk = 8f ได้ ${edges} รอบใน 32 clock (คาบ 8 clock)`} : {pass:false, why:`ได้ ${edges} รอบใน 32 clock ควรเป็น 4`}; },
};

/* save (reusing an identical block of that name, else a free name) and check */
function vlBuild(kind, a){
  const L=VLIB[kind]; if(!L) throw new Error("ไม่มีบล็อก "+kind);
  const p=vlParams(kind, a||{}), C=state.project.customs=state.project.customs||{};
  let name=sanId(a&&a.name || L.name(p)), text=vlText(kind, p, name);
  for(let i=2; C[name] && C[name].vhdl!==text; i++){ name=sanId((a&&a.name||L.name(p))+"_"+i); text=vlText(kind, p, name); }
  const v=vlVerify(kind, p, text);
  if(!v.pass) throw new Error("ตรวจไม่ผ่าน: "+v.why);
  const r=vlBuildSave(text, name);
  C[r.name].description=L.label.replace(/ \(VHDL\)$/,"")+" — "+v.how;
  return {name:r.name, ports:r.ports, verified:v, params:p, text};
}
function vlBuildSave(text, name){ const C=state.project.customs||{}; return vhdlBlockSave(text, C[name] ? name : null); }

/* ---- the form ---- */
function vlDialog(kind, opts){
  const L=VLIB[kind]; if(!L) return;
  const field=(k,s)=>{
    if(s.bool) return `<label class="pt-f"><input type="checkbox" data-vp="${k}" ${s.def?"checked":""}> ${esc(s.label)}</label>`;
    if(s.text) return `<label class="pt-f">${esc(s.label)} <input type="text" data-vp="${k}" value="${esc(s.def)}" maxlength="16" spellcheck="false" style="width:190px;font-family:monospace"></label>`;
    if(s.options) return `<label class="pt-f">${esc(s.label)} <select data-vp="${k}">${s.options.map(o=>`<option ${o===s.def?"selected":""}>${o}</option>`).join("")}</select></label>`;
    return `<label class="pt-f">${esc(s.label)} <input type="number" data-vp="${k}" value="${s.def}" min="${s.min}" max="${s.max}" style="width:${s.max>1e6?120:70}px"></label>`; };
  const m=uxModal(esc(L.label), `
    <div class="muted" style="margin-bottom:8px">${esc(L.desc)}</div>
    <div class="pt-form">${Object.entries(L.params||{}).map(([k,s])=>field(k,s)).join("")}</div>
    <div class="pt-ports" id="vlInfo"></div>
    <details class="vl-src"><summary>ดูโค้ด VHDL</summary><textarea class="vhb-text" id="vlSrc" readonly spellcheck="false"></textarea></details>
    <div class="muted" style="font-size:11.5px;margin-top:8px">บันทึกเป็นบล็อก VHDL ของโปรเจกต์นี้ แก้โค้ดต่อได้ (ดับเบิลคลิกที่บล็อก) · ตรวจการทำงานด้วยตัวจำลอง VHDL ก่อนวางทุกครั้ง</div>`,
    {width:560, foot:`<button class="btn" id="vlSheet" title="แผ่นใหม่ที่มีบล็อกนี้ + ขาเข้า/ออกครบ${L.board?" และจับขาบอร์ด EDGE ให้แล้ว":""}">เปิดเป็นแผ่นใหม่${L.board?" (จับขาบอร์ดให้)":""}</button><button class="btn btn-primary" id="vlPlace">วางบนแผ่นนี้</button>`});
  const read=()=>{ const a={}; m.querySelectorAll("[data-vp]").forEach(e=>{ a[e.dataset.vp]=e.type==="checkbox"?e.checked:e.value; }); return a; };
  const show=()=>{ const el=m.querySelector("#vlInfo");
    try{ const p=vlParams(kind, read()), t=vlText(kind, p), M=vhCompile(t);
      const fmt=d=>M.ports.filter(x=>x.dir===d).map(x=>x.width>1?`${x.raw}[${x.width-1}:0]`:x.raw).join(", ");
      el.innerHTML=`<b>Input:</b> ${esc(fmt("in"))}<br><b>Output:</b> ${esc(fmt("out"))}`+(L.plan?`<br><span class="muted">${esc(L.plan(p))}</span>`:"");
      el.classList.remove("bad"); m.querySelector("#vlSrc").value=t; return true; }
    catch(e){ el.textContent=e.message; el.classList.add("bad"); return false; } };
  m.addEventListener("input", show); show();
  const go=sheet=>{ if(!show()) return;
    try{ mcpBeforeChange && mcpBeforeChange("บล็อก VHDL "+kind); }catch(_){}
    let r; try{ r=vlBuild(kind, read()); }catch(e){ toast(e.message,"err",6000); return; }
    if(sheet){
      const P=state.project.schematics, id=uid("sch"); P[id]=blankSchematic(id, uniqueSchName(r.name+"_top", id));
      const s=P[id]; openSchTab(id); const w=vhdlWrapSheet(s, r.name);
      if(L.pins) s.pinmap=Object.assign({}, L.pins(r.params));
      try{ mcpCommit(s, {routeWires:w.wires}); }catch(_){ snapshot(); renderAll(); }
      toast(`สร้างแผ่น ${s.name} (บล็อก ${r.name}) แล้ว — ${r.verified.how}${L.pins?" · จับขาบอร์ด EDGE ให้แล้ว":""}`,"ok",6000);
    } else {
      const sch=activeSch(), c=vhdlBlockPlace(r.name, sch); snapshot(); renderAll(); try{ focusComp(sch.id, c.id); }catch(_){}
      toast(`วางบล็อก ${r.name} แล้ว — ${r.verified.how}`,"ok",6000);
    }
    m.close(); if(opts && opts.onDone) opts.onDone(r);
  };
  m.querySelector("#vlPlace").onclick=()=>go(false);
  m.querySelector("#vlSheet").onclick=()=>go(true);
}

/* ---- in the library window ---- */
{
  const arith=LIB_CATS.find(c=>c.id==="arith"); if(arith) arith.label="บวก / ลบ / คูณ / หาร";
  if(!LIB_CATS.some(c=>c.id==="dev")) LIB_CATS.splice(LIB_CATS.findIndex(c=>c.id==="lab"), 0, {id:"dev", icon:"⊡", label:"อุปกรณ์บนบอร์ด (LCD, ADC, UART, เสียง)", kinds:[]});
  if(!LIB_CATS.some(c=>c.id==="tools")) LIB_CATS.unshift({id:"tools", icon:"⚙", label:"เครื่องมือออกแบบ", kinds:[]});
  const _items=libItems;
  libItems=function(cat){
    const L=_items.apply(this, arguments), hit=t=>libHit(t);
    const vl=Object.entries(VLIB).filter(([k,V])=>(cat==="all" || V.cat===cat) && hit(k+" "+V.label+" "+V.desc+" vhdl")).map(([k,V])=>({kind:"vlib", k, V}));
    const tools=(cat==="all" || cat==="tools") ? GENERATORS.filter(g=>g.id!=="library" && hit(g.name+" "+g.desc)).map(g=>({kind:"tool", g})) : [];
    return tools.concat(L, vl);
  };
  const _card=libCardHtml;
  libCardHtml=function(it){
    if(it.kind==="tool") return `<div class="lib-card part" data-libtool="${esc(it.g.id)}" title="${esc(it.g.desc)}">
      <div class="lib-ct"><span class="lib-ti">${esc(it.g.icon)}</span> <b>${esc(it.g.name)}</b></div><div class="lib-cd">${esc(it.g.desc)}</div></div>`;
    if(it.kind==="vlib"){ const V=it.V; let io="";
      try{ const p=vlParams(it.k, {}), M=vhCompile(vlText(it.k, p)), fmt=d=>M.ports.filter(x=>x.dir===d).map(x=>x.width>1?`${x.raw}[${x.width-1}:0]`:x.raw).join(", ");
        io=`<div class="lib-io"><div><b>Input:</b> ${esc(fmt("in"))||"—"}</div><div><b>Output:</b> ${esc(fmt("out"))||"—"}</div></div>`; }catch(_){}
      return `<div class="lib-card part" data-libvl="${esc(it.k)}" title="${esc(V.desc)}">
        <div class="lib-ct"><b>${esc(V.label.replace(/ \(VHDL\)$/,""))}</b> <span class="pt-badge vl">VHDL</span> <span class="pt-badge ok" title="ตรวจด้วยตัวจำลอง VHDL ก่อนวางทุกครั้ง">✓ ตรวจทุกครั้ง</span></div>
        <div class="lib-cd">${esc(V.desc)}</div>${io}</div>`; }
    return _card.apply(this, arguments);
  };
  document.addEventListener("click", ev=>{
    const t=ev.target.closest && ev.target.closest("[data-libvl], [data-libtool]"); if(!t) return;
    const win=t.closest(".lib-bg");
    if(t.dataset.libvl) vlDialog(t.dataset.libvl, {onDone:()=>win && win.close()});
    else { if(win) win.close(); runGenerator(t.dataset.libtool); }
  });
}
/* Tools ▸ ตัวสร้างวงจร: only the way into the library (the generators are its "เครื่องมือออกแบบ" cards) */
{
  document.querySelectorAll('#menu .gen-mi:not(.lib-mi)').forEach(b=>b.classList.add("lib-hidden"));
  const lib=document.querySelector('#menu [data-gen="library"]');
  if(lib) lib.title="ชิ้นส่วนสำเร็จรูป บล็อก VHDL (LCD, ADC, คณิต …) และเครื่องมือออกแบบ (ตารางความจริง, FSM, ตัวนับ …) แบ่งหมวด + โมดูลของฉัน";
}

/* ---- icons drawn as lines (Windows drew ▦ ▤ ⊓ … as coloured emoji tiles) ---- */
const LIB_SVG=(()=>{
  const s=b=>`<svg class="lib-svg" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${b}</svg>`;
  return {
    all:s('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>'),
    tools:s('<path d="M3 13l5.5-5.5"/><path d="M9.5 2.5a3 3 0 0 0 4 4l-2 2-4-4z"/><path d="M2 14l1.5-1.5"/>'),
    arith:s('<path d="M4 2v5M1.5 4.5h5"/><path d="M9.5 4.5h5"/><path d="M2 10.5l4 4M6 10.5l-4 4"/><path d="M9.5 12.5h5"/><circle cx="12" cy="10.3" r=".5"/><circle cx="12" cy="14.7" r=".5"/>'),
    alu:s('<path d="M2 2l12 3.5v5L2 14V9.5l2-1.5-2-1.5z"/>'),
    cmp:s('<path d="M7 3L2 6l5 3"/><path d="M9 7l5 3-5 3"/>'),
    sel:s('<path d="M4 2l8 3v6l-8 3z"/><path d="M1 5h3M1 11h3M12 8h3"/>'),
    conv:s('<path d="M2 5h11l-3-3"/><path d="M14 11H3l3 3"/>'),
    seg:s('<path d="M5 2h6M4 3v4.5M12 3v4.5M5 8h6M4 8.5V13M12 8.5V13M5 14h6"/>'),
    led:s('<path d="M5 9a3 3 0 1 1 6 0v2H5z"/><path d="M6 13h4M7 11v2M9 11v2"/><path d="M8 1.5v1.5M2.5 4l1 1M13.5 4l-1 1"/>'),
    ff:s('<rect x="3" y="2" width="10" height="12" rx="1"/><path d="M3 10l2.5 1.5L3 13"/>'),
    cnt:s('<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2v3h-3"/>'),
    clk:s('<path d="M1 11h3V5h3v6h3V5h3v6h2"/>'),
    btn:s('<rect x="2" y="9" width="12" height="4" rx="1"/><path d="M6 9V6h4v3"/><path d="M8 2v2"/>'),
    dev:s('<rect x="1.5" y="3" width="13" height="8" rx="1"/><path d="M4 6h3M4 8h6"/><path d="M5 13.5h6"/>'),
    lab:s('<path d="M1.5 6L8 3l6.5 3L8 9z"/><path d="M4.5 7.5v3c2 1.5 5 1.5 7 0v-3"/>'),
    mine:s('<path d="M2 5l6-3 6 3v6l-6 3-6-3z"/><path d="M2 5l6 3 6-3M8 8v6"/>'),
    user:s('<path d="M2 4h4l1.5 1.5H14V13H2z"/>'),
    vhdl:s('<path d="M5 4L1.5 8 5 12M11 4l3.5 4L11 12M9.5 3l-3 10"/>'),
  };
})();
{
  const _list=libCatList;
  libCatList=function(){ return _list.apply(this, arguments).map(c=>c.sep ? c : Object.assign(c, {icon:LIB_SVG[c.id] || (String(c.id).startsWith("u:") ? LIB_SVG.user : c.icon)})); };
  const gi=document.querySelector('#menu [data-gen="library"] .gi'); if(gi) gi.innerHTML=LIB_SVG.all;
  const _card=libCardHtml;
  libCardHtml=function(it){ const h=_card.apply(this, arguments);
    return it.kind==="tool" ? h.replace(/<span class="lib-ti">[^<]*<\/span> /, "") : h; };
}
