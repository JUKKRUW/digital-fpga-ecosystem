// A private copy of the app for data generation on Linux / CI: the launcher (own home folder) +
// the editor open in headless Chromium, so MCP tools run exactly as for a user.
//   node tools/dataset/sft2/serve_app.js <env.json>     (writes the env to give mcp_server.py, keeps running)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.resolve(__dirname, "..", "..", "..");
const PORT = 19900 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fe-sft-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  const app = spawn(process.env.PY || "python3", [path.join(ROOT, "launcher", "app.py"), "--no-open", "--port", String(PORT)], { env, stdio: "ignore" });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + "/api/info")).ok) break; } catch (_) {} await new Promise(r => setTimeout(r, 250)); }
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on("dialog", d => d.accept().catch(() => {}));
  await page.goto(BASE + "/studio.html");
  await page.waitForFunction(() => typeof MCP_OPS === "object");
  await page.evaluate(() => document.querySelectorAll(".modal-bg").forEach(m => m.remove()));
  const keep = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA", "NO_PROXY", "no_proxy"];
  fs.writeFileSync(process.argv[2] || "app_env.json", JSON.stringify({ base: BASE, env: Object.fromEntries(keep.map(k => [k, env[k]])) }));
  console.log("ready", BASE);
  const stop = async () => { try { await browser.close(); } catch (_) {} app.kill(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  setInterval(() => page.evaluate(() => document.querySelectorAll(".modal-bg").forEach(m => m.remove())).catch(() => {}), 2000);
})();
