"""LoRA SFT for the Schematic Studio agent model (Qwen3.5-4B) on the executed SFT2 rows.

What this does that a plain `SFTTrainer(assistant_only_loss=True)` does not:
  1. Renders with THE SAME chat template the app's llama-server uses (chat_template.jinja, pulled
     out of qwen3.5-4B-SFT1.gguf). Qwen3.5 writes tool calls as XML
     (<tool_call><function=..><parameter=..>); training on any other format teaches the wrong one.
  2. Per-message loss: an assistant message with "weight": 0 is context only. The recovery rows
     start with SFT1's real mistake (no replace / no connect / build_part on a full sheet); the
     model must learn what to do AFTER the error, never the error itself.
  3. Booleans: the template prints a scalar parameter with `|string`. Python's jinja renders True
     as "True"; llama.cpp renders "true". Arguments are normalised to JSON spelling before
     rendering so training text == inference text.
  4. Thinking OFF, like the app (profile.think = false): every assistant turn after the user's
     request is rendered with an empty <think>\n\n</think>, exactly what the generation prompt
     gives with enable_thinking=false.

Example (16 GB card, QLoRA):
  python train_sft2.py --model_path ./Qwen3.5-4B-SFT1-hf --data sft2_full.jsonl \
      --output_dir out/sft2 --qlora --max_length 16384 --epochs 2
Check the masks before a long run:
  python train_sft2.py --model_path ./Qwen3.5-4B-SFT1-hf --data sft2_full.jsonl --inspect 3
"""
import argparse, json, random




def parse():
    p = argparse.ArgumentParser()
    p.add_argument("--model_path", required=True, help="HF checkpoint to continue from (SFT1 merged, or the base)")
    p.add_argument("--data", nargs="+", required=True, help="one or more .jsonl (e.g. sft2_full.jsonl plus a replay sample of SFT1 data)")
    p.add_argument("--output_dir", default="out/sft2")
    p.add_argument("--chat_template", default="chat_template.jinja")
    p.add_argument("--tools_file", default="tools.json", help="the agent's tool schemas, used for rows without a 'tools' field")
    p.add_argument("--max_length", type=int, default=16384)
    p.add_argument("--tools", choices=["full", "relevant"], default="full",
                   help="full = all 40 tool schemas in every row (what the app sends, ~9k tokens); "
                        "relevant = tools the row uses + 8 random others (much cheaper, slightly less faithful)")
    p.add_argument("--qlora", action="store_true")
    p.add_argument("--lora_r", type=int, default=32)
    p.add_argument("--lora_alpha", type=int, default=64)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--epochs", type=float, default=2.0)
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--grad_accum", type=int, default=16)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--inspect", type=int, default=0, help="print N rendered rows with the trained spans marked, then exit")
    return p.parse_args()


