// Perplexity web API calls, executed as same-origin fetch() inside a perplexity.ai page.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "patchright";
import { API_QUERY, API_VERSION, PPLX_ORIGIN, localTimezone, log, paths, settings } from "./config.ts";
import { CloudflareBlockedError, StreamInterruptedError } from "./errors.ts";
import { AskStreamParser, parseStepsText, type AskResult, type ResearchReport, type WebSource } from "./sse.ts";
import type { SessionUser } from "./session.ts";

export interface FetchResult {
  status: number;
  contentType: string;
  json: any;
  text: string;
}

export async function pageFetch(
  page: Page,
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<FetchResult> {
  return page.evaluate(
    async ({ url, method, body, headers }) => {
      const r = await fetch(url, {
        method,
        credentials: "include",
        headers: { accept: "application/json", ...(body != null ? { "content-type": "application/json" } : {}), ...headers },
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const contentType = r.headers.get("content-type") ?? "";
      const text = await r.text();
      let json = null;
      if (contentType.includes("json")) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: r.status, contentType, json, text: json ? "" : text.slice(0, 2000) };
    },
    { url, method: init.method ?? "GET", body: init.body ?? null, headers: init.headers ?? {} },
  ).then((r) => {
    if (r.status === 403 && /html/i.test(r.contentType)) throw new CloudflareBlockedError(new URL(url).pathname);
    return r;
  });
}

async function getJson(page: Page, path: string): Promise<any> {
  const r = await pageFetch(page, `${PPLX_ORIGIN}${path}`);
  return r.status === 200 ? r.json : null;
}

// ---------------------------------------------------------------- account

export interface ModelInfo {
  id: string;
  label: string;
  provider: string | null;
  mode: string | null;
  description?: string;
}

export interface QuotaInfo {
  available: boolean;
  remaining: number | null;
}

export interface AccountInfo {
  fetchedAt: string;
  user: SessionUser | null;
  tier: "Max" | "Pro" | "Enterprise" | "Free" | "Anonymous";
  defaultModels: Record<string, string>;
  models: ModelInfo[];
  quotas: Record<string, QuotaInfo>;
  /** Some endpoints did not answer; `tier` (and maybe models/quotas) are guesses. */
  partial?: boolean;
}

export async function fetchSessionUser(page: Page): Promise<SessionUser | null> {
  const s = await getJson(page, `/api/auth/session?${API_QUERY}`);
  const u = s?.user;
  if (!u?.id) return null;
  return { id: String(u.id), email: u.email ?? undefined, name: u.name ?? u.username ?? undefined };
}

export async function fetchAccountInfo(page: Page): Promise<AccountInfo> {
  const [user, modelsConfig, rateLimits, experiments, userInfo] = await Promise.all([
    fetchSessionUser(page),
    getJson(page, `/rest/models/config?config_schema=v1&${API_QUERY}`),
    getJson(page, `/rest/rate-limit/status?${API_QUERY}`),
    getJson(page, `/rest/experiments/attributes?${API_QUERY}`),
    getJson(page, `/rest/user/info?${API_QUERY}`),
  ]);
  if (user && !modelsConfig && !experiments && !rateLimits) {
    throw new Error("Perplexity account endpoints did not answer (Cloudflare challenge?).");
  }
  const tier: AccountInfo["tier"] = !user
    ? "Anonymous"
    : experiments?.server_is_max === true
      ? "Max"
      : userInfo?.is_enterprise === true || experiments?.server_is_enterprise === true
        ? "Enterprise"
        : experiments?.server_is_pro === true
          ? "Pro"
          : "Free";
  const models: ModelInfo[] = Object.entries(modelsConfig?.models ?? {}).map(([id, m]: [string, any]) => ({
    id,
    label: String(m?.label ?? id),
    provider: m?.provider ?? null,
    mode: m?.mode ?? null,
    ...(m?.description ? { description: String(m.description) } : {}),
  }));
  const quotas: Record<string, QuotaInfo> = {};
  for (const [name, q] of Object.entries(rateLimits?.modes ?? {}) as [string, any][]) {
    quotas[name] = {
      available: q?.available !== false,
      remaining: q?.remaining_detail?.kind === "exact" ? Number(q.remaining_detail.remaining) : null,
    };
  }
  return {
    fetchedAt: new Date().toISOString(),
    user,
    tier,
    defaultModels: modelsConfig?.default_models ?? {},
    models,
    quotas,
    ...(user && (!experiments || !modelsConfig || !rateLimits) ? { partial: true } : {}),
  };
}

// ---------------------------------------------------------------- ask (streaming)

export type AskMode = "concise" | "copilot";

export interface AskOptions {
  query: string;
  mode: AskMode;
  model: string;
  sources: string[];
  language: string;
  followUp?: { backendUuid: string; readWriteToken?: string | null };
  /** Perplexity recency filter: DAY | WEEK | MONTH | YEAR */
  recency?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Mirrors what the perplexity.ai web client sends (captured 2026-10-12).
const SUPPORTED_BLOCK_USE_CASES = [
  "answer_modes",
  "media_items",
  "inline_entity_cards",
  "place_widgets",
  "finance_widgets",
  "news_widgets",
  "shopping_widgets",
  "search_result_widgets",
  "inline_images",
  "inline_assets",
  "placeholder_cards",
  "diff_blocks",
  "entity_group_v2",
  "refinement_filters",
  "canvas_mode",
  "maps_preview",
  "answer_tabs",
  "preserve_latex",
  "in_context_suggestions",
  "pending_followups",
  "inline_claims",
  "unified_assets",
  "workflow_steps",
  "workflow_widgets",
  "navigation_results",
  "background_agents",
];

export function buildAskBody(opts: AskOptions): { params: Record<string, unknown>; query_str: string } {
  const followUp = opts.followUp?.backendUuid ? opts.followUp : undefined;
  const params: Record<string, unknown> = {
    attachments: [],
    language: opts.language,
    timezone: localTimezone(),
    search_focus: "internet",
    sources: opts.sources,
    search_recency_filter: opts.recency ?? null,
    frontend_uuid: randomUUID(),
    mode: opts.mode,
    model_preference: opts.model,
    is_related_query: false,
    is_sponsored: false,
    frontend_context_uuid: randomUUID(),
    prompt_source: "user",
    query_source: followUp ? "followup" : "home",
    is_incognito: false,
    time_from_first_type: 4000 + Math.floor(Math.random() * 12000),
    local_search_enabled: false,
    use_schematized_api: true,
    send_back_text_in_streaming_api: false,
    supported_block_use_cases: SUPPORTED_BLOCK_USE_CASES,
    client_coordinates: null,
    mentions: [],
    dsl_query: opts.query,
    skip_search_enabled: true,
    is_nav_suggestions_disabled: false,
    source: "default",
    always_search_override: false,
    override_no_search: false,
    should_ask_for_mcp_tool_confirmation: true,
    supports_tool_approval_modal: true,
    browser_agent_allow_once_from_toggle: false,
    force_enable_browser_agent: false,
    supported_features: ["browser_agent_permission_banner_v1.1"],
    extended_context: false,
    local_workspace_directories: [],
    version: API_VERSION,
  };
  if (followUp) {
    params.last_backend_uuid = followUp.backendUuid;
    params.read_write_token = followUp.readWriteToken ?? null;
    params.followup_source = "link";
  }
  return { params, query_str: opts.query };
}

export interface AskProgress {
  elapsedMs: number;
  partial: AskResult;
}

/**
 * Start the SSE request inside the page without awaiting it, then poll the
 * accumulated text from Node. Polling lets us report progress for long deep-research
 * runs and keeps concurrent asks independent on one shared page.
 */
export async function ask(page: Page, opts: AskOptions, onProgress?: (p: AskProgress) => void): Promise<AskResult> {
  const id = randomUUID();
  const body = buildAskBody(opts);
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? settings.askTimeoutMs;
  const parser = new AskStreamParser();
  const raw: string[] = [];

  await page.evaluate(
    ({ id, body, url }) => {
      const w = window as any;
      w.__pplxAsk ??= {};
      const st = (w.__pplxAsk[id] = { text: "", done: false, error: null as string | null, status: 0, ctrl: new AbortController() });
      void (async () => {
        try {
          const r = await fetch(url, {
            method: "POST",
            credentials: "include",
            signal: st.ctrl.signal,
            headers: {
              accept: "text/event-stream",
              "content-type": "application/json",
              "x-request-id": crypto.randomUUID(),
              "x-perplexity-request-reason": "perplexity-query-state-provider",
            },
            body: JSON.stringify(body),
          });
          st.status = r.status;
          if (!r.ok || !r.body) {
            st.error = `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 400)}`;
          } else {
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              st.text += dec.decode(value, { stream: true });
            }
            st.text += dec.decode();
          }
        } catch (e: any) {
          st.error = String(e?.message ?? e);
        }
        st.done = true;
      })();
    },
    { id, body, url: `${PPLX_ORIGIN}/rest/sse/perplexity_ask` },
  );

  let error: string | null = null;
  let status = 0;
  let timedOut = false;
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error("Request cancelled.");
      if (Date.now() - started > timeoutMs) {
        timedOut = true;
        break;
      }
      let chunk: { text: string; done: boolean; error: string | null; status: number };
      try {
        chunk = await page.evaluate((id) => {
          const st = (window as any).__pplxAsk?.[id];
          if (!st) return { text: "", done: true, error: "stream state lost (page reloaded?)", status: 0 };
          const text = st.text;
          st.text = "";
          return { text, done: st.done, error: st.error, status: st.status };
        }, id);
      } catch (err) {
        // The page itself failed (crash, closed). Keep the thread identity so callers can recover.
        const partial = parser.result();
        if (partial.backendUuid && partial.threadSlug) {
          throw new StreamInterruptedError(`Answer stream lost: ${(err as Error).message.split("\n")[0]}`, partial);
        }
        throw err;
      }
      if (chunk.text) {
        raw.push(chunk.text);
        parser.feed(chunk.text);
      }
      // Report on every poll, not only on new text: it doubles as a heartbeat for clients.
      onProgress?.({ elapsedMs: Date.now() - started, partial: parser.result() });
      status = chunk.status || status;
      if (chunk.done) {
        error = chunk.error;
        break;
      }
      await new Promise((r) => setTimeout(r, 750));
    }
  } finally {
    await page
      .evaluate((id) => {
        const store = (window as any).__pplxAsk;
        const st = store?.[id];
        if (st && !st.done) st.ctrl.abort();
        if (store) delete store[id];
      }, id)
      .catch(() => {});
    if (settings.debug) dumpDebug(id, opts, raw.join(""));
  }

  parser.end();
  const result = parser.result();
  if (result.complete) {
    if (error) log(`stream reported an error after completing: ${error}`);
    return result;
  }
  if (!result.backendUuid) {
    // Rejected before Perplexity created anything: nothing to recover.
    if (status === 403 && /<html|<!doctype|just a moment/i.test(error ?? "")) throw new CloudflareBlockedError("the answer request");
    if (status === 401 || status === 403) {
      throw new Error(`Perplexity rejected the request (${error}). The session may have expired: run perplexity_login.`);
    }
    if (status === 429) throw new Error(`Perplexity rate limit hit (${error}).`);
    throw new Error(`Perplexity request failed: ${error ?? (timedOut ? "timed out" : "stream ended early")}`);
  }
  // The stream stopped before COMPLETED, but the answer keeps being produced server-side.
  const why = timedOut ? `no completion after ${Math.round(timeoutMs / 1000)}s` : (error ?? "stream ended before completion");
  log(`answer stream interrupted (${why}); following the thread instead.`);
  if (timedOut || !result.threadSlug) {
    throw new StreamInterruptedError(`Answer stream interrupted: ${why}.`, result);
  }
  return settleFromThread(
    page,
    result,
    started + timeoutMs,
    onProgress && ((partial) => onProgress({ elapsedMs: Date.now() - started, partial })),
  );
}

