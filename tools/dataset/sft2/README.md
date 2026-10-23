# SFT2 — ชุดข้อมูลเทรนรอบสุดท้ายของโมเดล agent (Qwen3.5-4B)

สร้างและวัดเมื่อ 2026-10-23 กับ FPGA Ecosystem **v2.6.0** และโมเดล `qwen3.5-4B-SFT1.gguf` (Q6_K, arch `qwen35`)

## ไฟล์ในโฟลเดอร์

| ไฟล์ | คืออะไร |
|---|---|
| `sft2_final.jsonl` | **ชุดข้อมูล 648 แถว** (OpenAI chat format + `tool_calls`) |
| `tools.json` | tool schema **41 ตัว** ของ agent ตัวจริง (ดึงจาก `/api/agent/tools`, รวม `vhdl_block`) — ใช้ร่วมทุกแถว |
| `chat_template.jinja` | chat template ที่ฝังใน GGUF ของ SFT1 — **ต้องใช้ตัวนี้ตอนเทรนและตอน merge** |
| `sysprompt.txt` | system prompt ของ agent (ดึงจาก `aiagSystemPrompt()` ในแอป) |
| `train_sft2.py` | เทรน LoRA พร้อม per-message mask |
| `merge_to_gguf.py` | merge LoRA + ฝัง template กลับ → แปลง GGUF |
| `eval_format.py` | ชุด eval 12 เคส ยิงตรงเข้าโมเดลผ่านแอป |
| `rescore.py` | ให้คะแนนผลที่บันทึกไว้ใหม่ (ไม่เรียกโมเดล) |
| `eval_runs/` | ผล baseline ของ SFT1 |
| `gen_sft2.py`, `appcall.py`, `mcpcli.py` | ตัว generate ชุดข้อมูล (ยิงผ่านแอปจริง) |
| `vhdl_families.py` | family `vhdl`, `vhdl_fix`, `vhdl_sem` — บล็อก VHDL (เพิ่มเข้า `gen_sft2.py`) |
| `serve_app.js` | เปิดแอปส่วนตัว (launcher + editor ใน Chromium headless) บน Linux / CI ให้ `gen_sft2.py` ยิงผ่าน `FE_APP_ENV` |
| `make_replay.py` → `replay_sft1.jsonl.gz` | ข้อมูล SFT1 เดิม (`../data/train.jsonl.gz`) แปลงเป็นรูปแบบนี้ไว้ผสม 30–50 % |
| `vhdl_check.js` | compile + จำลอง VHDL ที่โมเดลเขียนด้วยตัวจำลองของแอป (เคส eval VHDL) |
| `render_check.py` | ตรวจว่าทุกแถว render กับ template ได้ และ mask ถูก |

---

## 1. Baseline ของ SFT1

ยิงตรงเข้าโมเดลด้วย system prompt + 40 tools **ตัวเดียวกับที่ agent ส่งจริง** วัดการตัดสินใจรอบถัดไปของแต่ละเคส

| ตั้งค่า | ถูก | เรียก tool | วินาที/คอล |
|---|---|---|---|
| ปกติ (temp 0.3, ปิด thinking — ค่าในแอป) | **20/48 (41%)** | 44/48 | 4.8 |
| temp 0 | 15/36 (41%) | 33/36 | 5.1 |
| เปิด thinking | 19/36 (52%) | 27/36 | 10.5 |

| เคส | SFT1 | ทำไมตก |
|---|---|---|
| split_div50 / div40 | cascade ถูกแทบทุกครั้ง | ลืม `replace:true` บนแผ่นที่มีของ |
| split_div25 | 0/4 | บล็อกชื่อซ้ำ `div5` สองตัว, ไม่ใส่ connect, `inputs:["clk","out"]` |
| recover_has_parts | 0/4 | หลัง error ไปสร้าง `new_sheet` เปล่าแทน |
| read_result_fix | 0/4 | ได้ `undriven_outputs:["clk_out"]` กลับมาแล้ว**ยิงคำสั่งเดิมซ้ำ** |
| probe_route | 0/4 | "sw0 ถึง sw3 เป็น 1" → `{"sw":1}` (ต้องเป็น 15) |
| verify_after_build | 1/4 | ตอบเลยไม่ตรวจ บางรอบ**เคลมว่าตรวจผ่าน** |
| blocks_from_sheets | 1/4 | ไม่ใส่ connect ปล่อยให้ auto |
| name_respect, multi_goal, delete_refs, set_pins | 4/4 | — |

