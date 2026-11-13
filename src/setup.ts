// `pplx setup`: register this server with the MCP clients found on this machine, then sign in.
// Existing entries are never changed, so running it again is safe.

import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAME = "perplexity-session";
const PACKAGE_NAME = "perplexity-session-mcp";
const isWindows = process.platform === "win32";

export interface LaunchSpec {
  command: string;
  args: string[];
}

export type SetupStatus = "added" | "exists" | "skipped" | "failed" | "would-add";

export interface SetupResult {
  client: string;
  status: SetupStatus;
  detail: string;
}

/**
 * How clients should start the server. Normally the absolute node binary plus this package's
 * bin/pplx.js, which needs no PATH lookup and no `cmd /c` on Windows. When setup itself runs from
 * the throwaway npx cache, register `npx -y perplexity-session-mcp@latest` instead.
 */
export function launchSpec(scriptPath = realpathSync(fileURLToPath(new URL("../bin/pplx.js", import.meta.url)))): LaunchSpec {
  if (/[\\/]_npx[\\/]/.test(scriptPath)) {
    const npx = ["-y", `${PACKAGE_NAME}@latest`];
    return isWindows ? { command: "cmd", args: ["/c", "npx", ...npx] } : { command: "npx", args: npx };
  }
  return { command: process.execPath, args: [scriptPath] };
}

/** Append a `[mcp_servers.perplexity-session]` table to Codex's config.toml unless one is there. */
export function addToCodexConfig(file: string, spec: LaunchSpec, dryRun = false): SetupResult {
  const client = "Codex";
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (new RegExp(`^\\s*\\[mcp_servers\\.(${SERVER_NAME}|"${SERVER_NAME}")\\]`, "m").test(text)) {
    return { client, status: "exists", detail: `${file} already has [mcp_servers.${SERVER_NAME}]` };
  }
  if (dryRun) return { client, status: "would-add", detail: file };
  // JSON strings are valid TOML basic strings (same escapes for quotes, backslashes, and \uXXXX).
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(spec.command)}`,
    `args = [${spec.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 3700",
  ].join("\n");
  const sep = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  appendFileSync(file, `${sep}${block}\n`);
  return { client, status: "added", detail: file };
}

/** Add an `mcpServers` entry to a JSON config (Cursor, Claude Desktop) unless one is there. */
export function addToJsonConfig(client: string, file: string, spec: LaunchSpec, dryRun = false): SetupResult {
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    try {
      config = raw.trim() === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
    } catch (err) {
      return { client, status: "failed", detail: `${file} is not valid JSON (${(err as Error).message}); left unchanged` };
    }
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || Array.isArray(servers)) {
    return { client, status: "failed", detail: `${file}: "mcpServers" is not an object; left unchanged` };
  }
  if (SERVER_NAME in servers) return { client, status: "exists", detail: `${file} already has "${SERVER_NAME}"` };
  if (dryRun) return { client, status: "would-add", detail: file };
  const hadFile = existsSync(file);
  if (hadFile) copyFileSync(file, `${file}.bak`);
  config.mcpServers = { ...servers, [SERVER_NAME]: { command: spec.command, args: spec.args } };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return { client, status: "added", detail: hadFile ? `${file} (backup: ${file}.bak)` : file };
}

/** Quote one argument for cmd.exe (spawn with `shell: true` joins arguments with spaces). */
function cmdQuote(arg: string): string {
  return /^[\w./:\\=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** Run the `claude` CLI. On Windows it is often a .cmd shim, which only a shell can start. */
function runClaude(args: string[]) {
  const opts = { encoding: "utf8" as const, timeout: 60_000 };
  return isWindows ? spawnSync(`claude ${args.map(cmdQuote).join(" ")}`, { ...opts, shell: true }) : spawnSync("claude", args, opts);
}

/** Register with Claude Code through its own CLI (`claude mcp add -s user`). */
export function addToClaudeCode(spec: LaunchSpec, dryRun = false): SetupResult {
  const client = "Claude Code";
  const args = ["mcp", "add", SERVER_NAME, "-s", "user", "--", spec.command, ...spec.args];
  const shown = `claude ${args.map(cmdQuote).join(" ")}`;
  const probe = runClaude(["--version"]);
  if (probe.error || probe.status !== 0) return { client, status: "skipped", detail: "`claude` command not found" };
  const existing = `already registered (see: claude mcp get ${SERVER_NAME})`;
  if (runClaude(["mcp", "get", SERVER_NAME]).status === 0) return { client, status: "exists", detail: existing };
  if (dryRun) return { client, status: "would-add", detail: shown };
  const run = runClaude(args);
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  if (/already exists/i.test(output)) return { client, status: "exists", detail: existing };
  if (run.error || run.status !== 0) {
    return { client, status: "failed", detail: `${output || run.error?.message || "unknown error"} — run it yourself: ${shown}` };
  }
  return { client, status: "added", detail: "user scope (all projects)" };
}

function claudeDesktopDir(): string {
  if (isWindows) return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Claude");
}

/** Register with every client that looks installed: its config folder exists (or its CLI runs, for Claude Code). */
export function registerClients(spec: LaunchSpec, dryRun = false): SetupResult[] {
  const results: SetupResult[] = [addToClaudeCode(spec, dryRun)];

  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  results.push(
    existsSync(codexHome)
      ? addToCodexConfig(join(codexHome, "config.toml"), spec, dryRun)
      : { client: "Codex", status: "skipped", detail: `${codexHome} not found` },
  );

  for (const [client, file] of [
    ["Cursor", join(homedir(), ".cursor", "mcp.json")],
    ["Claude Desktop", join(claudeDesktopDir(), "claude_desktop_config.json")],
  ] as const) {
    results.push(
      existsSync(dirname(file))
        ? addToJsonConfig(client, file, spec, dryRun)
        : { client, status: "skipped", detail: `${dirname(file)} not found` },
    );
  }
  return results;
}

export function formatResults(results: SetupResult[]): string {
  const mark: Record<SetupStatus, string> = {
    added: "added    ",
    exists: "kept     ",
    skipped: "skipped  ",
    failed: "FAILED   ",
    "would-add": "would add",
  };
  return results.map((r) => `  ${mark[r.status]}  ${r.client.padEnd(15)} ${r.detail}`).join("\n");
}
