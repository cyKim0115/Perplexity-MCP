import { test } from "node:test";
import assert from "node:assert/strict";
import { citedNumbers, formatSources, localTime, pageEnd } from "../src/format.ts";
import { parseSince } from "../src/history.ts";
import { shiftCitations } from "../src/service.ts";

test("pageEnd respects the token budget for Hangul and the char cap for Latin", () => {
  const korean = "가".repeat(30_000);
  assert.equal(pageEnd(korean, 0, 100_000, 1000), 1000);
  const latin = "a".repeat(30_000);
  assert.equal(pageEnd(latin, 0, 5000, 1000), 3703); // 1000 / 0.27 chars
  assert.equal(pageEnd("short", 0, 5000, 1000), 5);
  const paras = `${"x".repeat(900)}\n\n${"y".repeat(900)}`;
  assert.equal(pageEnd(paras, 0, 1000, 10_000), 900); // cut at the paragraph break
});

test("citedNumbers finds [n] and [^n]", () => {
  assert.deepEqual([...citedNumbers("a [1] b [^12] c [3][1]")].sort((a, b) => a - b), [1, 3, 12]);
});

test("long source lists show only cited sources with their original numbers", () => {
  const sources = Array.from({ length: 80 }, (_, i) => ({ title: `S${i + 1}`, url: `https://s${i + 1}.test` }));
  const out = formatSources(sources, { text: "see [5] and [63]", id: "abc" });
  assert.match(out, /\[5\] S5 — https:\/\/s5\.test/);
  assert.match(out, /\[63\] S63/);
  assert.doesNotMatch(out, /\[1\] S1 /);
  assert.match(out, /78 more source\(s\).*sources_only=true/);
  // Short lists are shown whole.
  assert.equal(formatSources(sources.slice(0, 3)).split("\n").length, 4);
});

test("shiftCitations renumbers only citations within the message's own sources", () => {
  assert.equal(shiftCitations("a [1] b [2] c [9]", 10, 2), "a [11] b [12] c [9]");
  assert.equal(shiftCitations("x [^1]", 3, 1), "x [^4]");
  assert.equal(shiftCitations("x [1]", 0, 1), "x [1]");
});

test("parseSince accepts dates and ISO date-times and rejects junk", () => {
  assert.equal(parseSince("2026-10-01"), new Date(2026, 9, 1).getTime());
  assert.equal(parseSince("2026-10-01T00:00:00Z"), Date.UTC(2026, 9, 1));
  assert.throws(() => parseSince("last week"), /since must be/);
});

test("localTime prints local time with the UTC offset", () => {
  assert.match(localTime("2026-10-12T01:00:00Z"), /^2026-10-1[12] \d\d:\d\d \(UTC[+-]\d+(:\d\d)?\)$/);
  assert.equal(localTime("not a date"), "not a date");
});

test("citations inside code and markdown link labels are left alone", () => {
  const text = "See [2]. Code: `arr[1]` and\n```js\nx[1] = y[2];\n```\nlink [3](https://x.test) end [1].";
  assert.deepEqual([...citedNumbers(text)].sort(), [1, 2]);
  assert.equal(
    shiftCitations(text, 10, 3),
    "See [12]. Code: `arr[1]` and\n```js\nx[1] = y[2];\n```\nlink [3](https://x.test) end [11].",
  );
});

test("parseSince rejects lenient non-ISO and impossible dates", () => {
  assert.throws(() => parseSince("Oct 1"), /since must be/);
  assert.throws(() => parseSince("5"), /since must be/);
  assert.throws(() => parseSince("2026-13-45"), /since must be/);
  assert.equal(parseSince("2026-10-01T09:00:00+09:00"), Date.UTC(2026, 9, 1));
});

test("formatSources stops listing when the token budget is used up", () => {
  const sources = Array.from({ length: 50 }, (_, i) => ({ title: `제목 ${"가".repeat(40)} ${i + 1}`, url: `https://s${i + 1}.test/path` }));
  const out = formatSources(sources, { unitBudget: 300, id: "x" });
  const listed = out.split("\n").filter((l) => /^\[\d+\]/.test(l)).length;
  assert.ok(listed > 0 && listed < 30, `listed ${listed}`);
  assert.match(out, /more source\(s\) not listed: perplexity_history_get\(id="x", sources_only=true\)/);
});
