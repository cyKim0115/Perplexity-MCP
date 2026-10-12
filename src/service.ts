// Everything the MCP tools (and the CLI) can do, on top of one shared runtime browser.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccountCache, saveAccountCache } from "./account-cache.ts";
import { RuntimeBrowser } from "./browser.ts";
import { PPLX_ORIGIN, log, paths, settings } from "./config.ts";
import { NotLoggedInError, StreamInterruptedError } from "./errors.ts";
import {
  CITATION_RE,
  footer,
  formatAccount,
  formatEntry,
  formatHits,
  formatLibrary,
  formatSourcesOnly,
  formatThread,
  localTime,
  mapOutsideCode,
} from "./format.ts";
import { HistoryStore, renderMarkdown, type HistoryEntry, type HistoryKind } from "./history.ts";
import { interactiveLogin, logout } from "./login.ts";
import {
  ask,
  ensureReportContent,
  fetchAccountInfo,
  getThread,
  listThreads,
  normalizeSlug,
  type AccountInfo,
  type AskMode,
  type AskProgress,
  type ThreadEntry,
} from "./perplexity.ts";
import { atomicWrite } from "./secure-store.ts";
import { loadSession } from "./session.ts";
import type { AskResult, ResearchReport } from "./sse.ts";

export type SearchStyle = "auto" | "fast" | "pro";

export interface SearchInput {
  query: string;
  style?: SearchStyle;
  model?: string;
  sources?: string[];
  language?: string;
  recency?: string;
  followUpId?: string;
  maxChars?: number;
}

export interface ResearchInput {
  query: string;
  sources?: string[];
  language?: string;
  followUpId?: string;
  /** How long to wait before handing back a job id instead of the report. */
  waitSeconds?: number;
  maxChars?: number;
}

export type ProgressFn = (message: string, elapsedMs: number) => void;

type JobStatus = "running" | "completed" | "failed" | "interrupted";

interface ResearchJob {
  id: string;
  query: string;
  followUpId?: string;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  steps: string[];
  sourceCount: number;
  answerChars: number;
  threadSlug?: string;
  backendUuid?: string;
  historyId?: string;
  error?: string;
  /** pid of the server process that ran the job; used to spot orphaned jobs. */
  pid: number;
  /** Last time the owning process wrote this job (every ~15 s while it runs). */
  updatedAt?: string;
}

/** A running job whose owner stopped writing it this long ago is treated as orphaned (pids get reused). */
const JOB_STALE_MS = 2 * 60_000;

function isOrphaned(job: ResearchJob): boolean {
  if (job.status !== "running" || job.pid === process.pid) return false;
  if (!isPidAlive(job.pid)) return true;
  const updated = Date.parse(job.updatedAt ?? job.startedAt);
  return Number.isFinite(updated) && Date.now() - updated > JOB_STALE_MS;
}

const PAID_TIERS = new Set(["Pro", "Max", "Enterprise"]);
const ACCOUNT_MAX_AGE_MS = 6 * 60 * 60_000;
const SEARCH_TIMEOUT_MS = 5 * 60_000;

/** Resolve true if `p` settles within `ms`, false otherwise; never leaves a timer behind. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true as const, () => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function progressLine(p: AskProgress): string {
  const r = p.partial;
  const bits = [formatElapsed(p.elapsedMs)];
  if (r.steps.length) bits.push(`${r.steps.length} steps`);
  if (r.sources.length) bits.push(`${r.sources.length} sources`);
  if (r.answer) bits.push(`${r.answer.length} chars written`);
  const last = r.steps[r.steps.length - 1];
  return bits.join(" · ") + (last ? ` · ${last.slice(0, 120)}` : "");
}

/** Rewrite [k] citations to [k + offset] so merged answers keep pointing at the right source. */
export function shiftCitations(text: string, offset: number, count: number): string {
  if (!offset) return text;
  return mapOutsideCode(text, (prose) =>
    prose.replace(CITATION_RE, (m, caret: string, n: string) => {
      const k = Number(n);
      return k >= 1 && k <= count ? `[${caret}${k + offset}]` : m;
    }),
  );
}