**ปัญหาเก่า "ยิง `connect` ไม่ออก" หายแล้ว** — v2.6.0 เปลี่ยน `connect` เป็น `[["drv","rcv"], …]` (array ของ array ของ string) โมเดลเขียนได้ถูก ตัวแก้ฟอแมท (`aiagStructuredCall`, constrained decoding ด้วย `response_format: json_schema`) เลยแทบไม่ได้ทำงานแล้ว (+1 เคส) ปัญหาตอนนี้คือ**ค่าใน argument ผิด** ซึ่ง grammar แก้ไม่ได้ ต้องแก้ด้วยการเทรน

---

## 2. ชุดข้อมูล

**ทุก tool call ในชุดนี้ยิงผ่านแอปจริง** — ผลลัพธ์ใน tool message คือสิ่งที่ agent เห็นจริง (`JSON.stringify(result)` ตัดที่ 6000 ตัวอักษร หรือ `ERROR: …`) และคำตอบภาษาไทยท้ายแถว**เขียนจากผลจริงเท่านั้น** จึงไม่มีทางเคลมการตรวจที่ไม่ได้ทำ

| family | แถว | สอนอะไร |
|---|---|---|
| split | 272 | แตกตัวหารเป็น cascade: `get_sheet` → `build_hierarchy {replace, connect}` → `check`+`simulate` → สรุป (16 ค่า N, 6 แบบ) |
| probe | 144 | "ถ้าใส่ X แล้ว Y ไหม" → `probe` ด้วยค่าตามโจทย์ → ตอบจาก outputs |
| probe_group | 46 | สวิตช์เป็นตัวเลขเดียว `{"sw":"0x0F"}` (sw0 ถึง sw3, 0x.., ค่าทศนิยม) |
| pins | 74 | คำพูดธรรมดา → target (`LED 2`→`led:2`, ปุ่มกลาง→`pb:4`, …) |
| build | 44 | สร้าง → **check + simulate ก่อนตอบเสมอ** (24 ชนิด) |
| compose / compose_rec | 18 / 12 | ประกอบจากแผ่นที่มีอยู่ (`blocks:[{sheet}]`) ด้วย connect ครบทุกเส้น |
| multi | 12 | หลายงานในข้อความเดียว → ยิงพร้อมกันในรอบเดียว |
| spec | 10 | `set_spec` จากโจทย์ → สร้าง → `check_spec` |
| edit | 8 | `delete {refs}` แล้วรายงานขาที่ลอยตามจริง |
| qa | 8 | คำถามล้วน ตอบตรงไม่เรียก tool |

**แถวกู้ตัว 156 แถว** เริ่มจาก**ความผิดจริงของ SFT1**: ลืม `replace`, ไม่ใส่ `connect`, `build_part` ลงแผ่นที่มีของ — รอบที่ผิดติด `"weight": 0` เป็นแค่บริบท **ไม่เทรน** โมเดลจึงเรียนเฉพาะสิ่งที่ทำ*หลัง* error

ตรวจแล้ว: ERROR ทุกจุด (96) มาจากรอบ weight 0 เท่านั้น · render ด้วย template จริง 648/648 แถว prefix คงที่ · ไม่มีแถวที่จบด้วย tool call

---

## 3. เทรน

```bash
pip install torch transformers peft bitsandbytes accelerate
# ดู mask ก่อน (พิมพ์ข้อความที่จะเทรนกำกับด้วย ⟦TRAIN⟧)
python train_sft2.py --model_path ./Qwen3.5-4B-SFT1-hf --data sft2_final.jsonl --inspect 3
# เทรนจริง (การ์ด 16 GB)
python train_sft2.py --model_path ./Qwen3.5-4B-SFT1-hf --data sft2_final.jsonl replay_sft1.jsonl \
    --output_dir out/sft2 --qlora --max_length 16384 --epochs 2 --lr 1e-4
```

