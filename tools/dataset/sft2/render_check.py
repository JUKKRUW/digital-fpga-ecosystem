import json, glob, sys
import jinja2
from train_sft2 import prep_messages
env = jinja2.Environment(trim_blocks=True, lstrip_blocks=True, extensions=["jinja2.ext.loopcontrols"])
def rexc(m): raise ValueError(m)
env.globals["raise_exception"] = rexc
env.filters["tojson"] = lambda x, indent=None, ensure_ascii=False: json.dumps(x, ensure_ascii=ensure_ascii, indent=indent)
T = env.from_string(open("chat_template.jinja", encoding="utf-8").read())
R = lambda m, t, g=False: T.render(messages=m, tools=t, add_generation_prompt=g, enable_thinking=False)
bad = n = trained = masked = 0
files = sys.argv[1:] or glob.glob("test_*.jsonl")
for path in files:
    for l in open(path, encoding="utf-8"):
        r = json.loads(l); m = prep_messages(r["messages"]); n += 1
        full = R(m, r["tools"])
        for i, x in enumerate(m):
            if x["role"] != "assistant": continue
            if x.get("weight", 1) == 0: masked += 1; continue
            p, f = R(m[:i], r["tools"], True), R(m[:i + 1], r["tools"])
            if not (f.startswith(p) and full.startswith(f)): bad += 1
            else: trained += 1
print(f"rows {n} · trained assistant turns {trained} · masked (weight 0) {masked} · prefix problems {bad}")
r = json.loads(open(files[0], encoding="utf-8").readline())
full = R(prep_messages(r["messages"]), r["tools"])
i = full.find("<tool_call>"); print(full[i:i+500])
print("Python-style True in text:", "\nTrue\n" in full, "· JSON true present:", "\ntrue\n" in full or "true" in full)
