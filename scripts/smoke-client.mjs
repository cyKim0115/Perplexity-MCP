// Drive the MCP server over stdio like a real client: list tools, then call the ones given.
// Usage: node scripts/smoke-client.mjs '[["tool", {args}], ...]'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const calls = JSON.parse(process.argv[2] ?? "[]");
const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "serve"], stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
const { resourceTemplates } = await client.listResourceTemplates();
console.log(`resource templates: ${resourceTemplates.map((r) => r.uriTemplate).join(", ")}`);
for (const [name, args] of calls) {
  const started = Date.now();
  const res = await client.callTool(
    { name, arguments: args },
    undefined,
    {
      timeout: 60 * 60_000,
      resetTimeoutOnProgress: true,
      onprogress: (p) => console.log(`  [progress ${name}] ${p.message ?? p.progress}`),
    },
  );
  const text = res.content.map((c) => c.text ?? "").join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${((Date.now() - started) / 1000).toFixed(1)}s)${res.isError ? " ERROR" : ""}\n${text}`);
}
await client.close();