def norm_args(v):
    """JSON spelling for scalars the template prints with |string (True -> 'true', None -> 'null')."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    return v


def prep_messages(msgs):
    out = []
    for m in msgs:
        m = dict(m)
        if m.get("tool_calls"):
            tcs = []
            for tc in m["tool_calls"]:
                f = dict(tc["function"])
                a = f.get("arguments")
                if isinstance(a, str):
                    a = json.loads(a)
                f["arguments"] = {k: norm_args(v) for k, v in (a or {}).items()}
                tcs.append({"id": tc.get("id"), "type": "function", "function": f})
            m["tool_calls"] = tcs
        out.append(m)
    return out


def pick_tools(row, mode, rng):
    tools = row["tools"]
    if mode == "full":
        return tools
    used = {tc["function"]["name"] for m in row["messages"] for tc in (m.get("tool_calls") or [])}
    keep = [t for t in tools if t["function"]["name"] in used]
    rest = [t for t in tools if t["function"]["name"] not in used]
    keep += rng.sample(rest, min(8, len(rest)))
    rng.shuffle(keep)
    return keep


def render(tok, msgs, tools, gen=False):
    return tok.apply_chat_template(msgs, tools=tools, tokenize=False, add_generation_prompt=gen, enable_thinking=False)


def encode(tok, row, mode, rng, max_length):
    msgs = prep_messages(row["messages"])
    tools = pick_tools(row, mode, rng)
    full = render(tok, msgs, tools)
    spans = []
    for i, m in enumerate(msgs):
        if m["role"] != "assistant" or m.get("weight", 1) == 0:
            continue
        p = render(tok, msgs[:i], tools, gen=True)
        f = render(tok, msgs[:i + 1], tools)
        if not f.startswith(p) or not full.startswith(f):
            raise ValueError("chat template is not prefix-stable for this row — check the template file")
        spans.append((len(p), len(f)))
    enc = tok(full, return_offsets_mapping=True, add_special_tokens=False)
    ids, offs = enc["input_ids"], enc["offset_mapping"]
    labels = [-100] * len(ids)
    for k, (a, b) in enumerate(offs):
        if any(s <= a and b <= e for s, e in spans):
            labels[k] = ids[k]
    if len(ids) > max_length:
        return None
    return {"input_ids": ids, "labels": labels, "_text": full, "_spans": spans}


def main():
    import torch
    a = parse()
    rng = random.Random(a.seed)
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.model_path)
    tok.chat_template = open(a.chat_template, encoding="utf-8").read()
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    rows = [json.loads(l) for path in a.data for l in open(path, encoding="utf-8") if l.strip()]
    shared = json.load(open(a.tools_file, encoding="utf-8"))
    shared = shared.get("tools", shared) if isinstance(shared, dict) else shared
    for r in rows:
        r.setdefault("tools", shared)
    rng.shuffle(rows)

    if a.inspect:
        for r in rows[:a.inspect]:
            e = encode(tok, r, a.tools, rng, 10 ** 9)
            t = e["_text"]
            marked, last = "", 0
            for s, e2 in e["_spans"]:
                marked += t[last:s] + "⟦TRAIN⟧" + t[s:e2] + "⟦/TRAIN⟧"
                last = e2
            marked += t[last:]
            print("=" * 100)
            print(f"tokens={len(e['input_ids'])} trained={sum(1 for x in e['labels'] if x != -100)} family={r.get('meta', {}).get('family')}")
            print(marked[-6000:])
        return

    data, skipped = [], 0
    for r in rows:
        e = encode(tok, r, a.tools, rng, a.max_length)
        if e is None:
            skipped += 1
            continue
        data.append({"input_ids": e["input_ids"], "labels": e["labels"]})
    print(f"{len(data)} rows ({skipped} longer than {a.max_length} skipped)")

    from transformers import AutoModelForCausalLM, BitsAndBytesConfig, Trainer, TrainingArguments
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    kw = {"torch_dtype": torch.bfloat16}
    if a.qlora:
        kw["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                                       bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(a.model_path, **kw)
    model.gradient_checkpointing_enable()
    if a.qlora:
        model = prepare_model_for_kbit_training(model)
    model = get_peft_model(model, LoraConfig(r=a.lora_r, lora_alpha=a.lora_alpha, lora_dropout=0.05,
                                             target_modules="all-linear", task_type="CAUSAL_LM"))
    model.print_trainable_parameters()

    def collate(batch):
        n = max(len(b["input_ids"]) for b in batch)
        ids = torch.full((len(batch), n), tok.pad_token_id)
        lab = torch.full((len(batch), n), -100)
        att = torch.zeros((len(batch), n), dtype=torch.long)
        for i, b in enumerate(batch):
            L = len(b["input_ids"])
            ids[i, :L] = torch.tensor(b["input_ids"]); lab[i, :L] = torch.tensor(b["labels"]); att[i, :L] = 1
        return {"input_ids": ids, "labels": lab, "attention_mask": att}

    args = TrainingArguments(output_dir=a.output_dir, per_device_train_batch_size=a.batch, gradient_accumulation_steps=a.grad_accum,
                             num_train_epochs=a.epochs, learning_rate=a.lr, lr_scheduler_type="cosine", warmup_steps=20,
                             logging_steps=5, save_strategy="epoch", bf16=True, report_to=[], remove_unused_columns=False, seed=a.seed)
    Trainer(model=model, args=args, train_dataset=data, data_collator=collate).train()
    model.save_pretrained(a.output_dir + "/adapter")
    tok.save_pretrained(a.output_dir + "/adapter")
    print("saved adapter to", a.output_dir + "/adapter")


if __name__ == "__main__":
    main()
