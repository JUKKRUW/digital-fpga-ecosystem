"""Agent runs logged by the app (agent-runs/*.jsonl, v2.7.0+) + the user's 👍 / 👎 (agent-runs/ratings.jsonl)
→ rows in the SFT2 / SFT3 format, and a list of 👎 runs to look at by hand.

  python3 from_logs.py <agent-runs folder> [--out logs_good.jsonl] [--bad logs_bad.jsonl]

Windows: the folder is %APPDATA%\\FPGA Ecosystem\\agent-runs.

Kept as training rows (logs_good.jsonl): runs rated 👍, state "done", with the full `messages` (v2.7.0 logs them),
whose final answer the app did not flag (no ⚠ — those are answers the app caught as unchecked / contradicting
the tools). Per row: the system prompt is replaced by the current one (sysprompt.txt of this round), tool-call
arguments become objects, assistant turns before an app nudge ("(system) …" user message) get weight 0 — what
the model did wrong there is context, not a target — and the last assistant answer is the target.

logs_bad.jsonl: runs rated 👎 with the user's note, the request and every step — fix the answer by hand (or let
a generator family cover that kind of request), never train on them as they are.
"""
import argparse, json, os, glob

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("folder")
ap.add_argument("--out", default=os.path.join(HERE, "logs_good.jsonl"))
ap.add_argument("--bad", default=os.path.join(HERE, "logs_bad.jsonl"))
ap.add_argument("--sysprompt", default=os.path.join(HERE, "sysprompt.txt"))
a = ap.parse_args()

SYS = open(a.sysprompt, encoding="utf-8").read().rstrip("\n") if os.path.exists(a.sysprompt) else None
runs = {}
for f in sorted(glob.glob(os.path.join(a.folder, "*.jsonl"))):
    if os.path.basename(f) == "ratings.jsonl":
        continue
    for line in open(f, encoding="utf-8"):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("uid"):
            runs[r["uid"]] = r
rating = {}
rp = os.path.join(a.folder, "ratings.jsonl")
if os.path.exists(rp):
    for line in open(rp, encoding="utf-8"):
        try:
            x = json.loads(line)
        except ValueError:
            continue
        rating[x["uid"]] = x                          # the last click wins


def to_row(run):
    msgs = []
    for m in run["messages"]:
        m = {k: v for k, v in m.items() if k in ("role", "content", "tool_calls", "tool_call_id", "name")}
        if m["role"] == "system" and SYS:
            m["content"] = SYS
        for tc in m.get("tool_calls") or []:
            f = tc.get("function") or {}
            if isinstance(f.get("arguments"), str):
                try:
                    f["arguments"] = json.loads(f["arguments"] or "{}")
                except ValueError:
                    return None                      # a call the app could not read: not a target
        msgs.append(m)
    # an assistant turn the app answered with a nudge was not what we want: context only
    for i, m in enumerate(msgs):
        if m["role"] != "assistant":
            continue
        nxt = next((x for x in msgs[i + 1:] if x["role"] != "tool"), None)
        if nxt and nxt["role"] == "user" and str(nxt.get("content", "")).startswith("(system)"):
            m["weight"] = 0
    while msgs and msgs[-1]["role"] != "assistant":
        msgs.pop()
    if not msgs or msgs[-1].get("tool_calls"):
        return None
    return {"messages": msgs, "source": "user_log", "uid": run["uid"], "model": run.get("model")}


good = bad = skipped = 0
with open(a.out, "w", encoding="utf-8") as fo, open(a.bad, "w", encoding="utf-8") as fb:
    for uid, rt in rating.items():
        run = runs.get(uid)
        if not run:
            skipped += 1
            continue
        if rt["rating"] < 0:
            fb.write(json.dumps({"uid": uid, "note": rt.get("note"), "message": run.get("message"), "final": run.get("final"),
                                 "steps": run.get("steps"), "model": run.get("model")}, ensure_ascii=False) + "\n")
            bad += 1
            continue
        if run.get("state") != "done" or str(run.get("final") or "").startswith("⚠") or not run.get("messages"):
            skipped += 1
            continue
        row = to_row(run)
        if row:
            fo.write(json.dumps(row, ensure_ascii=False) + "\n")
            good += 1
        else:
            skipped += 1
print(f"runs {len(runs)} · rated {len(rating)} · 👍 rows {good} → {a.out} · 👎 {bad} → {a.bad} · skipped {skipped}")
