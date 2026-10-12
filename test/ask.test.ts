import { test } from "node:test";
import assert from "node:assert/strict";
import { ask } from "../src/perplexity.ts";
import { StreamInterruptedError } from "../src/errors.ts";

function ev(obj: unknown): string {
  return `event: message\r\ndata: ${JSON.stringify(obj)}\r\n\r\n`;
}

const meta = { backend_uuid: "b-1", thread_url_slug: "slug-1", read_write_token: "rw", display_model: "pplx_alpha" };

/**
 * A stand-in for a patchright Page: `ask` starts the in-page fetch, polls chunks, cleans up,
 * and (when the stream is cut) reads the thread through pageFetch. Calls are told apart by
 * their argument shape.
 */
function fakePage(chunks: { text: string; done?: boolean; error?: string | null; status?: number }[], threadReplies: any[]) {
  const calls = { polls: 0, threadFetches: 0 };
  const page = {
    async evaluate(_fn: unknown, arg: any) {
      if (arg && typeof arg === "object" && "body" in arg && "id" in arg) return undefined; // start
      if (arg && typeof arg === "object" && "url" in arg) {
        calls.threadFetches++;
        const json = threadReplies[Math.min(calls.threadFetches - 1, threadReplies.length - 1)];
        return { status: 200, contentType: "application/json", json, text: "" };
      }
      if (typeof arg === "string") {
        if (calls.polls < chunks.length) {
          const c = chunks[calls.polls++];
          return { text: c.text, done: !!c.done, error: c.error ?? null, status: c.status ?? 200 };
        }
        return undefined; // cleanup
      }
      throw new Error(`unexpected evaluate arg ${JSON.stringify(arg)}`);
    },
  };
  return { page: page as any, calls };
}

const opts = { query: "q", mode: "copilot" as const, model: "pplx_alpha", sources: ["web"], language: "en-US" };

test("a cut stream is settled from the thread entry instead of returned half-done", async () => {
  const { page, calls } = fakePage(
    [
      { text: ev({ ...meta, status: "PENDING", blocks: [{ intended_usage: "ask_text", markdown_block: { chunks: ["half"] } }] }) },
      { text: "", done: true, error: "network error" },
    ],
    [
      { entries: [{ backend_uuid: "b-1", status: "PENDING", query_str: "q", blocks: [] }], has_next_page: false },
      {
        entries: [
          {
            backend_uuid: "b-1",
            status: "completed",
            query_str: "q",
            read_write_token: "rw",
            blocks: [{ intended_usage: "ask_text", markdown_block: { answer: "Full answer [1]." } }],
          },
        ],
        has_next_page: false,
      },
    ],
  );
  const r = await ask(page, { ...opts, timeoutMs: 60_000 });
  assert.equal(r.answer, "Full answer [1].");
  assert.equal(r.complete, true);
  assert.equal(r.threadSlug, "slug-1");
  assert.equal(calls.threadFetches, 2);
});

test("a timed-out stream throws StreamInterruptedError carrying the thread identity", async () => {
  const pending = { text: ev({ ...meta, status: "PENDING", blocks: [] }) };
  const { page } = fakePage([pending, ...Array.from({ length: 50 }, () => ({ text: "" }))], []);
  await assert.rejects(
    () => ask(page, { ...opts, timeoutMs: 1200 }),
    (err: unknown) => err instanceof StreamInterruptedError && err.threadSlug === "slug-1" && err.backendUuid === "b-1",
  );
});

test("a rejected request without a thread surfaces the HTTP error", async () => {
  const { page } = fakePage([{ text: "", done: true, error: "HTTP 429: slow down", status: 429 }], []);
  await assert.rejects(() => ask(page, { ...opts, timeoutMs: 10_000 }), /rate limit/);
});

test("a completed stream returns directly", async () => {
  const { page, calls } = fakePage(
    [{ text: ev({ ...meta, status: "COMPLETED", final_sse_message: true, blocks: [{ intended_usage: "ask_text", markdown_block: { answer: "Done." } }] }), done: true }],
    [],
  );
  const r = await ask(page, { ...opts, timeoutMs: 10_000 });
  assert.equal(r.answer, "Done.");
  assert.equal(calls.threadFetches, 0);
});