/** Poll the thread until the entry for `partial.backendUuid` is finished, then return it. */
export async function settleFromThread(
  page: Page,
  partial: AskResult,
  deadline: number,
  onPoll?: (partial: AskResult) => void,
): Promise<AskResult> {
  let delay = 3000;
  let failures = 0;
  for (;;) {
    let thread: ThreadDetail | null = null;
    try {
      thread = await getThread(page, partial.threadSlug!);
      failures = 0;
    } catch (err) {
      // A dead or challenged page will not recover inside this loop: hand the job back
      // (as interrupted) so a later status call can retry on a fresh page.
      const msg = (err as Error).message;
      if (page.isClosed() || err instanceof CloudflareBlockedError || /closed|crash/i.test(msg) || ++failures >= 5) {
        throw new StreamInterruptedError(`Answer stream interrupted and the thread could not be read (${msg.split("\n")[0]}).`, partial);
      }
      log(`thread poll failed: ${msg}`);
    }
    const entry = thread?.entries.find((e) => e.backendUuid === partial.backendUuid);
    if (entry && /^completed$/i.test(entry.status)) return entryToResult(entry, partial);
    if (entry && /fail|error|cancel/i.test(entry.status)) {
      throw new Error(`Perplexity reported the answer as ${entry.status.toLowerCase()}.`);
    }
    if (Date.now() + delay > deadline) {
      throw new StreamInterruptedError("Answer stream interrupted and the thread did not finish in time.", partial);
    }
    onPoll?.(partial);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 15_000);
  }
}