export class Service {
  readonly browser = new RuntimeBrowser();
  readonly history = new HistoryStore(paths.historyDir);
  private jobs = new Map<string, { job: ResearchJob; done: Promise<void> }>();
  /** Research being started or running, by question; registered before any await so retries attach. */
  private activeResearch = new Map<string, Promise<{ job: ResearchJob; done: Promise<void> }>>();
  /** One thread recovery at a time per job, so concurrent status calls cannot save it twice. */
  private recoveries = new Map<string, Promise<"completed" | "pending" | "missing" | "empty">>();
  /** Jobs read from disk, shared so concurrent status calls see the same object. */
  private fileJobs = new Map<string, ResearchJob>();
  private loginListeners = new Set<(msg: string) => void>();
  private account: AccountInfo | null = loadAccountCache();
  private loginInFlight: Promise<string> | null = null;

  async close(): Promise<void> {
    await this.browser.close();
  }

  // ------------------------------------------------------------ session

  /** Single-flight: a second call while the window is open waits for the same login. */
  login(timeoutSeconds: number, onStatus?: (msg: string) => void): Promise<string> {
    if (onStatus) this.loginListeners.add(onStatus);
    const release = <T>(p: Promise<T>) =>
      p.finally(() => {
        if (onStatus) this.loginListeners.delete(onStatus);
      });
    if (this.loginInFlight) {
      onStatus?.("A login window is already open; waiting for that sign-in.");
      return release(this.loginInFlight);
    }
    const broadcast = (msg: string) => {
      log(msg);
      for (const fn of this.loginListeners) fn(msg);
    };
    this.loginInFlight = interactiveLogin({ timeoutMs: timeoutSeconds * 1000, onStatus: broadcast })
      .then((out) => {
        if (out.account) this.account = out.account;
        else if (out.ok) this.account = null;
        return out.message;
      })
      .finally(() => {
        this.loginInFlight = null;
      });
    return release(this.loginInFlight);
  }

  logout(wipe: boolean): string {
    this.account = null;
    void this.browser.close();
    return logout(wipe);
  }

  private async requireSession(): Promise<void> {
    const s = await loadSession();
    if (!s) throw new NotLoggedInError();
  }

  async refreshAccount(): Promise<AccountInfo> {
    let info = await this.browser.run((page) => fetchAccountInfo(page));
    if (!info.user) throw new NotLoggedInError("the saved session has expired");
    const prev = this.account?.user?.id === info.user.id ? this.account : null;
    if (info.partial && prev) {
      // Keep what we knew for this same account instead of downgrading to guesses.
      info = {
        ...info,
        tier: prev.tier,
        models: info.models.length ? info.models : prev.models,
        defaultModels: Object.keys(info.defaultModels).length ? info.defaultModels : prev.defaultModels,
        quotas: Object.keys(info.quotas).length ? info.quotas : prev.quotas,
      };
    }
    this.account = info;
    saveAccountCache(info);
    return info;
  }

  async accountReport(refresh: boolean): Promise<string> {
    const session = await loadSession();
    if (!session) return formatAccount(null, { loggedIn: false, dataDir: paths.dataDir });
    let info = this.account?.user?.id === session.user?.id ? this.account : null;
    let note = "";
    if (refresh || !info) {
      try {
        info = await this.refreshAccount();
      } catch (err) {
        if (err instanceof NotLoggedInError || !info) throw err;
        note = `\n(Live refresh failed: ${(err as Error).message} Showing cached info.)`;
      }
    }
    return formatAccount(info, { loggedIn: true, dataDir: paths.dataDir, savedAt: session.savedAt }) + note;
  }

  async modelsReport(): Promise<string> {
    await this.tier();
    const info = this.account ?? (await this.refreshAccount());
    const d = info.defaultModels;
    const lines = [
      `Plan: ${info.tier}. Defaults: ${Object.entries(d).map(([k, v]) => `${k}=${v}`).join(", ") || "n/a"}`,
      "",
      "Model ids usable as `model` in perplexity_search (label · provider):",
      ...info.models
        .filter((m) => !m.mode || m.mode === "search")
        .map((m) => `- \`${m.id}\` — ${m.label}${m.provider ? ` · ${m.provider}` : ""}`),
    ];
    return lines.join("\n");
  }

