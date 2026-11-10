// Every MCP tool, called through a real MCP client over an in-memory transport.
// The data folder is a scratch directory with no saved session, so nothing here opens a
// browser or reaches perplexity.ai: tools that need the account must answer with a login
// hint, and perplexity_login runs against a stub.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// config.ts reads PPLX_MCP_HOME when first imported, so set it before loading the server.
// The logout tests delete files in the data folder: refuse to run against the real one.
const home = mkdtempSync(join(tmpdir(), "pplx-tools-"));
process.env.PPLX_MCP_HOME = home;
const { paths } = await import("../src/config.ts");
assert.equal(paths.dataDir, home, "tests must run against a scratch data folder");
const { createServer } = await import("../src/server.ts");
const { Service } = await import("../src/service.ts");

const svc = new Service();
const loginCalls: number[] = [];
svc.login = async (timeoutSeconds) => {
  loginCalls.push(timeoutSeconds);
  return "Logged in (stub).";
};
const server = createServer(svc);
const client = new Client({ name: "tools-test", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

after(async () => {
  await client.close();
  await svc.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text?: string }[];
  return { text: content.map((c) => c.text ?? "").join("\n"), isError: res.isError === true };
}

function seed(query: string, answer: string, kind: "search" | "research" = "search") {
  return svc.history.add({
    kind,
    query,
    model: "pplx_pro",
    mode: kind === "research" ? "research" : "copilot",
    threadSlug: null,
    threadUrl: null,
    answer,
    sources: [{ title: "Example source", url: "https://example.com/a" }],
    relatedQuestions: [],
    steps: [],
    backendUuid: "b-1",
    readWriteToken: null,
    parentId: null,
  });
}

type Hints = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };

/** What each handler actually does, as MCP hints. A new tool needs a row here. */
const HINTS: Record<string, Hints> = {
  // Opens a browser window and saves a fresh session on every call.
  perplexity_login: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // Deletes local files only; a second call finds nothing left to delete.
  perplexity_logout: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  perplexity_account: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  perplexity_models: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Each call makes a new Perplexity thread and history entry and spends quota.
  perplexity_search: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  perplexity_research: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // May save a recovered report to history, never twice.
  perplexity_research_status: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  perplexity_history_search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  perplexity_history_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  perplexity_library_search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Saves the thread to history unless the same version is already there.
  perplexity_thread_get: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

test("tools/list: every tool states all four hints, matching what it does", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(HINTS).sort());
  for (const t of tools) {
    const a = t.annotations ?? {};
    const hints = {
      readOnlyHint: a.readOnlyHint,
      destructiveHint: a.destructiveHint,
      idempotentHint: a.idempotentHint,
      openWorldHint: a.openWorldHint,
    };
    assert.deepEqual(hints, HINTS[t.name], t.name);
  }
});

test("perplexity_login: waits 300 s by default and checks the timeout before opening anything", async () => {
  const res = await call("perplexity_login");
  assert.equal(res.isError, false);
  assert.equal(res.text, "Logged in (stub).");
  await call("perplexity_login", { timeout_seconds: 60 });
  assert.deepEqual(loginCalls, [300, 60]);

  const tooShort = await call("perplexity_login", { timeout_seconds: 5 });
  assert.equal(tooShort.isError, true);
  assert.match(tooShort.text, /Input validation error/);
  assert.deepEqual(loginCalls, [300, 60]);
});

test("perplexity_account: without a saved session says so and names the data folder", async () => {
  const res = await call("perplexity_account");
  assert.equal(res.isError, false);
  assert.match(res.text, /^Not logged in\. Call perplexity_login/);
  assert.ok(res.text.includes(home), res.text);
});

const needsAccount: [string, Record<string, unknown>][] = [
  ["perplexity_search", { query: "What is MCP?" }],
  ["perplexity_research", { query: "MCP adoption in 2026", wait_seconds: 0 }],
  ["perplexity_models", {}],
  ["perplexity_library_search", { query: "mcp" }],
  ["perplexity_thread_get", { slug: "some-thread-slug" }],
];

