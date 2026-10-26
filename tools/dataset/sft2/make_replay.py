"""replay_sft1.jsonl — SFT1's own training rows (tools/dataset/data/train.jsonl.gz), in this folder's format,
to mix with sft2_v2.jsonl (30–50 % of the mix) so SFT2 does not forget what SFT1 learned.

  python3 make_replay.py [--n 600] [--seed 1] [--out replay_sft1.jsonl]

Per row: tool-call arguments become objects; reasoning_content is dropped (thinking is off in the app and in SFT2); "train": false → "weight": 0; agent rows get the CURRENT agent
system prompt (sysprompt.txt — the project line is kept) and no "tools" field (train_sft2.py then uses
tools.json, the 41 tools the app sends now); rows that are not agent rows (Thai chat, Q&A mode, general tool
use) keep their own tools or none ("tools": []). A stratified sample by category, every category kept.
"""
import argparse, gzip, json, os, random, collections

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--src", default=os.path.join(HERE, "..", "data", "train.jsonl.gz"))
ap.add_argument("--n", type=int, default=400, help="conversations sampled (agent ones split into one row per request — see below)")
ap.add_argument("--seed", type=int, default=1)
ap.add_argument("--out", default=os.path.join(HERE, "replay_sft1.jsonl"))
a = ap.parse_args()
SYS = open(os.path.join(HERE, "sysprompt.txt"), encoding="utf-8").read().rstrip("\n")
rows = [json.loads(l) for l in gzip.open(a.src, "rt", encoding="utf-8")]
rng = random.Random(a.seed)
by = collections.defaultdict(list)
for r in rows:
    by[r["cat"]].append(r)
take = []
for cat, L in by.items():
    k = max(1, round(a.n * len(L) / len(rows)))
    take += rng.sample(L, min(k, len(L)))
rng.shuffle(take)

out, swapped = [], 0
for r in take:
    msgs = []
    for m in r["messages"]:
        m = dict(m)
        if m.get("train") is False:
            m["weight"] = 0
        m.pop("train", None)
        # the app runs the model with thinking off (the prompt ends in an empty <think></think>), and so do the
        # SFT2 rows: a reasoning text here could never follow that prompt — dropped
        m.pop("reasoning_content", None)
        if m.get("tool_calls"):
            tcs = []
            for tc in m["tool_calls"]:
                f = dict(tc["function"])
                if isinstance(f.get("arguments"), str):
                    try:
                        f["arguments"] = json.loads(f["arguments"] or "{}")
                    except ValueError:
                        f["arguments"] = {"_raw": f["arguments"]}
                tcs.append(dict(tc, function=f))
            m["tool_calls"] = tcs
        msgs.append(m)
    if r.get("tools_ref") == "app":
        s0 = msgs[0]
        if s0["role"] == "system" and s0["content"].startswith("You are the assistant inside Schematic Studio"):
            i = s0["content"].find("\n\nProject:")
            s0["content"] = SYS + (s0["content"][i:] if i >= 0 else "")
            swapped += 1
    # One row per user message: the chat template drops the <think> block of assistant turns that come before
    # the LAST user message, so a turn is only rendered the way the model produced it when it follows the last
    # user message of its row (the agent's "(system) …" notes are user messages too). Earlier turns: weight 0.
    users = [i for i, m in enumerate(msgs) if m["role"] == "user"]
    for j, u in enumerate(users):
        end = users[j + 1] if j + 1 < len(users) else len(msgs)
        seg = [dict(m) for m in msgs[:end]]
        for i, m in enumerate(seg):
            if m["role"] == "assistant" and i < u:
                m["weight"] = 0
        while seg and seg[-1]["role"] == "tool":           # end on the assistant turn (its results are the next row's context)
            seg.pop()
        if not any(m["role"] == "assistant" and m.get("weight", 1) != 0 for m in seg):
            continue
        row = {"messages": seg, "meta": {"family": "replay_sft1", "cat": r["cat"], "id": r.get("id"), "part": j}}
        if r.get("tools_ref") != "app":
            row["tools"] = r.get("tools") or []
        out.append(row)
with open(a.out, "w", encoding="utf-8") as f:
    for r in out:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(f"{len(take)} conversations → {len(out)} rows → {a.out} · agent prompt updated in {swapped} · by category:",
      dict(collections.Counter(r["meta"]["cat"] for r in out)))
