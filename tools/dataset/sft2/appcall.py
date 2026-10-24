"""Call the FPGA Ecosystem tools for real (through its MCP server) and hand back what the in-app
agent would put in the tool message: JSON.stringify(result) clipped to 6000 chars, or 'ERROR: ...'."""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcpcli import MCP  # noqa: E402


class App:
    def __init__(self):
        self.m = MCP()
        self.m.request("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                      "clientInfo": {"name": "sft2-gen", "version": "1"}})
        self.m.notify("notifications/initialized")

    def raw(self, name, args, timeout=300):
        r = self.m.request("tools/call", {"name": name, "arguments": args}, timeout=timeout)
        if "error" in r:
            return False, str(r["error"].get("message") or r["error"]), None
        res = r.get("result") or {}
        txt = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        if res.get("isError"):
            return False, txt, None
        try:
            obj = json.loads(txt)
        except Exception:
            obj = txt
        return True, txt, obj

    def call(self, name, args, timeout=300):
        """-> (ok, content_for_model, result_obj)"""
        ok, txt, obj = self.raw(name, args, timeout)
        if not ok:
            return False, "ERROR: " + txt, None
        s = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) if not isinstance(obj, str) else obj
        if len(s) > 6000:
            s = s[:6000] + " …"
        return True, s, obj

    def close(self):
        self.m.close()


if __name__ == "__main__":
    a = App()
    name = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    print(a.call(name, args)[1][:3000])
    a.close()