for (const [name, args] of needsAccount) {
  test(`${name}: without a saved session points to perplexity_login`, async () => {
    const res = await call(name, args);
    assert.equal(res.isError, true);
    assert.match(res.text, /^Not logged in to Perplexity\. Call the perplexity_login tool/);
  });
}

test("perplexity_search: rejects an empty query", async () => {
  const res = await call("perplexity_search", { query: "" });
  assert.equal(res.isError, true);
  assert.match(res.text, /Input validation error/);
});

test("perplexity_research: did not leave a job behind when it could not start", async () => {
  const res = await call("perplexity_research_status");
  assert.equal(res.isError, false);
  assert.match(res.text, /^No research jobs yet\./);
});

test("perplexity_history_search: finds saved answers by their text", async () => {
  const e = seed("Model Context Protocol 소개", "MCP는 AI 앱에 도구를 연결하는 표준입니다.");
  const hit = await call("perplexity_history_search", { query: "표준" });
  assert.equal(hit.isError, false);
  assert.ok(hit.text.includes(e.id), hit.text);

  const miss = await call("perplexity_history_search", { query: "zzqqxx" });
  assert.equal(miss.isError, false);
  assert.ok(!miss.text.includes(e.id), miss.text);
});

test("perplexity_history_get: returns the answer, its sources, or an error for an unknown id", async () => {
  const e = seed("history get question", "The full saved answer [1].");
  const full = await call("perplexity_history_get", { id: e.id });
  assert.equal(full.isError, false);
  assert.match(full.text, /The full saved answer/);

  const sources = await call("perplexity_history_get", { id: e.id, sources_only: true });
  assert.equal(sources.isError, false);
  assert.match(sources.text, /https:\/\/example\.com\/a/);

  const missing = await call("perplexity_history_get", { id: "no-such-id" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /No saved answer with id "no-such-id"/);
});

test("perplexity_research_status: rejects unknown jobs and returns a finished job's report from disk", async () => {
  const unknown = await call("perplexity_research_status", { job_id: "research-20000101000000-0000" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown research job/);

  // A job finished by an earlier server process: only its job file and history entry remain.
  const entry = seed("deep research question", "# Report\n\nThe long report body.", "research");
  const job = {
    id: "research-20261110090000-abcd",
    query: "deep research question",
    status: "completed",
    startedAt: "2026-11-10T00:00:00.000Z",
    finishedAt: "2026-11-10T00:05:00.000Z",
    steps: [],
    sourceCount: 1,
    answerChars: entry.answerChars,
    historyId: entry.id,
    pid: 1,
  };
  mkdirSync(paths.jobsDir, { recursive: true });
  writeFileSync(join(paths.jobsDir, `${job.id}.json`), JSON.stringify(job));

  const list = await call("perplexity_research_status");
  assert.ok(list.text.includes(job.id), list.text);
  assert.ok(list.text.includes(entry.id), list.text);

  const report = await call("perplexity_research_status", { job_id: job.id });
  assert.equal(report.isError, false);
  assert.match(report.text, /Deep research completed in 5m00s · 1 sources/);
  assert.match(report.text, /The long report body/);
});

test("perplexity_logout: removes the saved session, and a second call changes nothing", async () => {
  writeFileSync(paths.sessionFile, "{}");
  writeFileSync(paths.accountCache, "{}");
  const first = await call("perplexity_logout");
  assert.equal(first.isError, false);
  assert.equal(first.text, "Saved session removed.");
  assert.equal(existsSync(paths.sessionFile), false);
  assert.equal(existsSync(paths.accountCache), false);

  const again = await call("perplexity_logout");
  assert.equal(again.isError, false);
  assert.equal(again.text, "No saved session to remove.");
});

test("perplexity_logout: wipe_browser_profile also deletes the login profile and the key", async () => {
  mkdirSync(join(paths.loginProfile, "Default"), { recursive: true });
  writeFileSync(paths.keyFile, "{}");
  const res = await call("perplexity_logout", { wipe_browser_profile: true });
  assert.equal(res.isError, false);
  assert.equal(existsSync(paths.loginProfile), false);
  assert.equal(existsSync(paths.keyFile), false);
});
