import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore, makeSnippet, parseTerms } from "../src/history.ts";

function store(): { s: HistoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pplx-history-"));
  return { s: new HistoryStore(dir), dir };
}

function add(s: HistoryStore, query: string, answer: string, kind: "search" | "research" = "search") {
  return s.add({
    kind,
    query,
    model: "pplx_pro",
    mode: "copilot",
    threadSlug: null,
    threadUrl: null,
    answer,
    sources: [{ title: "Example source", url: "https://example.com/a" }],
    relatedQuestions: [],
    steps: [],
    backendUuid: "b",
    readWriteToken: "rw",
    parentId: null,
  });
}

test("parseTerms keeps quoted phrases and lowercases", () => {
  assert.deepEqual(parseTerms('Unity "Addressables 캐시" GC'), ["unity", "addressables 캐시", "gc"]);
});

test("add writes entry, markdown mirror and index", () => {
  const { s, dir } = store();
  try {
    const e = add(s, "What is MCP?", "MCP is the Model Context Protocol.");
    assert.ok(existsSync(join(dir, "entries", `${e.id}.json`)));
    assert.match(readFileSync(s.markdownPath(e.id), "utf8"), /Model Context Protocol/);
    assert.equal(s.get(e.id)?.answer, "MCP is the Model Context Protocol.");
    assert.equal(s.list().total, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search matches Korean substrings with particles and ranks query hits higher", () => {
  const { s, dir } = store();
  try {
    const a = add(s, "퍼플렉시티 딥리서치 사용법", "딥리서치는 여러 검색을 수행합니다.", "research");
    add(s, "날씨", "오늘 서울 날씨는 맑습니다. 퍼플렉시티에서 검색했습니다.");
    const res = s.search({ query: "퍼플렉시티" });
    assert.equal(res.matchMode, "all");
    assert.equal(res.total, 2);
    assert.equal(res.hits[0].meta.id, a.id);
    const research = s.search({ query: "퍼플렉시티", kind: "research" });
    assert.equal(research.total, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search requires all terms, then falls back to any", () => {
  const { s, dir } = store();
  try {
    add(s, "rust async", "Tokio runtime details");
    add(s, "go channels", "goroutines and channels");
    assert.equal(s.search({ query: "tokio goroutines" }).matchMode, "any");
    const all = s.search({ query: "rust tokio" });
    assert.equal(all.matchMode, "all");
    assert.equal(all.total, 1);
    assert.equal(s.search({ query: "" }).matchMode, "recent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second store instance sees entries appended by another", () => {
  const { s, dir } = store();
  try {
    const other = new HistoryStore(dir);
    assert.equal(other.list().total, 0);
    add(s, "shared index", "visible across processes");
    assert.equal(other.search({ query: "visible" }).total, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeSnippet centers on the first hit", () => {
  const text = "x".repeat(500) + " needle here " + "y".repeat(500);
  const snip = makeSnippet(text, ["needle"], 20);
  assert.match(snip, /^….*needle here.*…$/);
});
