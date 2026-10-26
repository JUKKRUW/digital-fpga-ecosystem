# HANDOFF — SFT3 (Qwen3.5-4B agent, รอบที่ 3)

แผนและเหตุผล: `PLAN.md` · แอปที่ข้อมูลชุดนี้สร้างด้วย = **v2.7.2** (ต้องใช้ตัวนี้ตอนวัดผลด้วย)

## ไฟล์
| ไฟล์ | คืออะไร |
|---|---|
| `sft3_data.jsonl.gz` | **1,227 แถว** รูปแบบเดียวกับ SFT2 (`messages` + `tools` + `meta`), tool-call arguments เป็น dict, `weight: 0` = บริบทไม่เข้า loss (201 turn) — render ผ่าน `chat_template.jinja` ครบ prefix คงที่ 0 ปัญหา |
| `manifest.json` | จำนวนแถวต่อ family |
| `tools.json` / `sysprompt.txt` | tool schema 41 ตัว + system prompt ของแอป 2.7.2 (เปลี่ยนจาก SFT2 แค่คำอธิบาย `probe`) |
| `gen_sft3.py`, `build_sft3.py` | สร้างข้อมูล (ทุก call รันในแอปจริงผ่าน MCP) → ไฟล์เทรน |
| `eval_sft3.py` | eval แบบตัดสินใจรอบเดียว: 18 เคสเดิม + 15 เคสใหม่ (hold-out) |
| `eval_e2e.py` | eval ทั้งรอบผ่าน `ai_chat` 10 งาน ตรวจวงจรจริง + แผ่นอื่นไม่ถูกแตะ + ป้าย ⚠ ของแอป |
| `from_logs.py` | log การใช้งานจริง + 👍/👎 → แถวเทรน (รอบนี้ยังไม่ได้ใช้: 👍 มี 1 อันและเป็น fast path ไม่มีการเรียกโมเดล) |

## ข้อมูลมีอะไร
ใหม่ 552 แถว: `probe_bits` 185 (บิต/ช่วงตามที่ผู้ใช้พูด, ช่วงที่ข้ามสวิตช์ที่ไม่มี → แก้เป็นรายบิต) · `edit_report` 99 (เปลี่ยนชื่อ/ชนิดเกต/ลบ/เพิ่มขา NOT — คำตอบบอกสิ่งที่ทำจริง) · `qa_plain` 82 (คำถามความรู้ไม่ใช้ tool = คำตอบจาก open-weight model ที่ผ่านกรรมการ 2 ตัว · คำถามเกี่ยวกับแผ่น = จำลองอย่างเดียวไม่แก้) · `stop_check` 60 (ตรวจรอบเดียวแล้วตอบ / ผล `unchanged` → ตอบเลย) · `sim_cycles` 40 (cycles ≈ 3N+8 แล้วอ่าน `summary.period` / `duty`) · `tool_cover` 37 (verify_truth_table, simulate vectors, get_pins, board_check, search_course, save/use_module, explain_simulation → connect → probe) · `dup_blocks` 36 (บล็อกชนิดเดียวกันหลายตัว ชื่อไม่ซ้ำ + กู้จาก "no block 'd0'") · `locked` 13
SFT2 สร้างใหม่กับแอปนี้ 675 แถว (ทุก family ยกเว้น `probe_group` ซึ่งเป็นต้นเหตุคำตอบคิด bitmask ผิด) · `split` ตัดเหลือ 140 (แม่แบบคำตอบของมันถูกลอกไปตอบงานอื่น)

## ฝั่งเทรน
```
cd tools/dataset/sft2           # train_sft2.py + chat_template.jinja อยู่ที่นี่
gunzip -k ../sft3/sft3_data.jsonl.gz replay_sft1.jsonl.gz
python train_sft2.py --model_path <SFT2-hf> --data ../sft3/sft3_data.jsonl replay_sft1.jsonl --tools_file ../sft3/tools.json --inspect 3
python train_sft2.py --model_path <SFT2-hf> --data ../sft3/sft3_data.jsonl replay_sft1.jsonl --tools_file ../sft3/tools.json \
       --output_dir out/sft3 --qlora --max_length 16384 --epochs 2 --lr 5e-5
python merge_to_gguf.py --base <SFT2-hf> --adapter out/sft3/adapter --out ./Qwen3.5-4B-SFT3-hf
# → convert_hf_to_gguf.py → llama-quantize Q6_K → qwen3.5-4B-SFT3.gguf
```
- base = **SFT2** (HF ที่ merge แล้ว) ไม่ใช่ SFT1 · lr 5e-5 (ครึ่งหนึ่งของรอบก่อน) · replay_sft1 628 แถว ≈ 34 % ของ mix
- แถว replay ไม่มี `tools` → ใช้ `--tools_file ../sft3/tools.json` (ห้ามใช้ของ sft2: คำอธิบาย probe เก่า)

## ฝั่งวัดผล (เครื่องที่มีแอป 2.7.2 + GPU)
1. **baseline ก่อนเทรน** (SFT2 ในแอป):
   `EVAL_TAG=sft2_base python eval_sft3.py 4` และ `EVAL_TAG=sft2_base python eval_e2e.py 2`
2. หลังเทรน วาง `qwen3.5-4B-SFT3.gguf` แล้วเลือกในหน้าตั้งค่า → `EVAL_TAG=sft3 …` สองคำสั่งเดิม
3. เป้า: eval_sft3 ≥ 90 % (เคสเดิมไม่ตก), eval_e2e ไม่มีรันไหนแตะแผ่นอื่น, ⚠ ของแอป ≤ 1 ใน 10
- eval_e2e สร้างโปรเจค `sftg_e2e_*` ทีละงานแล้วลบเอง และกลับไปโปรเจคเดิมตอนจบ (ใช้ export_project ไม่ใช่ open_project)
- ระหว่างใช้งานปกติกด 👍/👎 ต่อ → `python from_logs.py "%APPDATA%\FPGA Ecosystem\agent-runs"` ได้ข้อมูลรอบหน้า
