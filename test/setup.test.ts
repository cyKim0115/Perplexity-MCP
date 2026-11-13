import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCodexConfig, addToJsonConfig, launchSpec, type LaunchSpec } from "../src/setup.ts";

const spec: LaunchSpec = { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\me\\pplx\\bin\\pplx.js"] };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pplx-setup-"));
}

test("launchSpec: absolute node + script normally, npx@latest from the npx cache", () => {
  assert.deepEqual(launchSpec("/usr/lib/node_modules/perplexity-session-mcp/bin/pplx.js"), {
    command: process.execPath,
    args: ["/usr/lib/node_modules/perplexity-session-mcp/bin/pplx.js"],
  });
  const npx = launchSpec("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\perplexity-session-mcp\\bin\\pplx.js");
  assert.deepEqual(npx.args.slice(-2), ["-y", "perplexity-session-mcp@latest"]);
  assert.equal(npx.command, process.platform === "win32" ? "cmd" : "npx");
});

test("addToCodexConfig: appends a parseable table once, keeps the rest of the file", () => {
  const file = join(scratch(), "config.toml");
  writeFileSync(file, 'model = "gpt-5"\n[mcp_servers.other]\ncommand = "x"');
  assert.equal(addToCodexConfig(file, spec, true).status, "would-add");
  assert.equal(readFileSync(file, "utf8"), 'model = "gpt-5"\n[mcp_servers.other]\ncommand = "x"');

  assert.equal(addToCodexConfig(file, spec).status, "added");
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith('model = "gpt-5"\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.perplexity-session]\n'));
  assert.ok(text.includes('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"'));
  assert.ok(text.includes('args = ["C:\\\\Users\\\\me\\\\pplx\\\\bin\\\\pplx.js"]'));
  assert.ok(text.includes("tool_timeout_sec = 3700"));

  assert.equal(addToCodexConfig(file, spec).status, "exists");
  assert.equal(readFileSync(file, "utf8"), text);
});

test("addToCodexConfig: creates the file when Codex has none yet", () => {
  const file = join(scratch(), "config.toml");
  assert.equal(addToCodexConfig(file, spec).status, "added");
  assert.ok(readFileSync(file, "utf8").startsWith("[mcp_servers.perplexity-session]\n"));
});

test("addToJsonConfig: adds the server next to existing ones and keeps a backup", () => {
  const file = join(scratch(), "mcp.json");
  const before = { theme: "dark", mcpServers: { other: { command: "x", args: [] } } };
  writeFileSync(file, JSON.stringify(before));
  assert.equal(addToJsonConfig("Cursor", file, spec, true).status, "would-add");
  assert.equal(existsSync(`${file}.bak`), false);

  assert.equal(addToJsonConfig("Cursor", file, spec).status, "added");
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.mcpServers.other, before.mcpServers.other);
  assert.deepEqual(after.mcpServers["perplexity-session"], { command: spec.command, args: spec.args });
  assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, "utf8")), before);

  assert.equal(addToJsonConfig("Cursor", file, spec).status, "exists");
});

test("addToJsonConfig: creates a missing file, refuses to touch invalid JSON", () => {
  const dir = scratch();
  const fresh = join(dir, "claude_desktop_config.json");
  assert.equal(addToJsonConfig("Claude Desktop", fresh, spec).status, "added");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(fresh, "utf8")).mcpServers), ["perplexity-session"]);
  assert.equal(existsSync(`${fresh}.bak`), false);

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json");
  assert.equal(addToJsonConfig("Cursor", broken, spec).status, "failed");
  assert.equal(readFileSync(broken, "utf8"), "{ not json");
});