สิ่งที่สคริปต์ทำต่างจาก `SFTTrainer(assistant_only_loss=True)`:
1. **ใช้ chat template ของ GGUF** — Qwen3.5 เรียก tool แบบ XML (`<tool_call><function=build_hierarchy><parameter=connect>[[…]]</parameter>…`) ถ้าเทรนรูปแบบอื่น โมเดลจะเรียนผิด
2. **mask รายข้อความ** — `weight: 0` ไม่เข้า loss
3. **boolean** — template พิมพ์ค่าเดี่ยวด้วย `|string` → Python ได้ `True` แต่ llama.cpp ได้ `true` สคริปต์แปลงเป็น `true` ก่อน render ให้ตรงกัน
4. **ปิด thinking** แบบเดียวกับแอป — ทุก assistant turn ได้ `<think>\n\n</think>` ว่าง ตรงกับ generation prompt ตอน `enable_thinking=false`

ข้อแนะนำ:
- **ต่อจาก SFT1** (HF checkpoint ที่ merge แล้ว) ไม่ใช่จาก base
- **ผสมข้อมูล SFT1 เดิม 30–50%** (`replay_sft1.jsonl`) — ชุดนี้ 648 แถวเน้นเฉพาะจุดอ่อน ถ้าเทรนล้วนเสี่ยงลืมทักษะอื่น
- แถวยาวสุด ~50k ตัวอักษรรวม tools ≈ 14–16k tokens → `--max_length 16384` ถ้า VRAM ไม่พอใช้ `--tools relevant` (tool ที่แถวใช้ + สุ่ม 8 ตัว)

## 4. แปลงกลับเป็น GGUF

```bash
python merge_to_gguf.py --base ./Qwen3.5-4B-SFT1-hf --adapter out/sft2/adapter --out ./Qwen3.5-4B-SFT2-hf
python <llama.cpp>/convert_hf_to_gguf.py ./Qwen3.5-4B-SFT2-hf --outfile qwen3.5-4B-SFT2-f16.gguf --outtype f16
<llama.cpp>/llama-quantize qwen3.5-4B-SFT2-f16.gguf qwen3.5-4B-SFT2.gguf Q6_K
```
`merge_to_gguf.py` ฝัง `chat_template.jinja` กลับเข้า tokenizer ก่อนเซฟ — GGUF ใหม่จะได้ template เดิม ใช้ llama.cpp ≥ b11016

## 5. วัดผลหลังเทรน (ชุด eval เดิม)

