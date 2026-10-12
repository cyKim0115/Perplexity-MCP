// Markdown rendering of tool results.

import type { HistoryEntry, HistoryMeta, SearchHit } from "./history.ts";
import type { AccountInfo, LibraryThread, ThreadDetail } from "./perplexity.ts";
import type { WebSource } from "./sse.ts";

/**
 * MCP clients cap tool output (Claude Code: ~25k tokens by default). Korean/CJK text costs
 * about a token per character while Latin text is ~4 characters per token, so pages are
 * measured in rough token units instead of characters.
 */
export const OUTPUT_TOKEN_BUDGET = Number(process.env.PPLX_MAX_OUTPUT_TOKENS) || 16_000;
const SOURCES_RESERVE = Math.min(3000, Math.floor(OUTPUT_TOKEN_BUDGET / 5));

function tokenUnits(ch: string): number {
  return /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 1 : 0.27;
}

/** Rough token cost of a string (see tokenUnits). */
export function textUnits(text: string): number {
  let u = 0;
  for (const ch of text) u += tokenUnits(ch);
  return u;
}

/** End index of a page starting at `offset` that fits both the char cap and the token budget. */
export function pageEnd(text: string, offset: number, maxChars: number, tokenBudget = OUTPUT_TOKEN_BUDGET): number {
  const hardEnd = Math.min(text.length, offset + maxChars);
  let units = 0;
  let i = offset;
  for (; i < hardEnd; i++) {
    units += tokenUnits(text[i]);
    if (units > tokenBudget) break;
  }
  if (i >= text.length) return text.length;
  // Prefer to cut at a paragraph or line break near the end of the page.
  const para = text.lastIndexOf("\n\n", i);
  if (para > offset + (i - offset) * 0.7) return para;
  const line = text.lastIndexOf("\n", i);
  if (line > offset + (i - offset) * 0.8) return line;
  return i;
}

