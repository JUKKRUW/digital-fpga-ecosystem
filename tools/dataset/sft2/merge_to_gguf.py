"""Merge the SFT2 LoRA into the checkpoint it was trained from, with THE SAME chat template the app
uses, so the GGUF made from it embeds that template (llama.cpp reads tokenizer.chat_template).

  python merge_to_gguf.py --base ./Qwen3.5-4B-SFT1-hf --adapter out/sft2/adapter --out ./Qwen3.5-4B-SFT2-hf
  python <llama.cpp>/convert_hf_to_gguf.py ./Qwen3.5-4B-SFT2-hf --outfile qwen3.5-4B-SFT2-f16.gguf --outtype f16
  <llama.cpp>/llama-quantize qwen3.5-4B-SFT2-f16.gguf qwen3.5-4B-SFT2.gguf Q6_K      # SFT1 is Q6_K too

Use a llama.cpp at least as new as b11016 (the build that serves SFT1; arch 'qwen35').
"""
import argparse

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

p = argparse.ArgumentParser()
p.add_argument("--base", required=True)
p.add_argument("--adapter", required=True)
p.add_argument("--out", required=True)
p.add_argument("--chat_template", default="chat_template.jinja")
a = p.parse_args()

tok = AutoTokenizer.from_pretrained(a.base)
tok.chat_template = open(a.chat_template, encoding="utf-8").read()
model = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.bfloat16)
model = PeftModel.from_pretrained(model, a.adapter).merge_and_unload()
model.save_pretrained(a.out, safe_serialization=True)
tok.save_pretrained(a.out)
print("merged ->", a.out)