วาง GGUF ใหม่ที่ `%LOCALAPPDATA%\FPGA Ecosystem\models\` แล้วให้แอปเสิร์ฟตัวนั้น จากนั้น:
```bash
PYTHONUTF8=1 EVAL_TAG=sft2 python eval_format.py 4
TAGS=sft1_base,sft2 python rescore.py
```
eval ยิงผ่าน `/api/llm/chat` ของแอป (port จาก `%APPDATA%\FPGA Ecosystem\runtime.json`, ปกติ 8770) — วัดโมเดลไหนก็ได้ที่แอปเสิร์ฟอยู่

⚠️ เคส eval เป็นเคสที่ชุดข้อมูลมีตัวอย่างใกล้เคียง (div ค่า N อื่น, sheet ชื่ออื่น) — ใช้เทียบ "ก่อน/หลัง" ได้ แต่ไม่ใช่การวัดความสามารถทั่วไป ควรลอง `ai_chat` แบบพิมพ์เองด้วย

---

## 6. เรื่องที่ควรแก้ฝั่งแอป (ไม่ต้องเทรน)

1. **ผล `simulate` ของวงจรลำดับยาวเกิน 6000 ตัวอักษรแล้วโดนตัด** — ส่วน `rows` มาก่อน โมเดลเห็นแค่ราว 90 รอบแรก ตัวหารคาบยาวจึงยืนยันคาบไม่ได้ ควรใส่สรุปต่อขาออก (คาบ / duty) ไว้*ก่อน* rows
2. **แอปค้าง "the editor did not pick up X within 60 s"** — เจอ 3 ครั้งระหว่าง generate (`new_project`, `check`, `simulate`) ทั้งที่ไม่มี dialog เปิด
3. **thinking**: เปิดแล้วถูกขึ้น 41→52% แต่ช้าเท่าตัวและเรียก tool น้อยลง หลังเทรน SFT2 ควรวัดซ้ำทั้งสองแบบก่อนตัดสินใจ
4. `set_pins` รับ `"LED0"` ได้อยู่แล้ว (normalize เป็น `led:0`) — ไม่ใช่ปัญหา
5. tool schema ฝั่ง inference ถูก render ด้วย `tojson` ของ llama.cpp (ไม่มีช่องว่าง) ส่วน Python ใส่ `", "` — ต่างกันเล็กน้อยระดับ token ในบล็อก `<tools>` ยอมรับได้

## 7. สร้างชุดข้อมูลใหม่

```bash
PYTHONUTF8=1 python gen_sft2.py out.jsonl --families split,probe,build,pins,multi,compose,spec,edit,qa,probe_group,compose_rec,pins_more
```
ต้องเปิดแอปไว้ สคริปต์สร้างโปรเจค `sftg_*` ชั่วคราวแล้วลบทิ้ง (ลบเฉพาะชื่อขึ้นต้น `sftg_`) และสลับกลับโปรเจคเดิม**จากหน่วยความจำ** (`export_project`) ไม่โหลดทับจากดิสก์ งานที่ยังไม่เซฟจึงไม่หาย

---

## 8. VHDL (เพิ่มหลัง v2.6.0)

แอปเพิ่มเครื่องมือ `vhdl_block` ให้ agent (tools.json = 41 ตัว) และ system prompt มี 2 บรรทัดใหม่ใต้ข้อ 2:
"No part for it and awkward as gates (a lookup / ROM table, a state machine written as a case, an odd counter)?
vhdl_block {vhdl, sheet} — …". `vhdl_block {vhdl, sheet}` ทำแผ่นนั้นเป็นบล็อก VHDL พร้อมขา IN/OUT ตาม port ของ
entity ต่อสายครบในคำสั่งเดียว แล้ว check + simulate ได้เลย (ตัวจำลอง VHDL ในเบราว์เซอร์)

**ผล `simulate` ของวงจรลำดับมี `summary` ต่อขาออกอยู่หน้าสุดแล้ว** (changes, period, high, values, first 24 clock)
แก้ข้อ 6.1 — ตัด 6000 ตัวอักษรแล้วยังเห็นคาบ

| family | สอนอะไร | ตรวจอย่างไร |
|---|---|---|
| `vhdl` | ตาราง ROM, ตัวนับถึง N แล้วหยุด, นับขึ้น/ลง, FSM ไฟจราจร, max/min/\|a−b\|, ตัวสะสมค่า → `vhdl_block` → `check` + `simulate` → ตอบจากผลจริง | ผลจำลองต้องตรงกับโมเดลอ้างอิงใน Python ทุกแถว / ทุก clock ไม่ตรง = ไม่เก็บแถว |
| `vhdl_fix` | โค้ดแรกผิดแบบที่แอปไม่รับ (unsigned → std_logic_vector ไม่แปลง, integer → เวกเตอร์, `if clr then`, multiple drivers, ค่าในตารางบิตขาด, ชื่อแผ่นซ้ำ entity) — **weight 0** → เรียกใหม่ที่ถูก | เหมือนข้างบน |
| `vhdl_sem` | โค้ดแรก compile ผ่านแต่ทำผิด (ไม่หยุด, ค่าในตารางผิด, เหลืองนานไป, max/min กลับด้าน, นับเกิน) — **weight 0** → check + simulate (เทรน) → อ่านค่าแล้วแก้บนแผ่นเดิม `replace:true` | รอบแรกต้องไม่ตรง รอบหลังต้องตรง |

สร้างบน Linux (ไม่ต้องมี Windows):
```bash
node tools/dataset/sft2/serve_app.js /tmp/app_env.json &          # แอปส่วนตัว home ของตัวเอง
cd tools/dataset/sft2 && FE_APP_ENV=/tmp/app_env.json python3 gen_sft2.py out.jsonl --families vhdl,vhdl_fix,vhdl_sem
```
eval: เคสใหม่ `vhdl_rom`, `vhdl_stop`, `vhdl_fix_error` (โค้ดที่โมเดลเขียนถูก compile + จำลองด้วย `vhdl_check.js` ต้องมี node),
`vhdl_verify_after`, `no_vhdl_for_part` (มีชิ้นส่วนสำเร็จแล้วต้องไม่เขียน VHDL)
