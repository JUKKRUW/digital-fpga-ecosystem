"""Re-apply the CURRENT checkers of eval_format.py to saved eval_*.jsonl runs (no model calls)."""
import json, sys, collections, importlib.util, os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.argv = [sys.argv[0], "0"]                       # keep eval_format from parsing our args
spec = importlib.util.spec_from_file_location("ev", os.path.join(HERE, "eval_format.py"))
ev = importlib.util.module_from_spec(spec); spec.loader.exec_module(ev)
CHK = {c["name"]: c["check"] for c in ev.CASES}

tags = [a for a in os.environ.get("TAGS", "sft1_base,sft1_t0,sft1_think").split(",") if a]
tot = {}
for tag in tags:
    p = os.path.join(HERE, f"eval_{tag}.jsonl")
    if not os.path.exists(p): p = os.path.join(HERE, "eval_runs", f"eval_{tag}.jsonl")
    if not os.path.exists(p): continue
    agg = collections.defaultdict(collections.Counter)
    for l in open(p, encoding="utf-8"):
        r = json.loads(l)
        chk = CHK[r["case"]]
        n = chk(r["calls"], r.get("text", ""))
        s = chk([r["struct_call"]] if r.get("struct_call") else r["calls"], r.get("text", "")) if not r["calls"] else n
        a = agg[r["case"]]
        a["n"] += 1; a["called"] += int(bool(r["calls"])); a["ok"] += int(bool(n["ok"])); a["struct"] += int(bool(s["ok"]))
        a["core"] += int(bool(s.get("chain", s["ok"]))); a["sec"] += r.get("s_native", 0) + r.get("s_struct", 0)
    tot[tag] = agg
cases = [c["name"] for c in ev.CASES]
print(f"{'case':<20}" + "".join(f"{t:>22}" for t in tot))
for c in cases:
    row = f"{c:<20}"
    for t, agg in tot.items():
        a = agg.get(c)
        row += f"{(str(a['struct'])+'/'+str(a['n'])+'  core '+str(a['core'])) if a else '-':>22}"
    print(row)
row = f"{'TOTAL':<20}"
for t, agg in tot.items():
    S = sum(a["struct"] for a in agg.values()); N = sum(a["n"] for a in agg.values())
    C = sum(a["called"] for a in agg.values()); sec = sum(a["sec"] for a in agg.values())
    row += f"{f'{S}/{N} ({100*S//max(1,N)}%) call {C} {sec/max(1,N):.1f}s':>22}"
print(row)