export function entryToResult(entry: ThreadEntry, base: Partial<AskResult> = {}): AskResult {
  return {
    answer: entry.answer,
    ...(entry.report ? { report: entry.report } : {}),
    sources: entry.sources,
    relatedQuestions: entry.relatedQuestions,
    media: [],
    steps: base.steps ?? [],
    backendUuid: entry.backendUuid || base.backendUuid,
    contextUuid: base.contextUuid,
    readWriteToken: entry.readWriteToken ?? base.readWriteToken,
    threadSlug: base.threadSlug,
    threadTitle: base.threadTitle,
    displayModel: entry.model ?? base.displayModel,
    mode: entry.mode ?? base.mode,
    status: "COMPLETED",
    complete: true,
  };
}

function dumpDebug(id: string, opts: AskOptions, text: string): void {
  try {
    mkdirSync(paths.debugDir, { recursive: true });
    const file = join(paths.debugDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${opts.model.replace(/[^\w.-]/g, "_").slice(0, 40)}-${id.slice(0, 8)}.sse`);
    writeFileSync(file, text);
    log(`raw stream saved: ${file}`);
  } catch {
    // debugging aid only
  }
}

// ---------------------------------------------------------------- library (cloud threads)

export interface LibraryThread {
  slug: string;
  title: string;
  query: string;
  preview: string;
  createdAt: string;
  mode: string | null;
  model: string | null;
  queryCount: number;
  url: string;
}

function isoUtc(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  return /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`;
}

export async function listThreads(
  page: Page,
  opts: { searchTerm?: string; limit?: number; offset?: number },
): Promise<{ total: number; items: LibraryThread[] }> {
  const r = await pageFetch(page, `${PPLX_ORIGIN}/rest/thread/list_ask_threads?${API_QUERY}`, {
    method: "POST",
    body: {
      limit: opts.limit ?? 20,
      offset: opts.offset ?? 0,
      ascending: false,
      search_term: opts.searchTerm ?? "",
      with_temporary_threads: false,
      exclude_asi: false,
    },
  });
  if (r.status === 401 || r.status === 403) throw new Error(`Library request rejected (${r.status}); run perplexity_login.`);
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`Library request failed (HTTP ${r.status}).`);
  const rows: any[] = r.json;
  return {
    total: typeof rows[0]?.total_threads === "number" ? rows[0].total_threads : rows.length,
    items: rows.map((row) => ({
      slug: String(row.slug ?? ""),
      title: String(row.title ?? row.query_str ?? "(untitled)"),
      query: String(row.query_str ?? ""),
      preview: String(row.answer_preview ?? "").slice(0, 300),
      createdAt: isoUtc(row.last_query_datetime),
      mode: typeof row.mode === "string" ? row.mode : null,
      model: typeof row.display_model === "string" ? row.display_model : null,
      queryCount: typeof row.query_count === "number" ? row.query_count : 1,
      url: `${PPLX_ORIGIN}/search/${row.slug ?? ""}`,
    })),
  };
}

export interface ThreadEntry {
  query: string;
  answer: string;
  /** Deep Research report attached to this entry, if any. */
  report?: ResearchReport;
  sources: WebSource[];
  relatedQuestions: string[];
  backendUuid: string;
  readWriteToken?: string;
  model: string | null;
  mode: string | null;
  status: string;
  createdAt: string;
}

export interface ThreadDetail {
  slug: string;
  title: string;
  url: string;
  entries: ThreadEntry[];
  /** More entries exist than were fetched. */
  truncated: boolean;
}

/** Accepts a slug or a full https://www.perplexity.ai/search/<slug> URL. */
export function normalizeSlug(slugOrUrl: string): string {
  const s = slugOrUrl.trim();
  const m = /perplexity\.ai\/search\/([^/?#\s]+)/i.exec(s);
  return decodeURIComponent(m ? m[1] : s.replace(/^\/+|\/+$/g, ""));
}

export function parseThreadEntry(e: any): ThreadEntry {
  const parser = new AskStreamParser();
  parser.applyMessage({ ...e, blocks: Array.isArray(e.blocks) ? e.blocks : [] });
  const fromBlocks = parser.result();
  const fromText = typeof e.text === "string" ? parseStepsText(e.text) : { answer: "", sources: [] };
  const answer = fromBlocks.answer.length >= fromText.answer.length ? fromBlocks.answer : fromText.answer;
  const createdUs = typeof e.created_us === "number" ? e.created_us : 0;
  return {
    query: String(e.query_str ?? ""),
    answer,
    ...(fromBlocks.report ? { report: fromBlocks.report } : {}),
    sources: fromBlocks.sources.length ? fromBlocks.sources : fromText.sources,
    relatedQuestions: fromBlocks.relatedQuestions,
    backendUuid: String(e.backend_uuid ?? e.uuid ?? ""),
    readWriteToken: e.read_write_token ?? undefined,
    model: e.display_model ?? null,
    mode: e.mode ?? null,
    status: String(e.status ?? "COMPLETED"),
    createdAt:
      isoUtc(e.updated_datetime) || (createdUs > 0 ? new Date(Math.floor(createdUs / 1000)).toISOString() : ""),
  };
}

/**
 * Fetch a thread with all its entries (oldest first). Large threads come in pages; keep
 * requesting with a growing offset until a page adds nothing new.
 */
export async function getThread(
  page: Page,
  slugOrUrl: string,
  opts: { pageSize?: number; maxEntries?: number } = {},
): Promise<ThreadDetail> {
  const slug = normalizeSlug(slugOrUrl);
  if (!slug) throw new Error("Thread slug is empty.");
  const pageSize = opts.pageSize ?? 50;
  const maxEntries = opts.maxEntries ?? 500;
  const raw: any[] = [];
  const seen = new Set<string>();
  let hasMore = false;
  for (let offset = 0; offset < maxEntries; offset += pageSize) {
    const r = await pageFetch(
      page,
      `${PPLX_ORIGIN}/rest/thread/${encodeURIComponent(slug)}?${API_QUERY}&limit=${pageSize}&offset=${offset}` +
        "&from_first=true&with_parent_info=true&with_schematized_response=true",
    );
    if (r.status === 404) throw new Error(`Thread '${slug}' not found.`);
    if (r.status !== 200 || !r.json) throw new Error(`Thread request failed (HTTP ${r.status}).`);
    const batch: any[] = Array.isArray(r.json.entries) ? r.json.entries : [];
    let added = 0;
    for (const e of batch) {
      const key = String(e.backend_uuid ?? e.uuid ?? `#${raw.length}`);
      if (seen.has(key)) continue;
      seen.add(key);
      raw.push(e);
      added++;
    }
    hasMore = r.json.has_next_page === true;
    if (!hasMore || added === 0 || batch.length < pageSize) break;
  }
  return {
    slug,
    title: String(raw[0]?.thread_title ?? raw[0]?.query_str ?? slug),
    url: `${PPLX_ORIGIN}/search/${slug}`,
    entries: raw.map(parseThreadEntry),
    truncated: hasMore,
  };
}

/** Fill in a report's content from its signed CDN URL when it was not inlined. */
export async function ensureReportContent(report: ResearchReport): Promise<ResearchReport> {
  if (report.content || !report.url) return report;
  try {
    const r = await fetch(report.url, { signal: AbortSignal.timeout(60_000) });
    if (r.ok) return { ...report, content: await r.text() };
    log(`report download failed: HTTP ${r.status}`);
  } catch (err) {
    log(`report download failed: ${(err as Error).message}`);
  }
  return report;
}