/** "2026-10-12 10:35 (UTC+9)" in the machine's local time zone. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "?";
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const zone = `UTC${off >= 0 ? "+" : "-"}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${p(Math.abs(off) % 60)}` : ""}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} (${zone})`;
}

/** Apply `fn` to the parts of markdown outside fenced and inline code (where `arr[1]` is not a citation). */
export function mapOutsideCode(text: string, fn: (prose: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** A citation marker: [3] or [^3], but not a markdown link label like [3](url). */
export const CITATION_RE = /\[(\^?)(\d{1,4})\](?!\()/g;

/** Citation numbers that appear in `text` outside code. */
export function citedNumbers(text: string): Set<number> {
  const out = new Set<number>();
  mapOutsideCode(text, (prose) => {
    for (const m of prose.matchAll(CITATION_RE)) out.add(Number(m[2]));
    return prose;
  });
  return out;
}

/**
 * Numbered source list. Short lists are shown whole; long ones (deep research) show the
 * sources the text actually cites, keeping their original [n] numbers.
 */
export function formatSources(
  sources: WebSource[],
  opts: { text?: string; max?: number; cap?: number; id?: string; unitBudget?: number } = {},
): string {
  if (!sources.length) return "";
  const max = opts.max ?? 30;
  const line = (s: WebSource, n: number) => `[${n}] ${s.title || "(untitled)"} — ${s.url}`;
  let picked: number[] = sources.map((_, i) => i + 1);
  if (sources.length > max) {
    const cited = opts.text
      ? [...citedNumbers(opts.text)].filter((n) => n >= 1 && n <= sources.length).sort((a, b) => a - b)
      : [];
    picked = cited.length ? cited : picked.slice(0, max);
  }
  const lines: string[] = [];
  let units = 0;
  for (const n of picked.slice(0, opts.cap ?? 120)) {
    const l = line(sources[n - 1], n);
    units += textUnits(l) + 1;
    if (opts.unitBudget !== undefined && units > opts.unitBudget && lines.length > 0) break;
    lines.push(l);
  }
  const hidden = sources.length - lines.length;
  if (hidden > 0) {
    lines.push(
      `… ${hidden} more source(s) not listed` +
        (opts.id ? `: perplexity_history_get(id="${opts.id}", sources_only=true) lists all of them.` : "."),
    );
  }
  return `### Sources\n${lines.join("\n")}`;
}

export function formatEntry(e: HistoryEntry, opts: { offset?: number; maxChars?: number; showSources?: boolean } = {}): string {
  const offset = Math.min(Math.max(0, opts.offset ?? 0), e.answer.length);
  // Leave room in the page for the source list that follows the last part of the answer.
  const end = pageEnd(e.answer, offset, opts.maxChars ?? 60_000, OUTPUT_TOKEN_BUDGET - SOURCES_RESERVE);
  const body = e.answer.slice(offset, end);
  const parts: string[] = [];
  if (e.report && offset === 0) {
    parts.push(`*Full research report: ${e.report.title || e.report.filename}${e.report.filename ? ` (${e.report.filename})` : ""}*\n`);
  }
  if (offset > 0) parts.push(`*(continuing from character ${offset} of ${e.answer.length})*\n`);
  parts.push(body || (offset > 0 ? "*(nothing left: this is past the end of the answer)*" : "*(empty answer)*"));
  if (end < e.answer.length) {
    parts.push(
      `\n*(page ends at character ${end} of ${e.answer.length}. ` +
        `Continue with perplexity_history_get(id="${e.id}", offset=${end}).)*`,
    );
  }
  if (opts.showSources !== false && end >= e.answer.length) {
    const src = formatSources(e.sources, {
      text: e.answer,
      id: e.id,
      unitBudget: Math.max(SOURCES_RESERVE, OUTPUT_TOKEN_BUDGET - textUnits(body) - 500),
    });
    if (src) parts.push("", src);
    if (e.relatedQuestions.length) parts.push("", "### Related questions", ...e.relatedQuestions.map((q) => `- ${q}`));
  }
  parts.push("", "---", footer(e));
  return parts.join("\n");
}

export function formatSourcesOnly(e: HistoryEntry, offset = 0, maxChars = 60_000): string {
  const all = e.sources.map((s, i) => `[${i + 1}] ${s.title || "(untitled)"} — ${s.url}`).join("\n");
  if (!all) return `Saved answer ${e.id} has no sources.`;
  const start = Math.min(Math.max(0, offset), all.length);
  const end = pageEnd(all, start, maxChars);
  return (
    `### All ${e.sources.length} sources of ${e.id}\n` +
    all.slice(start, end) +
    (end < all.length ? `\n*(more: perplexity_history_get(id="${e.id}", sources_only=true, offset=${end}))*` : "")
  );
}

export function footer(e: HistoryMeta & { parentId?: string | null }): string {
  const bits = [`history_id: \`${e.id}\``, e.kind];
  if (e.model) bits.push(`model: ${e.model}`);
  if (e.threadUrl) bits.push(`thread: ${e.threadUrl}`);
  return (
    bits.join(" · ") +
    `\nAsk a follow-up in the same Perplexity thread with follow_up_id="${e.id}"; reopen later with perplexity_history_get.`
  );
}

export function formatMetaLine(m: HistoryMeta): string {
  return `- \`${m.id}\` · ${localTime(m.createdAt)} · ${m.kind}${m.model ? ` · ${m.model}` : ""} · ${m.sourceCount} sources · ${m.answerChars} chars\n  **${m.title}**`;
}

export function formatHits(query: string, res: { total: number; hits: SearchHit[]; matchMode: string }, filtered = false): string {
  if (!res.hits.length) {
    if (query.trim()) return `No saved answers match "${query}"${filtered ? " with these filters" : ""}.`;
    return filtered ? "No saved answers match these filters." : "No saved answers yet.";
  }
  const head =
    res.matchMode === "recent"
      ? `Most recent ${res.hits.length} of ${res.total} saved answers:`
      : `${res.total} saved answer(s) match "${query}"${res.matchMode === "any" ? " (no entry had every term; showing partial matches)" : ""}:`;
  const lines = res.hits.map((h) => formatMetaLine(h.meta) + (h.snippet ? `\n  > ${h.snippet}` : ""));
  return `${head}\n\n${lines.join("\n\n")}\n\nOpen one with perplexity_history_get(id).`;
}

export function formatAccount(info: AccountInfo | null, extra: { loggedIn: boolean; dataDir: string; savedAt?: string }): string {
  if (!extra.loggedIn) {
    return `Not logged in. Call perplexity_login to sign in.\nData directory: ${extra.dataDir}`;
  }
  const lines: string[] = [];
  const u = info?.user;
  lines.push(`Logged in${u ? ` as ${u.email ?? u.name ?? u.id}` : ""}${info ? ` · plan: ${info.tier}` : ""}`);
  if (extra.savedAt) lines.push(`Session saved: ${localTime(extra.savedAt)}`);
  if (info) {
    const q = Object.entries(info.quotas)
      .filter(([, v]) => v.remaining !== null || !v.available)
      .map(([k, v]) => `${k}: ${v.remaining ?? "?"}${v.available ? "" : " (unavailable)"}`);
    if (q.length) lines.push(`Remaining quotas: ${q.join(", ")}`);
    const d = info.defaultModels;
    if (d.search || d.research) lines.push(`Default models: search=${d.search ?? "?"}, research=${d.research ?? "?"}`);
    lines.push(`Info as of: ${localTime(info.fetchedAt)}`);
  }
  lines.push(`Data directory: ${extra.dataDir}`);
  return lines.join("\n");
}

export function formatLibrary(query: string, res: { total: number; items: LibraryThread[] }, offset: number, limit: number): string {
  if (!res.items.length) {
    if (offset > 0) return `No more threads after offset ${offset}.`;
    return query ? `No threads in your Perplexity library match "${query}".` : "Your Perplexity library is empty.";
  }
  // total_threads is the size of the whole library, not the number of search matches.
  const more = res.items.length >= limit ? ` More may exist: call again with offset=${offset + res.items.length}.` : "";
  const head = query
    ? `Threads in your Perplexity library matching "${query}" (results ${offset + 1}–${offset + res.items.length}).${more}`
    : `Your Perplexity library (${res.total} threads, showing ${offset + 1}–${offset + res.items.length}).${more}`;
  const lines = res.items.map(
    (t) =>
      `- **${t.title}**\n  ${localTime(t.createdAt)} · ${t.mode ?? "?"}${t.model ? ` · ${t.model}` : ""} · ${t.queryCount} message(s) · slug: \`${t.slug}\`` +
      (t.preview ? `\n  > ${t.preview.replace(/\s+/g, " ")}` : ""),
  );
  return `${head}\n\n${lines.join("\n\n")}\n\nRead one in full with perplexity_thread_get(slug).`;
}

/** Render a thread within one output page; everything (headers, sources) counts against the budget. */
export function formatThread(t: ThreadDetail, maxChars: number, savedId?: string): string {
  const parts = [`# ${t.title}`, t.url, ""];
  let used = parts.join("\n").length;
  const tokenBudget = OUTPUT_TOKEN_BUDGET;
  let usedUnits = 0;
  const units = textUnits;
  for (let i = 0; i < t.entries.length; i++) {
    const e = t.entries[i];
    const head = `## ${i + 1}. ${e.query}\n*${localTime(e.createdAt)}${e.model ? ` · ${e.model}` : ""}*\n`;
    const src = formatSources(e.sources, { text: e.answer, max: 15, cap: 15 });
    const remainingChars = maxChars - used - head.length - src.length;
    const remainingUnits = tokenBudget - usedUnits - units(head) - units(src);
    if (remainingChars < 200 || remainingUnits < 100) {
      parts.push(
        `*(${t.entries.length - i} more message(s) not shown` +
          (savedId ? `; the whole thread is saved: perplexity_history_get(id="${savedId}", offset=…)` : "") +
          ")*",
      );
      break;
    }
    const end = pageEnd(e.answer, 0, remainingChars, remainingUnits);
    const body = e.answer.slice(0, end) + (end < e.answer.length ? "\n\n*(truncated)*" : "");
    const block = `${head}\n${body}\n${src ? `\n${src}\n` : ""}`;
    parts.push(block);
    used += block.length;
    usedUnits += units(block);
  }
  if (t.truncated) parts.push("*(Perplexity reported more messages than were fetched.)*");
  return parts.join("\n");
}