  /** Plan tier for the saved session, refreshed when stale, partial, or for another account. */
  private async tier(): Promise<string> {
    const session = await loadSession();
    if (!session) throw new NotLoggedInError();
    const a = this.account;
    const stale =
      !a ||
      a.partial === true ||
      (session.user?.id && a.user?.id !== session.user.id) ||
      Date.now() - Date.parse(a.fetchedAt) > ACCOUNT_MAX_AGE_MS;
    if (stale) {
      try {
        await this.refreshAccount();
      } catch (err) {
        if (err instanceof NotLoggedInError) throw err;
        log("account refresh failed:", (err as Error).message);
      }
    }
    return this.account?.tier ?? "Free";
  }

  // ------------------------------------------------------------ follow-ups

  private async resolveFollowUp(
    id: string | undefined,
  ): Promise<{ backendUuid: string; readWriteToken: string | null; parentId: string | null } | undefined> {
    if (!id) return undefined;
    const entry = this.history.get(id);
    if (entry?.backendUuid) return { backendUuid: entry.backendUuid, readWriteToken: entry.readWriteToken, parentId: entry.id };
    // Not a history id: treat it as a Perplexity thread slug/URL and continue its last message.
    const slug = normalizeSlug(id);
    const thread = await this.browser.run((page) => getThread(page, slug));
    const last = thread.entries[thread.entries.length - 1];
    if (!last?.backendUuid) throw new Error(`Cannot follow up: "${id}" is neither a history id nor a readable thread.`);
    return {
      backendUuid: last.backendUuid,
      readWriteToken: last.readWriteToken ?? null,
      parentId: this.history.findByThread(slug)?.id ?? null,
    };
  }

  private saveResult(kind: HistoryKind, query: string, model: string, mode: string, r: AskResult, parentId: string | null): HistoryEntry {
    const report = r.report?.content ? r.report : undefined;
    return this.history.add({
      kind,
      query,
      title: report?.title || (r.threadTitle && kind !== "search" ? r.threadTitle : query),
      model: r.displayModel ?? model,
      mode,
      threadSlug: r.threadSlug ?? null,
      threadUrl: r.threadSlug ? `${PPLX_ORIGIN}/search/${r.threadSlug}` : null,
      // Deep research: the report is the deliverable; the chat text is its summary.
      answer: report ? report.content : r.answer,
      summary: report ? r.answer : null,
      report: report ? { title: report.title, filename: report.filename, url: report.url } : null,
      sources: r.sources,
      relatedQuestions: r.relatedQuestions,
      steps: r.steps,
      backendUuid: r.backendUuid ?? null,
      readWriteToken: r.readWriteToken ?? null,
      parentId,
    });
  }

  // ------------------------------------------------------------ search

  async search(input: SearchInput, onProgress?: ProgressFn): Promise<{ text: string; entry: HistoryEntry }> {
    await this.requireSession();
    const query = input.query.trim();
    if (!query) throw new Error("query is empty.");
    const style = input.style ?? "auto";
    let mode: AskMode;
    let model: string;
    if (input.model) {
      mode = style === "fast" ? "concise" : "copilot";
      model = input.model;
    } else if (style === "fast") {
      mode = "concise";
      model = "turbo";
    } else if (style === "pro") {
      mode = "copilot";
      model = settings.searchModel;
    } else {
      const paid = PAID_TIERS.has(await this.tier());
      mode = paid ? "copilot" : "concise";
      model = paid ? settings.searchModel : "turbo";
    }
    const followUp = await this.resolveFollowUp(input.followUpId);
    let result: AskResult;
    try {
      result = await this.browser.run((page) =>
        ask(
          page,
          {
            query,
            mode,
            model,
            sources: input.sources?.length ? input.sources : ["web"],
            language: input.language ?? settings.language,
            recency: input.recency ? input.recency.toUpperCase() : null,
            followUp,
            timeoutMs: Math.min(settings.askTimeoutMs, SEARCH_TIMEOUT_MS),
          },
          onProgress ? (p) => onProgress(progressLine(p), p.elapsedMs) : undefined,
        ),
      );
    } catch (err) {
      if (err instanceof StreamInterruptedError && err.threadSlug) {
        throw new Error(
          `${err.message} Perplexity may still finish it: read it later with perplexity_thread_get(slug="${err.threadSlug}").`,
        );
      }
      throw err;
    }
    if (!result.answer) throw new Error(`Perplexity returned no answer (status: ${result.status ?? "unknown"}).`);
    const entry = this.saveResult("search", query, model, mode, result, followUp?.parentId ?? null);
    return { text: formatEntry(entry, { maxChars: input.maxChars }), entry };
  }

