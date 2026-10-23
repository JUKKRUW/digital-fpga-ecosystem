# HANDOFF — SFT2 (เทรนรอบสุดท้าย Qwen3.5-4B agent)

ไฟล์นี้สำหรับ session ใหม่ที่ไม่มีบริบทเดิม อ่านคู่กับ `README.md`

## อัปเดต — เพิ่ม VHDL (ชุด `sft2_v2.jsonl.gz`, ใช้แทน `sft2_final.jsonl`)
- แอปเพิ่ม `vhdl_block` ให้ agent → `tools.json` = 41 ตัว, `sysprompt.txt` มี 2 บรรทัดใหม่ (ข้อ 2) — แอปเวอร์ชันถัดจาก 2.6.0
- `simulate` ของวงจรลำดับมี `summary` ต่อขาออกอยู่หน้าสุด (แก้ README ข้อ 6.1)
- **สร้างใหม่ทั้งชุดกับแอปปัจจุบัน** (บน Linux ด้วย `serve_app.js` + `FE_APP_ENV`) ให้ทุกแถวเห็นเครื่องมือ / prompt / ผล simulate แบบเดียวกับตอนใช้งานจริง:
  12 family เดิม 651 แถว + VHDL 201 แถว (`vhdl` 135, `vhdl_fix` 36, `vhdl_sem` 30) = **852 แถว**
  ตรวจแล้ว: render 852/852 prefix คงที่ · ERROR 132 จุดอยู่หลังรอบ weight 0 ทั้งหมด · ทุกแถวจบด้วยคำตอบ
- eval เพิ่ม 5 เคส VHDL (`vhdl_rom`, `vhdl_stop`, `vhdl_fix_error`, `vhdl_verify_after`, `no_vhdl_for_part`) — โค้ดที่โมเดลเขียนถูก compile + จำลองด้วย `vhdl_check.js` (ต้องมี node)
- ⚠ GGUF ที่จะวัดต้องเสิร์ฟผ่านแอปเวอร์ชันที่มี `vhdl_block` (ไม่งั้น prompt / tools ไม่ตรงกับตอนเทรน)
- คำสั่งเทรนเหมือนเดิม เปลี่ยนไฟล์ข้อมูลเป็น `sft2_v2.jsonl` (gunzip ก่อน)

## สถานะเดิม (2026-10-23)
- ✅ วัด baseline SFT1 แล้ว: **41%** (12 เคส, temp 0.3, thinking off = ค่าในแอป) → `eval_runs/eval_sft1_base.jsonl`
- ✅ ชุดข้อมูล `sft2_final.jsonl` 648 แถว สร้างเสร็จ ตรวจแล้ว (render 648/648, ERROR ทุกจุดอยู่ในรอบ weight 0)
- ✅ สคริปต์ `train_sft2.py`, `merge_to_gguf.py` พร้อม (ยังไม่เคยรันจริง — เครื่องสร้างข้อมูลไม่มี torch / ไม่มี HF checkpoint)
- ⏳ **ยังไม่ได้ทำ:** เทรน → merge → แปลง GGUF → วัดซ้ำ

## สิ่งที่ต้องมีที่เครื่องเทรน
1. HF checkpoint ของ **SFT1** (merge แล้ว) — `qwen3.5-4B-SFT1.gguf` เป็น GGUF ใช้เทรนไม่ได้ ต้องเป็นตัว HF ที่ใช้สร้าง GGUF นั้น
2. ข้อมูล SFT1 เดิม (ไว้ผสม replay 30–50%) แปลงเป็นรูปแบบเดียวกับ `sft2_final.jsonl`:
   `{"messages":[{role,content,tool_calls?,weight?},...]}` — `tool_calls[].function.arguments` เป็น **dict** ไม่ใช่ string
3. `pip install torch transformers peft bitsandbytes accelerate` · llama.cpp ≥ b11016 (สำหรับแปลง GGUF, arch `qwen35`)

## ขั้นตอน
```
python train_sft2.py --model_path <SFT1-hf> --data sft2_final.jsonl <replay>.jsonl --inspect 3      # ตรวจ mask ก่อน
python train_sft2.py --model_path <SFT1-hf> --data sft2_final.jsonl <replay>.jsonl --output_dir out/sft2 --qlora --max_length 16384 --epochs 2 --lr 1e-4
python merge_to_gguf.py --base <SFT1-hf> --adapter out/sft2/adapter --out ./Qwen3.5-4B-SFT2-hf
python <llama.cpp>/convert_hf_to_gguf.py ./Qwen3.5-4B-SFT2-hf --outfile qwen3.5-4B-SFT2-f16.gguf --outtype f16
<llama.cpp>/llama-quantize qwen3.5-4B-SFT2-f16.gguf qwen3.5-4B-SFT2.gguf Q6_K
```
ถ้า `train_sft2.py` ฟ้อง "chat template is not prefix-stable" = tokenizer ไม่ได้ใช้ `chat_template.jinja` (สคริปต์ตั้งให้เอง ตรวจว่าไฟล์อยู่ในโฟลเดอร์เดียวกัน)

## วัดผลหลังเทรน (ที่เครื่องที่มีแอป FPGA Ecosystem)
- วาง `qwen3.5-4B-SFT2.gguf` ที่ `%LOCALAPPDATA%\FPGA Ecosystem\models\` แล้วให้แอปเสิร์ฟตัวนั้น
- `PYTHONUTF8=1 EVAL_TAG=sft2 python eval_format.py 4` แล้ว `TAGS=sft1_base,sft2 python rescore.py`
- eval ยิงผ่าน `http://127.0.0.1:8770/api/llm/chat` (port ดูใน `%APPDATA%\FPGA Ecosystem\runtime.json`)
- เป้า: ชนะ 41% ชัดเจน โดยเฉพาะเคสที่ SFT1 ได้ 0: `split_div25`, `recover_has_parts`, `read_result_fix`, `probe_route`, `verify_after_build`

## ข้อเท็จจริงสำคัญ (อย่าเปลี่ยนโดยไม่จำเป็น)
- โมเดล = **Qwen3.5-4B เท่านั้น** (ไม่ใช้ 9B) · SFT1 = Q6_K, arch `qwen35`, ctx 65536, แอปปิด thinking, temp 0.3
- tool call ของ Qwen3.5 เป็น XML: `<tool_call>\n<function=NAME>\n<parameter=P>\nVALUE\n</parameter>\n</function>\n</tool_call>`
  ค่า array/object = JSON ข้างใน · ค่า boolean ต้องเป็น `true`/`false` (สคริปต์แปลงให้)
- แอป v2.6.0: `build_hierarchy.connect` = `[["driver","receiver"], …]` · `blocks` รับ `{name, sheet}` (แผ่นที่มีอยู่) หรือ `{name, part, params}`
- `weight: 0` บน assistant message = บริบทเท่านั้น ไม่เข้า loss (ความผิดของ SFT1 ที่ใส่ไว้ให้โมเดลเห็นก่อนกู้ตัว)

## ถ้าจะสร้างข้อมูลเพิ่ม
`gen_sft2.py` ต้องรันบนเครื่องที่เปิดแอป FPGA Ecosystem อยู่ (ขับผ่าน MCP: `FPGAEcosystem-MCP.exe`, path ใน `mcpcli.py`)
สร้างโปรเจค `sftg_*` ชั่วคราวแล้วลบเอง และสลับกลับโปรเจคผู้ใช้ด้วย `export_project` (ห้ามใช้ `open_project` — โหลดทับจากดิสก์ งานที่ไม่ได้เซฟหาย)
