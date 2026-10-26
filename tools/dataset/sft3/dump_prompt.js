// The agent's system prompt as the app builds it, without the project line the app appends per run.
//   node dump_prompt.js <path to schematic&bus2vhdl.html> <out sysprompt.txt>   (run from the repo, playwright installed)
const { chromium } = require("playwright"); const fs=require("fs");
(async()=>{ const b=await chromium.launch(); const p=await b.newPage();
 await p.goto("file://"+process.argv[2]); await p.waitForFunction(()=>typeof aiagSystemPrompt==="function");
 fs.writeFileSync(process.argv[3], (await p.evaluate(()=>aiagSystemPrompt())).replace(/\n\nProject: [^\n]*$/, "")+"\n"); await b.close(); })();