  // ------------------------------------------------------------ deep research

  async research(input: ResearchInput, onProgress?: ProgressFn): Promise<{ text: string; jobId: string; done: boolean }> {
    const query = input.query.trim();
    if (!query) throw new Error("query is empty.");
    const waitMs = Math.max(0, (input.waitSeconds ?? 600) * 1000);

    // The same question already starting or running (e.g. the client timed out and the
    // model retried): attach to it instead of spending another research quota. The entry is
    // registered synchronously, before any await, so concurrent retries cannot slip past.
    const key = `${query}\u0000${input.followUpId ?? ""}`;
    const existing = this.activeResearch.get(key);
    if (existing) {
      const { job, done } = await existing;
      log(`research ${job.id} for the same question is already running; attaching to it.`);
      return this.waitForJob(job, done, waitMs, input.maxChars, onProgress, true);
    }
    // A recent run of the same question lost its stream but Perplexity is still writing it.
    const interrupted = [...this.jobs.values()]
      .map((j) => j.job)
      .find(
        (j) =>
          j.status === "interrupted" &&
          j.query === query &&
          (j.followUpId ?? "") === (input.followUpId ?? "") &&
          Date.now() - Date.parse(j.startedAt) < 60 * 60_000,
      );
    if (interrupted) {
      log(`research ${interrupted.id} for the same question is still being finished by Perplexity; following it.`);
      const text = await this.researchStatus(interrupted.id, input.waitSeconds ?? 600, onProgress, input.maxChars);
      return { jobId: interrupted.id, done: interrupted.status === "completed", text };
    }
    let detached = false;
    const started = this.startResearch(input, query, (msg, ms) => {
      if (!detached) onProgress?.(msg, ms);
    });
    this.activeResearch.set(key, started);
    started.then(
      ({ done }) => done.finally(() => this.activeResearch.delete(key)),
      () => this.activeResearch.delete(key),
    );
    const { job, done } = await started;
    const out = await this.waitForJob(job, done, waitMs, input.maxChars, onProgress, false);
    detached = true;
    return out;
  }

  private async startResearch(
    input: ResearchInput,
    query: string,
    onProgress: ProgressFn,
  ): Promise<{ job: ResearchJob; done: Promise<void> }> {
    await this.requireSession();
    const tier = await this.tier();
    if (!PAID_TIERS.has(tier)) log(`deep research on a ${tier} plan may be limited by Perplexity quotas.`);
    const followUp = await this.resolveFollowUp(input.followUpId);
    const job: ResearchJob = {
      id: `research-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomBytes(2).toString("hex")}`,
      query,
      ...(input.followUpId ? { followUpId: input.followUpId } : {}),
      status: "running",
      startedAt: new Date().toISOString(),
      steps: [],
      sourceCount: 0,
      answerChars: 0,
      pid: process.pid,
    };
    this.persistJob(job);
    let lastPersist = Date.now();
    const model = settings.researchModel;
    const done = this.browser
      .run((page) =>
        ask(
          page,
          {
            query,
            mode: "copilot",
            model,
            sources: input.sources?.length ? input.sources : ["web"],
            language: input.language ?? settings.language,
            followUp,
          },
          (p) => {
            const knewThread = !!job.threadSlug && !!job.backendUuid;
            job.steps = p.partial.steps;
            job.sourceCount = p.partial.sources.length;
            job.answerChars = p.partial.answer.length;
            job.threadSlug ??= p.partial.threadSlug;
            job.backendUuid ??= p.partial.backendUuid;
            onProgress(`job_id=${job.id} · ${progressLine(p)}`, p.elapsedMs);
            // Persist at once when the thread identity first appears (it is what makes the
            // job recoverable), then every 15 s as a liveness heartbeat.
            const gotThread = !knewThread && !!job.threadSlug && !!job.backendUuid;
            if (gotThread || Date.now() - lastPersist > 15_000) {
              lastPersist = Date.now();
              this.persistJob(job);
            }
          },
        ),
      )
      .then(async (result) => {
        result = await this.attachReport(result);
        if (!result.answer && !result.report?.content) {
          throw new Error(`Research finished without a report (status: ${result.status ?? "unknown"}).`);
        }
        const entry = this.saveResult("research", query, model, "research", result, followUp?.parentId ?? null);
        job.status = "completed";
        job.historyId = entry.id;
        job.error = undefined;
        job.threadSlug = result.threadSlug ?? job.threadSlug;
      })
      .catch((err: Error) => {
        if (err instanceof StreamInterruptedError) {
          job.threadSlug ??= err.threadSlug;
          job.backendUuid ??= err.backendUuid;
        }
        // Once Perplexity has the thread, a local failure (dropped stream, crashed page) does
        // not stop the research server-side: research_status recovers it from the thread.
        const serverSaidFailed = /^Perplexity reported the answer as/.test(err.message);
        job.status = job.threadSlug && job.backendUuid && !serverSaidFailed ? "interrupted" : "failed";
        job.error = err.message;
        log(`research ${job.id} ${job.status}: ${err.message}`);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        this.persistJob(job);
      });
    this.jobs.set(job.id, { job, done });
    return { job, done };
  }

