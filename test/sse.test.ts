import { test } from "node:test";
import assert from "node:assert/strict";
import { AskStreamParser, applyPatch, parseSse } from "../src/sse.ts";

function ev(obj: unknown): string {
  return `event: message\r\ndata: ${JSON.stringify(obj)}\r\n\r\n`;
}

const base = {
  backend_uuid: "b-1",
  context_uuid: "c-1",
  read_write_token: "rw-1",
  thread_url_slug: "slug-1",
  display_model: "pplx_pro",
  mode: "COPILOT",
};

test("applyPatch handles add/replace/remove and array append", () => {
  let doc: any = { chunks: ["a"] };
  doc = applyPatch(doc, { op: "add", path: "/chunks/1", value: "b" });
  doc = applyPatch(doc, { op: "add", path: "/chunks/-", value: "c" });
  doc = applyPatch(doc, { op: "replace", path: "/progress", value: "DONE" });
  doc = applyPatch(doc, { op: "add", path: "/deep/nested/0", value: 1 });
  assert.deepEqual(doc, { chunks: ["a", "b", "c"], progress: "DONE", deep: { nested: [1] } });
  doc = applyPatch(doc, { op: "remove", path: "/deep" });
  assert.equal(doc.deep, undefined);
  assert.deepEqual(applyPatch(undefined, { op: "add", path: "", value: { x: 1 } }), { x: 1 });
});

test("streams markdown chunks through diff patches", () => {
  const text =
    ev({ ...base, status: "PENDING", blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: ["Canberra is "] } }] }) +
    ev({ ...base, status: "PENDING", blocks: [{ intended_usage: "ask_text", diff_block: { field: "markdown_block", patches: [{ op: "add", path: "/chunks/1", value: "the capital [1]." }] } }] }) +
    ev({
      ...base,
      status: "PENDING",
      blocks: [
        {
          intended_usage: "sources_answer_mode",
          sources_mode_block: { web_results: [{ name: "Wikipedia", url: "https://en.wikipedia.org/wiki/Canberra", snippet: "Canberra..." }] },
        },
      ],
    }) +
    "event: end_of_stream\r\ndata: {}\r\n\r\n";
  const r = parseSse(text);
  assert.equal(r.answer, "Canberra is the capital [1].");
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].title, "Wikipedia");
  assert.equal(r.threadSlug, "slug-1");
  assert.equal(r.readWriteToken, "rw-1");
  assert.equal(r.complete, false);
});

test("final full message wins and marks completion", () => {
  const text =
    ev({ ...base, status: "PENDING", blocks: [{ intended_usage: "ask_text", markdown_block: { chunks: ["partial"] } }] }) +
    ev({
      ...base,
      status: "COMPLETED",
      final_sse_message: true,
      related_query_items: [{ text: "Why Canberra?" }],
      blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "DONE", chunks: ["partial", " done"], answer: "Full answer." } }],
    });
  const r = parseSse(text);
  assert.equal(r.answer, "Full answer.");
  assert.equal(r.complete, true);
  assert.deepEqual(r.relatedQuestions, ["Why Canberra?"]);
});

test("research sections are joined in order and beat a short summary", () => {
  const text = ev({
    ...base,
    status: "COMPLETED",
    blocks: [
      { intended_usage: "ask_text", markdown_block: { answer: "Short summary." } },
      { intended_usage: "ask_text_1_markdown", markdown_block: { answer: "## Part two\nMore detail here." } },
      { intended_usage: "ask_text_0_markdown", markdown_block: { answer: "# Report\nIntro section with lots of words." } },
      { intended_usage: "pro_search_steps", plan_block: { goals: [{ description: "Survey sources" }], steps: [{ search_web_content: { queries: [{ query: "canberra history" }] } }] } },
    ],
  });
  const r = parseSse(text);
  assert.equal(r.answer, "# Report\nIntro section with lots of words.\n\n## Part two\nMore detail here.");
  assert.deepEqual(r.steps, ["Survey sources", "canberra history"]);
});

test("feeding in arbitrary chunk boundaries gives the same result", () => {
  const text =
    ev({ ...base, blocks: [{ intended_usage: "ask_text", markdown_block: { chunks: ["한국어 "] } }] }) +
    ev({ ...base, status: "COMPLETED", blocks: [{ intended_usage: "ask_text", diff_block: { field: "markdown_block", patches: [{ op: "add", path: "/chunks/-", value: "답변" }] } }] });
  const p = new AskStreamParser();
  for (let i = 0; i < text.length; i += 7) p.feed(text.slice(i, i + 7));
  p.end();
  assert.equal(p.result().answer, "한국어 답변");
  assert.equal(p.result().complete, true);
});

test("legacy text steps payload is understood", () => {
  const steps = [{ step_type: "FINAL", content: { answer: JSON.stringify({ answer: "Legacy answer", web_results: [{ name: "Src", url: "https://x.test" }] }) } }];
  const r = parseSse(ev({ ...base, status: "COMPLETED", text: JSON.stringify(steps), blocks: [] }));
  assert.equal(r.answer, "Legacy answer");
  assert.equal(r.sources[0].url, "https://x.test");
});

test("deep research report asset is extracted from plan steps", () => {
  const report = { name: "Report title", filename: "report.md", url: "https://cdn.test/report.md?Policy=x", source_content: "# Report\n\nBody [1]." };
  const entry = {
    ...base,
    status: "COMPLETED",
    blocks: [
      { intended_usage: "ask_text", markdown_block: { answer: "Short chat summary." } },
      {
        intended_usage: "pro_search_steps",
        plan_block: { steps: [{ step_type: "RESEARCH_ANSWER", assets: [{ uuid: "a", asset_type: "RESEARCH_REPORT", research_report: report }] }] },
      },
    ],
  };
  const r = parseSse(ev(entry));
  assert.equal(r.answer, "Short chat summary.");
  assert.deepEqual(r.report, { title: "Report title", filename: "report.md", url: report.url, content: report.source_content });
});

test("workflow_block answer, queries and sources are read", () => {
  const wb = {
    steps: [
      {
        title: "Searching the web",
        items: [
          { type: "WORKFLOW_ITEM_QUERIES", payload: { queries_payload: { queries: ["q1"] } } },
          { type: "WORKFLOW_ITEM_SOURCES", payload: { sources_payload: { sources: [{ name: "S", url: "https://s.test" }] } } },
        ],
      },
      { title: "", items: [{ type: "WORKFLOW_ITEM_TEXT", variant: "answer", payload: { text_payload: { chunks: ["Hel", "lo"], is_streaming: true } } }] },
    ],
  };
  const r = parseSse(ev({ ...base, status: "COMPLETED", blocks: [{ intended_usage: "workflow_root", workflow_block: wb }] }));
  assert.equal(r.answer, "Hello");
  assert.deepEqual(r.steps, ["Searching the web", "search: q1"]);
  assert.equal(r.sources[0].url, "https://s.test");
});
