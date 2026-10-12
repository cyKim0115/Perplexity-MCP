// Re-parse a raw SSE capture (PPLX_DEBUG=1 saves them under ~/.perplexity-session-mcp/debug).
// Usage: node scripts/parse-sse.ts <file.sse>
import { readFileSync } from "node:fs";
import { parseSse } from "../src/sse.ts";

const r = parseSse(readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify({ ...r, answer: undefined, sources: r.sources.length, steps: r.steps.slice(0, 15) }, null, 1));
console.log("--- answer (%d chars) ---\n%s", r.answer.length, r.answer.slice(0, 1500));
console.log("--- first sources ---");
for (const s of r.sources.slice(0, 5)) console.log(`- ${s.title} ${s.url}`);