  private async waitForJob(
    job: ResearchJob,
    done: Promise<void>,
    waitMs: number,
    maxChars: number | undefined,
    onProgress: ProgressFn | undefined,
    heartbeat: boolean,
  ): Promise<{ text: string; jobId: string; done: boolean }> {
    const beat = heartbeat && onProgress ? this.heartbeat(job, onProgress) : null;
    try {
      const finished = await settlesWithin(done, waitMs);
      if (!finished) return { jobId: job.id, done: false, text: this.runningText(job) };
      return { jobId: job.id, done: true, text: await this.jobOutcomeUntil(job, 0, maxChars) };
    } finally {
      if (beat) clearInterval(beat);
    }
  }

  private heartbeat(job: ResearchJob, onProgress: ProgressFn): NodeJS.Timeout {
    const started = Date.parse(job.startedAt);
    return setInterval(() => {
      const elapsed = Date.now() - started;
      onProgress(`job_id=${job.id} · ${job.status} · ${formatElapsed(elapsed)} · ${job.steps.length} steps · ${job.sourceCount} sources`, elapsed);
    }, 5000);
  }

  private runningText(job: ResearchJob): string {
    const last = job.steps[job.steps.length - 1];
    return (
      `Deep research is still running (job_id: \`${job.id}\`, ${formatElapsed(Date.now() - Date.parse(job.startedAt))} so far, ` +
      `${job.steps.length} steps, ${job.sourceCount} sources).` +
      (last ? `\nLatest step: ${last}` : "") +
      `\nDo not start it again. Check back with perplexity_research_status(job_id="${job.id}", wait_seconds=...). ` +
      "The finished report is also saved to history."
    );
  }

  /** Text for a finished job: the report, or recovery from the thread for interrupted/failed ones. */
  private async jobOutcome(job: ResearchJob, maxChars?: number): Promise<string> {
    if (job.status === "completed") return this.jobReport(job, maxChars);
    if (job.threadSlug && (job.status === "interrupted" || job.status === "failed")) {
      const recovered = await this.recoverJob(job, maxChars);
      if (recovered.state === "completed") return recovered.text;
      if (recovered.state === "empty") {
        job.status = "failed";
        job.error = "Perplexity finished the research but it has no readable report";
        this.persistJob(job);
      } else if (recovered.state === "pending" && job.status === "failed") {
        // Our side failed, but Perplexity is still producing it: keep following the thread.
        job.status = "interrupted";
        this.persistJob(job);
      }
      if (job.status === "interrupted") {
        return (
          `Research \`${job.id}\` lost its live stream, but Perplexity is still working on it (thread ${PPLX_ORIGIN}/search/${job.threadSlug}). ` +
          `Check again with perplexity_research_status(job_id="${job.id}", wait_seconds=...).`
        );
      }
    }
    throw new Error(
      `Deep research failed: ${job.error ?? "unknown error"}` +
        (job.threadSlug ? ` (thread ${PPLX_ORIGIN}/search/${job.threadSlug})` : ""),
    );
  }

