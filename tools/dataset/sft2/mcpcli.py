"""Minimal MCP stdio client to drive FPGAEcosystem-MCP.exe from the shell."""
import json, subprocess, sys, threading, time, os

EXE = r"C:\Users\dinuc\AppData\Local\Programs\FPGA Ecosystem\FPGAEcosystem-MCP.exe"
HERE = os.path.dirname(os.path.abspath(__file__))


def _command():
    """the installed app's MCP server (Windows), or — with FE_APP_ENV=<env.json from serve_app.js> — this
    repo's launcher/mcp_server.py talking to the private app serve_app.js started (Linux / CI)"""
    envf = os.environ.get("FE_APP_ENV")
    if envf:
        e = json.load(open(envf, encoding="utf-8"))
        return [sys.executable, os.path.join(HERE, "..", "..", "..", "launcher", "mcp_server.py")], dict(os.environ, **e["env"])
    return [os.environ.get("FE_MCP_EXE", EXE)], None


class MCP:
    def __init__(self, exe=None):
        cmd, env = ([exe], None) if exe else _command()
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, bufsize=0, env=env)
        self._id = 0
        self._buf = b""

    def _send(self, obj):
        data = (json.dumps(obj) + "\n").encode("utf-8")
        self.p.stdin.write(data); self.p.stdin.flush()

    def _readline(self, timeout=120):
        # read one line of JSON from stdout
        end = time.time() + timeout
        while b"\n" not in self._buf:
            if time.time() > end:
                raise TimeoutError("no response")
            chunk = self.p.stdout.read1(65536) if hasattr(self.p.stdout, "read1") else self.p.stdout.read(1)
            if not chunk:
                time.sleep(0.02); continue
            self._buf += chunk
        line, self._buf = self._buf.split(b"\n", 1)
        return line.decode("utf-8", "replace")

    def request(self, method, params=None, timeout=180):
        self._id += 1
        rid = self._id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        while True:
            line = self._readline(timeout).strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                # not JSON (maybe a log line) -> skip
                continue
            if msg.get("id") == rid:
                return msg

    def notify(self, method, params=None):
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def close(self):
        try:
            self.p.stdin.close(); self.p.terminate()
        except Exception:
            pass


def main():
    m = MCP()
    init = m.request("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "claude-cli", "version": "0.1"}
    })
    print("=== initialize ===")
    print(json.dumps(init.get("result", init), ensure_ascii=False)[:800])
    m.notify("notifications/initialized")
    tl = m.request("tools/list")
    tools = tl.get("result", {}).get("tools", [])
    print(f"\n=== tools/list ({len(tools)}) ===")
    for t in tools:
        print(f"- {t['name']}: {t.get('description','')[:90]}")
    # dump full schema to file for later
    with open(os.path.join(os.path.dirname(__file__), "tools.json"), "w", encoding="utf-8") as f:
        json.dump(tools, f, ensure_ascii=False, indent=2)
    m.close()

if __name__ == "__main__":
    main()
