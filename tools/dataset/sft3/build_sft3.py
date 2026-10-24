"""gen_sft3.py's raw output → sft3_data.jsonl.gz (what the trainer gets) + manifest.json.

  python3 build_sft3.py <raw.jsonl> [--split 140] [--seed 3]

SFT2's `split` family (div N → div a → div b) is cut down to --split rows: its answer template is what the SFT2
model copied into unrelated tasks ("ขึ้นทุก 50 clock" in a div25 job, a rename answered as a div50 build), so it
no longer gets a fifth of the data. Every other row is kept. Tool-call arguments stay objects; rows carry their
tools (this round's tools.json).
"""
import argparse, collections, gzip, json, os, random

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("raw")
ap.add_argument("--split", type=int, default=140)
ap.add_argument("--seed", type=int, default=3)
ap.add_argument("--out", default=os.path.join(HERE, "sft3_data.jsonl.gz"))
a = ap.parse_args()

rows = [json.loads(l) for l in open(a.raw, encoding="utf-8")]
rng = random.Random(a.seed)
split = [r for r in rows if r["meta"]["family"] == "split"]
keep_split = set(id(r) for r in rng.sample(split, min(a.split, len(split))))
out = [r for r in rows if r["meta"]["family"] != "split" or id(r) in keep_split]
seen, final = set(), []
for r in out:                                   # the same conversation twice (a phrasing that repeats) once
    k = json.dumps(r["messages"], ensure_ascii=False, sort_keys=True)
    if k not in seen:
        seen.add(k); final.append(r)
rng.shuffle(final)
with gzip.open(a.out, "wt", encoding="utf-8") as f:
    for r in final:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
new = {"probe_bits", "stop_check", "edit_report", "tool_cover", "dup_blocks", "locked", "sim_cycles", "qa_plain"}
fam = collections.Counter(r["meta"]["family"] for r in final)
man = {"rows": len(final), "new_families": {k: v for k, v in fam.items() if k in new},
       "sft2_families_regenerated": {k: v for k, v in fam.items() if k not in new},
       "masked_assistant_turns": sum(1 for r in final for m in r["messages"] if m["role"] == "assistant" and m.get("weight") == 0),
       "tools": len(final[0]["tools"]) if final else 0}
json.dump(man, open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps(man, ensure_ascii=False, indent=1))
