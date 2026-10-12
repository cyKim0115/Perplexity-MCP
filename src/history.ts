// Local, searchable archive of every answer this server produced (or imported from the
// Perplexity library). Layout under the history dir:
//   index.jsonl            one metadata line per entry (append-only)
//   entries/<id>.json      full entry (answer, sources, follow-up tokens)
//   md/<id>.md             human-readable mirror for editors / grep / note apps

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./secure-store.ts";
import type { WebSource } from "./sse.ts";

export type HistoryKind = "search" | "research" | "thread";

export interface HistoryMeta {
  id: string;
  createdAt: string;
  kind: HistoryKind;
  query: string;
  title: string;
  model: string | null;
  mode: string | null;
  threadSlug: string | null;
  threadUrl: string | null;
  sourceCount: number;
  answerChars: number;
}

export interface HistoryEntry extends HistoryMeta {
  /** The answer, or the full report for deep research. */
  answer: string;
  /** Short chat answer Perplexity showed next to a deep research report. */
  summary?: string | null;
  /** Where the deep research report came from (the CDN URL is signed and expires). */
  report?: { title: string; filename: string; url: string } | null;
  sources: WebSource[];
  relatedQuestions: string[];
  steps: string[];
  backendUuid: string | null;
  readWriteToken: string | null;
  /** History id this entry followed up on, if any. */
  parentId: string | null;
}

export interface SearchHit {
  meta: HistoryMeta;
  score: number;
  snippet: string;
}

function newId(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export function renderMarkdown(e: HistoryEntry): string {
  const lines = [`# ${e.title || e.query}`, ""];
  lines.push(`- id: ${e.id}`, `- date: ${e.createdAt}`, `- kind: ${e.kind}`);
  if (e.model) lines.push(`- model: ${e.model}`);
  if (e.threadUrl) lines.push(`- thread: ${e.threadUrl}`);
  lines.push("", `> ${e.query.replace(/\n/g, "\n> ")}`, "");
  if (e.summary) lines.push("## Summary", "", e.summary.trim(), "", "## Report", "");
  lines.push(e.answer.trim(), "");
  if (e.sources.length) {
    lines.push("## Sources", "");
    e.sources.forEach((s, i) => lines.push(`${i + 1}. [${s.title || s.url}](${s.url})`));
    lines.push("");
  }
  if (e.relatedQuestions.length) {
    lines.push("## Related questions", "", ...e.relatedQuestions.map((q) => `- ${q}`), "");
  }
  return lines.join("\n");
}

/**
 * Parse a `since` filter. A bare date (2026-10-01) means local midnight; anything else
 * must be a date-time Date.parse understands.
 */
export function parseSince(since: string): number {
  const s = since.trim();
  const bad = () => new Error(`since must be a date like 2026-10-01 or an ISO date-time like 2026-10-01T09:00:00+09:00, got "${since}".`);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (date) {
    const [y, mo, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const local = new Date(y, mo - 1, d);
    if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d) throw bad();
    return local.getTime();
  }
  // Only ISO-8601 date-times: V8's lenient fallback parser turns "Oct 1" into 2001-10-01.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.test(s)) throw bad();
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw bad();
  return ms;
}

/** Split a search string into lowercase terms; "quoted phrases" stay whole. */
export function parseTerms(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const t = (m[1] ?? m[2]).trim().toLowerCase();
    if (t) terms.push(t);
  }
  return [...new Set(terms)];
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1 && n < 1000) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

export function makeSnippet(text: string, terms: string[], radius = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let pos = -1;
  let hitLen = 0;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) {
      pos = i;
      hitLen = t.length;
    }
  }
  if (pos === -1) return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? "…" : "");
  const start = Math.max(0, pos - radius);
  const end = Math.min(flat.length, pos + hitLen + radius);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

interface Indexed {
  head: string; // query + title
  body: string; // answer
  side: string; // source titles/urls + related questions
}

export class HistoryStore {
  private readonly indexFile: string;
  private readonly entriesDir: string;
  private readonly mdDir: string;
  private metas: HistoryMeta[] = [];
  private indexStamp = "";
  private textCache = new Map<string, Indexed>();