  /**
   * Deep Research puts the full report in a RESEARCH_REPORT asset. If the stream did not
   * carry it, read it from the thread snapshot; download it if only the URL is known.
   */
  private async attachReport(result: AskResult): Promise<AskResult> {
    let report = result.report;
    if (!report?.content && result.threadSlug) {
      try {
        const thread = await this.browser.run((page) => getThread(page, result.threadSlug!));
        const entry = pickEntry(thread.entries, result.backendUuid);
        if (entry?.report) report = entry.report;
        if (!result.sources.length && entry?.sources.length) result = { ...result, sources: entry.sources };
      } catch (err) {
        log("could not read research thread for its report:", (err as Error).message);
      }
    }
    if (report && !report.content) report = await ensureReportContent(report);
    return report ? { ...result, report } : result;
  }

  private persistJob(job: ResearchJob): void {
    try {
      if (job.pid === process.pid) job.updatedAt = new Date().toISOString();
      mkdirSync(paths.jobsDir, { recursive: true });
      atomicWrite(join(paths.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2), 0o644);
    } catch (err) {
      log("job persist failed:", (err as Error).message);
    }
  }

  private readJobFile(jobId: string): ResearchJob | null {
    const file = join(paths.jobsDir, `${jobId.replace(/[^\w-]/g, "")}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as ResearchJob;
    } catch {
      return null;
    }
  }

  private jobReport(job: ResearchJob, maxChars?: number): string {
    const entry = job.historyId ? this.history.get(job.historyId) : null;
    if (!entry) throw new Error(`Research job ${job.id} has no saved report.`);
    const took = job.finishedAt ? ` in ${formatElapsed(Date.parse(job.finishedAt) - Date.parse(job.startedAt))}` : "";
    return `*Deep research completed${took} · ${entry.sourceCount} sources*\n\n${formatEntry(entry, { maxChars })}`;
  }

  async researchStatus(jobId: string, waitSeconds = 0, onProgress?: ProgressFn, maxChars?: number): Promise<string> {
    const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
    const live = this.jobs.get(jobId);
    if (live) {
      if (live.job.status === "running") {
        const beat = onProgress ? this.heartbeat(live.job, onProgress) : null;
        try {
          if (!(await settlesWithin(live.done, Math.max(0, deadline - Date.now())))) return this.runningText(live.job);
        } finally {
          if (beat) clearInterval(beat);
        }
      }
      return this.jobOutcomeUntil(live.job, deadline, maxChars, onProgress);
    }
    let job = this.fileJobs.get(jobId);
    if (!job) {
      const read = this.readJobFile(jobId);
      if (!read) throw new Error(`Unknown research job "${jobId}". perplexity_research_status without job_id lists known jobs.`);
      job = read;
      this.fileJobs.set(jobId, job);
    }
    // Running in another live server process: follow its job file.
    while (job.status === "running" && job.pid !== process.pid && !isOrphaned(job)) {
      if (Date.now() >= deadline) {
        return `${this.runningText(job)}\n(It is running in another server process, pid ${job.pid}.)`;
      }
      const elapsed = Date.now() - Date.parse(job.startedAt);
      onProgress?.(
        `job_id=${job.id} · running in another server process · ${formatElapsed(elapsed)} · ${job.steps.length} steps · ${job.sourceCount} sources`,
        elapsed,
      );
      await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
      const fresh = this.readJobFile(jobId);
      if (fresh) Object.assign(job, fresh);
    }
    if (job.status === "running") job.status = "interrupted"; // its process is gone or silent
    return this.jobOutcomeUntil(job, deadline, maxChars, onProgress);
  }

  /** jobOutcome, retrying thread recovery until the deadline for jobs Perplexity is still finishing. */
  private async jobOutcomeUntil(job: ResearchJob, deadline: number, maxChars?: number, onProgress?: ProgressFn): Promise<string> {
    for (;;) {
      let text: string;
      try {
        text = await this.jobOutcome(job, maxChars);
      } catch (err) {
        // A failed thread read while Perplexity may still be working is not the job's failure.
        if (err instanceof NotLoggedInError || job.status !== "interrupted") throw err;
        log(`recovery of ${job.id} hit an error, will retry: ${(err as Error).message}`);
        text =
          `Research \`${job.id}\` could not be checked just now (${(err as Error).message}). ` +
          `Its thread: ${PPLX_ORIGIN}/search/${job.threadSlug}. Try perplexity_research_status(job_id="${job.id}") again.`;
      }
      if (job.status !== "interrupted" || Date.now() + 15_000 > deadline) return text;
      onProgress?.(`job_id=${job.id} · waiting for Perplexity to finish the thread`, Date.now() - Date.parse(job.startedAt));
      await sleep(15_000);
    }
  }

  /**
   * Save the job's finished entry from its Perplexity thread. One recovery per job at a
   * time, so concurrent status calls cannot save the same report twice.
   */
  private recoverJob(
    job: ResearchJob,
    maxChars?: number,
  ): Promise<{ state: "completed"; text: string } | { state: "pending" | "missing" | "empty" }> {
    const inflight = this.recoveries.get(job.id);
    const run = inflight ?? this.recoverJobOnce(job).finally(() => this.recoveries.delete(job.id));
    if (!inflight) this.recoveries.set(job.id, run);
    return run.then((state) => (state === "completed" ? { state, text: this.jobReport(job, maxChars) } : { state }));
  }

  private async recoverJobOnce(job: ResearchJob): Promise<"completed" | "pending" | "missing" | "empty"> {
    if (job.status === "completed" && job.historyId) return "completed";
    if (!job.threadSlug) return "missing";
    const thread = await this.browser.run((page) => getThread(page, job.threadSlug!));
    const entry = pickEntry(thread.entries, job.backendUuid);
    if (!entry) return "missing";
    if (/fail|error|cancel/i.test(entry.status)) {
      job.status = "failed";
      job.error = `Perplexity reported the research as ${entry.status.toLowerCase()}.`;
      this.persistJob(job);
      throw new Error(`Deep research failed: ${job.error} (thread ${thread.url})`);
    }
    if (!/^completed$/i.test(entry.status)) return "pending";
    if (!(entry.answer || entry.report)) return "empty";
    // Another process (or an earlier call) may have saved it already.
    const saved = this.history.findByThread(thread.slug, "research");
    const savedEntry = saved ? this.history.get(saved.id) : null;
    if (savedEntry && savedEntry.backendUuid === entry.backendUuid) {
      job.historyId = savedEntry.id;
    } else {
      const report: ResearchReport | undefined = entry.report ? await ensureReportContent(entry.report) : undefined;
      const hasReport = !!report?.content;
      job.historyId = this.history.add({
        kind: "research",
        query: job.query,
        title: (hasReport && report!.title) || thread.title,
        model: entry.model,
        mode: "research",
        threadSlug: thread.slug,
        threadUrl: thread.url,
        answer: hasReport ? report!.content : entry.answer,
        summary: hasReport ? entry.answer : null,
        report: hasReport ? { title: report!.title, filename: report!.filename, url: report!.url } : null,
        sources: entry.sources,
        relatedQuestions: entry.relatedQuestions,
        steps: job.steps,
        backendUuid: entry.backendUuid || null,
        readWriteToken: entry.readWriteToken ?? null,
        parentId: null,
      }).id;
    }
    job.status = "completed";
    job.error = undefined;
    job.finishedAt ??= new Date().toISOString();
    job.pid = process.pid;
    this.persistJob(job);
    return "completed";
  }

  /** Jobs of this process plus recent ones persisted by earlier/other server processes. */
  listJobs(): string {
    const byId = new Map<string, ResearchJob>();
    try {
      for (const f of readdirSync(paths.jobsDir)) {
        if (!f.endsWith(".json")) continue;
        const job = this.readJobFile(f.slice(0, -5));
        if (job) byId.set(job.id, job);
      }
    } catch {
      // no jobs dir yet
    }
    for (const { job } of this.jobs.values()) byId.set(job.id, job);
    const jobs = [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 15);
    if (!jobs.length) {
      return 'No research jobs yet. Past reports are in history: perplexity_history_search(query="", kind="research").';
    }
    return [
      "Research jobs (newest first):",
      ...jobs.map((j) => {
        let status: string = j.status;
        if (isOrphaned(j)) status = "interrupted (its server stopped)";
        return (
          `- \`${j.id}\` · ${status} · started ${localTime(j.startedAt)} · ${j.query.slice(0, 80)}` +
          (j.historyId ? ` → history_id \`${j.historyId}\`` : "")
        );
      }),
      "",
      "Get a report or recover an interrupted job with perplexity_research_status(job_id).",
    ].join("\n");
  }

  // ------------------------------------------------------------ history & library

  historySearchReport(input: { query: string; limit?: number; kind?: HistoryKind; since?: string }): string {
    return formatHits(input.query, this.history.search(input), !!(input.kind || input.since));
  }

  historyGet(input: { id: string; offset?: number; maxChars?: number; sourcesOnly?: boolean }): string {
    const e = this.history.get(input.id);
    if (!e) throw new Error(`No saved answer with id "${input.id}". Use perplexity_history_search to find ids.`);
    if (input.sourcesOnly) return formatSourcesOnly(e, input.offset, input.maxChars);
    const head = `# ${e.title}\n*${localTime(e.createdAt)} · ${e.kind}* — query: ${e.query}\n\n`;
    const summary = e.summary && !input.offset ? `**Summary:** ${e.summary.trim()}\n\n` : "";
    return head + summary + formatEntry(e, { offset: input.offset, maxChars: input.maxChars });
  }

  /** The whole saved entry as Markdown (resources are not subject to tool-output paging). */
  historyMarkdown(id: string): string {
    const e = this.history.get(id);
    if (!e) throw new Error(`No saved answer with id "${id}".`);
    return renderMarkdown(e);
  }

  async librarySearch(input: { query?: string; limit?: number; offset?: number }): Promise<string> {
    await this.requireSession();
    const limit = input.limit ?? 20;
    const res = await this.browser.run((page) =>
      listThreads(page, { searchTerm: input.query ?? "", limit, offset: input.offset ?? 0 }),
    );
    return formatLibrary(input.query ?? "", res, input.offset ?? 0, limit);
  }

  async threadGet(input: { slug: string; save?: boolean; maxChars?: number }): Promise<string> {
    await this.requireSession();
    const thread = await this.browser.run((page) => getThread(page, input.slug));
    // Show deep research entries as their full report.
    for (const e of thread.entries) {
      if (!e.report) continue;
      const report = await ensureReportContent(e.report);
      if (report.content) {
        e.report = report;
        e.answer = report.content;
      }
    }
    let savedId: string | undefined;
    let saved = "";
    const answered = thread.entries.filter((e) => e.answer);
    const last = answered[answered.length - 1];
    if (input.save && !last) saved = "\n---\n(Not saved to history: no message in this thread has an answer yet.)";
    if (input.save && last) {
      const multi = thread.entries.length > 1;
      // One merged source list: shift each message's [n] past the previous messages' sources.
      let offset = 0;
      const answers: string[] = [];
      for (const [i, e] of thread.entries.entries()) {
        const body = e.answer ? shiftCitations(e.answer, offset, e.sources.length) : "*(no answer)*";
        answers.push(multi ? `## ${i + 1}. ${e.query}\n\n${body}` : body);
        offset += e.sources.length;
      }
      const answer = answers.join("\n\n");
      const existing = this.history.findByThread(thread.slug, "thread");
      const prior = existing ? this.history.get(existing.id) : null;
      if (prior && prior.answer === answer) {
        savedId = prior.id;
        saved = `\n---\n(Already in history.)\n${footer(prior)}`;
      } else {
        const entry = this.history.add({
          kind: "thread",
          query: thread.entries.map((e) => e.query).join(" / "),
          title: thread.title,
          model: last.model,
          mode: last.mode,
          threadSlug: thread.slug,
          threadUrl: thread.url,
          answer,
          sources: thread.entries.flatMap((e) => e.sources),
          relatedQuestions: last.relatedQuestions,
          steps: [],
          backendUuid: last.backendUuid || null,
          readWriteToken: last.readWriteToken ?? null,
          parentId: null,
        });
        savedId = entry.id;
        saved = `\n---\n${footer(entry)}`;
      }
    }
    return formatThread(thread, input.maxChars ?? 60_000, savedId) + saved;
  }
}

/** The thread entry for `backendUuid`, or the newest entry when the uuid is unknown. */
function pickEntry(entries: ThreadEntry[], backendUuid: string | undefined): ThreadEntry | undefined {
  if (backendUuid) return entries.find((e) => e.backendUuid === backendUuid);
  return entries[entries.length - 1];
}