  readonly dir: string;
  /** Called after every successful add (the server uses it to announce new resources). */
  onAdd: ((entry: HistoryEntry) => void) | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.indexFile = join(dir, "index.jsonl");
    this.entriesDir = join(dir, "entries");
    this.mdDir = join(dir, "md");
  }

  /** Re-read the index if another process appended to it. */
  private refresh(): void {
    let stamp = "";
    try {
      const st = statSync(this.indexFile);
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      this.metas = [];
      this.indexStamp = "";
      return;
    }
    if (stamp === this.indexStamp) return;
    const byId = new Map<string, HistoryMeta>();
    for (const line of readFileSync(this.indexFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as HistoryMeta;
        byId.set(m.id, m);
      } catch {
        // skip a torn line
      }
    }
    this.metas = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.indexStamp = stamp;
  }

  add(input: Omit<HistoryEntry, "id" | "createdAt" | "sourceCount" | "answerChars" | "title"> & { title?: string }): HistoryEntry {
    const now = new Date();
    const entry: HistoryEntry = {
      ...input,
      id: newId(now),
      createdAt: now.toISOString(),
      title: (input.title || input.query).replace(/\s+/g, " ").trim().slice(0, 160),
      sourceCount: input.sources.length,
      answerChars: input.answer.length,
    };
    mkdirSync(this.entriesDir, { recursive: true });
    mkdirSync(this.mdDir, { recursive: true });
    atomicWrite(join(this.entriesDir, `${entry.id}.json`), JSON.stringify(entry, null, 2), 0o644);
    atomicWrite(join(this.mdDir, `${entry.id}.md`), renderMarkdown(entry), 0o644);
    const meta: HistoryMeta = {
      id: entry.id,
      createdAt: entry.createdAt,
      kind: entry.kind,
      query: entry.query,
      title: entry.title,
      model: entry.model,
      mode: entry.mode,
      threadSlug: entry.threadSlug,
      threadUrl: entry.threadUrl,
      sourceCount: entry.sourceCount,
      answerChars: entry.answerChars,
    };
    appendFileSync(this.indexFile, JSON.stringify(meta) + "\n");
    try {
      this.onAdd?.(entry);
    } catch {
      // notification only
    }
    return entry;
  }

  get(id: string): HistoryEntry | null {
    const safe = id.trim();
    if (!/^[\w-]+$/.test(safe)) return null;
    const file = join(this.entriesDir, `${safe}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as HistoryEntry;
  }

  markdownPath(id: string): string {
    return join(this.mdDir, `${id}.md`);
  }

  list(opts: { limit?: number; offset?: number; kind?: HistoryKind } = {}): { total: number; items: HistoryMeta[] } {
    this.refresh();
    const all = opts.kind ? this.metas.filter((m) => m.kind === opts.kind) : this.metas;
    const offset = opts.offset ?? 0;
    return { total: all.length, items: all.slice(offset, offset + (opts.limit ?? 20)) };
  }

  /** Find the most recent entry recorded for a Perplexity thread (optionally of one kind). */
  findByThread(slug: string, kind?: HistoryKind): HistoryMeta | null {
    this.refresh();
    return this.metas.find((m) => m.threadSlug === slug && (!kind || m.kind === kind)) ?? null;
  }

  private indexed(meta: HistoryMeta): Indexed | null {
    const cached = this.textCache.get(meta.id);
    if (cached) return cached;
    const e = this.get(meta.id);
    if (!e) return null;
    const ix: Indexed = {
      head: `${e.query}\n${e.title}`.toLowerCase(),
      body: `${e.answer}\n${e.summary ?? ""}`.toLowerCase(),
      side: [...e.sources.map((s) => `${s.title} ${s.url}`), ...e.relatedQuestions].join("\n").toLowerCase(),
    };
    this.textCache.set(meta.id, ix);
    return ix;
  }

  /**
   * Substring search (works for Korean, where particles break word tokenization).
   * Every term must match (AND); if nothing matches, falls back to any-term (OR).
   */
  search(opts: { query: string; limit?: number; kind?: HistoryKind; since?: string }): { total: number; hits: SearchHit[]; matchMode: "all" | "any" | "recent" } {
    this.refresh();
    const terms = parseTerms(opts.query);
    let pool = opts.kind ? this.metas.filter((m) => m.kind === opts.kind) : this.metas;
    if (opts.since) {
      const sinceMs = parseSince(opts.since);
      pool = pool.filter((m) => Date.parse(m.createdAt) >= sinceMs);
    }
    const limit = opts.limit ?? 10;
    if (terms.length === 0) {
      return {
        total: pool.length,
        matchMode: "recent",
        hits: pool.slice(0, limit).map((meta) => ({ meta, score: 0, snippet: "" })),
      };
    }
    const scoreAll: { meta: HistoryMeta; score: number; matched: number }[] = [];
    for (const meta of pool) {
      const ix = this.indexed(meta);
      if (!ix) continue;
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        const h = countOccurrences(ix.head, t);
        const b = countOccurrences(ix.body, t);
        const s = countOccurrences(ix.side, t);
        if (h + b + s === 0) continue;
        matched++;
        score += 6 * Math.min(h, 3) + 2 * Math.min(s, 5) + 1 + Math.log1p(b);
      }
      if (matched) scoreAll.push({ meta, score: score * (matched / terms.length), matched });
    }
    let matchMode: "all" | "any" = "all";
    let hits = scoreAll.filter((x) => x.matched === terms.length);
    if (hits.length === 0) {
      hits = scoreAll;
      matchMode = "any";
    }
    hits.sort((a, b) => b.score - a.score || b.meta.createdAt.localeCompare(a.meta.createdAt));
    return {
      total: hits.length,
      matchMode,
      hits: hits.slice(0, limit).map(({ meta, score }) => {
        const e = this.get(meta.id);
        return { meta, score: Math.round(score * 10) / 10, snippet: e ? makeSnippet(e.answer, terms) : "" };
      }),
    };
  }
}
