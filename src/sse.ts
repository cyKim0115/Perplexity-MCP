// Parser for Perplexity's /rest/sse/perplexity_ask stream.
//
// Each `event: message` carries the thread metadata plus `blocks`. A block is identified by
// `intended_usage` and either holds full state (`markdown_block`, `sources_mode_block`, ...)
// or a `diff_block` of RFC 6902 patches against one of those fields. We keep per-block
// state and apply the patches, so the final answer is exactly what the web UI renders.

export interface WebSource {
  title: string;
  url: string;
  snippet?: string;
}

export interface MediaItem {
  type: string;
  url: string;
  name?: string;
}

/** Deep Research delivers its full report as a separate markdown asset. */
export interface ResearchReport {
  title: string;
  filename: string;
  /** Signed CDN URL (expires); the content is usually inlined as well. */
  url: string;
  content: string;
}

export interface AskResult {
  answer: string;
  report?: ResearchReport;
  sources: WebSource[];
  relatedQuestions: string[];
  media: MediaItem[];
  /** Plan goals and searched queries (Pro Search / Research progress). */
  steps: string[];
  backendUuid?: string;
  contextUuid?: string;
  readWriteToken?: string;
  threadSlug?: string;
  threadTitle?: string;
  displayModel?: string;
  mode?: string;
  status?: string;
  /** True once the server sent its final COMPLETED message. */
  complete: boolean;
}

type Json = any;

interface Patch {
  op: string;
  path: string;
  value?: Json;
  from?: string;
}

function decodePointer(path: string): string[] {
  return path
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}

/** Minimal RFC 6902 applier (add/replace/remove/copy/move) that tolerates missing parents. */
export function applyPatch(doc: Json, patch: Patch): Json {
  const value = patch.op === "copy" || patch.op === "move" ? getAt(doc, patch.from ?? "") : patch.value;
  if (patch.op === "move") doc = applyPatch(doc, { op: "remove", path: patch.from ?? "" });
  const op = patch.op === "copy" || patch.op === "move" ? "add" : patch.op;
  if (op === "test") return doc;
  const parts = decodePointer(patch.path);
  if (parts.length === 0) return op === "remove" ? undefined : clone(value);
  const root = doc && typeof doc === "object" ? doc : {};
  let parent: Json = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (parent[key] === null || typeof parent[key] !== "object") {
      const next = parts[i + 1];
      parent[key] = next === "-" || /^\d+$/.test(next) ? [] : {};
    }
    parent = parent[key];
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(parent)) {
    const idx = last === "-" ? parent.length : Number(last);
    if (op === "add") parent.splice(Math.min(idx, parent.length), 0, clone(value));
    else if (op === "replace") parent[idx] = clone(value);
    else if (op === "remove") parent.splice(idx, 1);
  } else if (op === "remove") {
    delete parent[last];
  } else {
    parent[last] = clone(value);
  }
  return root;
}

function getAt(doc: Json, path: string): Json {
  let cur = doc;
  for (const key of decodePointer(path)) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function markdownText(mb: Json): string {
  if (!mb || typeof mb !== "object") return "";
  if (typeof mb.answer === "string" && mb.answer) return mb.answer;
  if (Array.isArray(mb.chunks)) return mb.chunks.filter((c: unknown) => typeof c === "string").join("");
  return "";
}

function textPayloadText(tp: Json): string {
  if (!tp || typeof tp !== "object") return "";
  if (typeof tp.text === "string" && tp.text && tp.is_streaming !== true) return tp.text;
  if (Array.isArray(tp.chunks)) return tp.chunks.filter((c: unknown) => typeof c === "string").join("");
  return typeof tp.text === "string" ? tp.text : "";
}

interface WorkflowView {
  answer: string;
  steps: string[];
  sources: Json[];
}

/**
 * The current web client (supported_block_use_cases includes "workflow_steps") gets the
 * answer inside `workflow_block.steps[].items[]`: WORKFLOW_ITEM_TEXT (variant "answer")
 * holds the markdown, WORKFLOW_ITEM_QUERIES the searched queries, WORKFLOW_ITEM_SOURCES
 * the sources read in that step.
 */
function readWorkflow(wb: Json): WorkflowView {
  const view: WorkflowView = { answer: "", steps: [], sources: [] };
  if (!wb || typeof wb !== "object" || !Array.isArray(wb.steps)) return view;
  const answers: string[] = [];
  for (const step of wb.steps) {
    if (typeof step?.title === "string" && step.title.trim()) view.steps.push(step.title.trim());
    for (const item of Array.isArray(step?.items) ? step.items : []) {
      const payload = item?.payload ?? {};
      if (item?.type === "WORKFLOW_ITEM_QUERIES") {
        for (const q of payload.queries_payload?.queries ?? []) {
          if (typeof q === "string") view.steps.push(`search: ${q}`);
          else if (typeof q?.query === "string") view.steps.push(`search: ${q.query}`);
        }
      } else if (item?.type === "WORKFLOW_ITEM_SOURCES") {
        for (const s of payload.sources_payload?.sources ?? []) view.sources.push(s);
      } else if (item?.type === "WORKFLOW_ITEM_TEXT") {
        const tp = payload.text_payload;
        const variant = item.variant ?? tp?.variant;
        const text = textPayloadText(tp);
        if (!text) continue;
        if (variant === "answer") answers.push(text);
        else view.steps.push(text.replace(/\s+/g, " ").slice(0, 300));
      }
    }
  }
  view.answer = answers.join("\n\n");
  return view;
}

/** Find RESEARCH_REPORT assets anywhere in a block state (stream or thread snapshot). */
export function findReports(root: Json, out: ResearchReport[] = [], depth = 0): ResearchReport[] {
  if (!root || typeof root !== "object" || depth > 12) return out;
  if (Array.isArray(root)) {
    for (const v of root) findReports(v, out, depth + 1);
    return out;
  }
  if (root.asset_type === "RESEARCH_REPORT" && root.research_report && typeof root.research_report === "object") {
    const r = root.research_report;
    const report: ResearchReport = {
      title: String(r.name ?? r.title ?? ""),
      filename: String(r.filename ?? r.file_name ?? ""),
      url: String(r.url ?? ""),
      content: typeof r.source_content === "string" ? r.source_content : "",
    };
    if ((report.url || report.content) && !out.some((x) => x.url === report.url && x.content === report.content)) out.push(report);
    return out;
  }
  for (const v of Object.values(root)) {
    if (v && typeof v === "object") findReports(v, out, depth + 1);
  }
  return out;
}

function sectionIndex(usage: string): number | null {
  const m = /^ask_text_(\d+)_markdown$/.exec(usage);
  return m ? Number(m[1]) : null;
}

export class AskStreamParser {
  private buffer = "";
  private blocks = new Map<string, Record<string, Json>>();
  private meta: Record<string, Json> = {};
  private related: string[] = [];
  private textAnswer = "";
  private textSources: WebSource[] = [];
  messages = 0;

  feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buffer);
      if (!m) break;
      const raw = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      this.handleEvent(raw);
    }
  }

  /** Flush a trailing event that had no blank line after it. */
  end(): void {
    if (this.buffer.trim()) this.handleEvent(this.buffer);
    this.buffer = "";
  }

  private handleEvent(raw: string): void {
    let type = "message";
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (type !== "message" || data.length === 0) return;
    let obj: Json;
    try {
      obj = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    this.applyMessage(obj);
  }

  /** Apply one message object (also used for thread entries fetched after the fact). */
  applyMessage(obj: Json): void {
    if (!obj || typeof obj !== "object") return;
    this.messages++;
    for (const key of [
      "backend_uuid",
      "context_uuid",
      "read_write_token",
      "thread_url_slug",
      "thread_title",
      "display_model",
      "mode",
      "status",
    ]) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") this.meta[key] = obj[key];
    }
    if (obj.final_sse_message === true) this.meta.final_sse_message = true;
    const relatedItems = obj.related_query_items ?? obj.related_queries;
    if (Array.isArray(relatedItems) && relatedItems.length) this.related = relatedTexts(relatedItems);
    for (const block of Array.isArray(obj.blocks) ? obj.blocks : []) {
      const usage = String(block?.intended_usage ?? "");
      if (!usage) continue;
      const state = this.blocks.get(usage) ?? {};
      for (const [key, value] of Object.entries(block)) {
        if (key === "intended_usage" || key === "diff_block") continue;
        state[key] = clone(value);
      }
      const diff = block.diff_block;
      if (diff && typeof diff.field === "string") {
        let target = state[diff.field];
        for (const patch of Array.isArray(diff.patches) ? diff.patches : []) {
          target = applyPatch(target, patch);
        }
        state[diff.field] = target;
      }
      this.blocks.set(usage, state);
    }
    // Older/non-schematized payloads carry the answer as a JSON string of steps in `text`.
    if (typeof obj.text === "string" && obj.text.startsWith("[")) {
      const parsed = parseStepsText(obj.text);
      if (parsed.answer) this.textAnswer = parsed.answer;
      if (parsed.sources.length) this.textSources = parsed.sources;
    }
  }

  result(): AskResult {
    const sections: { idx: number; text: string }[] = [];
    let mainText = "";
    let otherText = "";
    const workflow: WorkflowView = { answer: "", steps: [], sources: [] };
    let related = this.related;
    for (const [usage, state] of this.blocks) {
      if (state.workflow_block) {
        const w = readWorkflow(state.workflow_block);
        if (w.answer.length > workflow.answer.length) workflow.answer = w.answer;
        workflow.steps.push(...w.steps);
        workflow.sources.push(...w.sources);
      }
      const followups = state.pending_followups_block?.followups;
      if (!related.length && Array.isArray(followups) && followups.length) related = relatedTexts(followups);
      const text = markdownText(state.markdown_block);
      if (!text) continue;
      const idx = sectionIndex(usage);
      if (idx !== null) sections.push({ idx, text: text.trim() });
      else if (usage === "ask_text") mainText = text;
      else if (!otherText && /markdown|ask_text/.test(usage)) otherText = text;
    }
    sections.sort((a, b) => a.idx - b.idx);
    const sectionText = sections.map((s) => s.text).filter(Boolean).join("\n\n");
    // Several shapes can carry the answer; the longest one is the full rendering.
    let answer = [sectionText, mainText, workflow.answer].reduce((a, b) => (b.length > a.length ? b : a), "");
    if (!answer) answer = otherText || this.textAnswer;

    const steps = this.collectSteps();
    for (const s of workflow.steps) if (!steps.includes(s)) steps.push(s);
    const reports = findReports([...this.blocks.values()]);
    // Prefer the report that carries its content; the last one is the final version.
    const report = [...reports].reverse().find((r) => r.content) ?? reports[reports.length - 1];
    return {
      answer: answer.trim(),
      ...(report ? { report } : {}),
      sources: this.collectSources(workflow.sources),
      relatedQuestions: [...new Set(related)],
      media: this.collectMedia(),
      steps,
      backendUuid: this.meta.backend_uuid,
      contextUuid: this.meta.context_uuid,
      readWriteToken: this.meta.read_write_token,
      threadSlug: this.meta.thread_url_slug,
      threadTitle: this.meta.thread_title,
      displayModel: this.meta.display_model,
      mode: this.meta.mode,
      status: this.meta.status,
      complete: this.meta.status === "COMPLETED" || this.meta.final_sse_message === true,
    };
  }

  private collectSources(workflowSources: Json[] = []): WebSource[] {
    // sources_answer_mode is the list the [n] citations in the answer refer to: keep it first.
    const primary = this.blocks.get("sources_answer_mode")?.sources_mode_block?.web_results;
    const lists: Json[][] = [];
    if (Array.isArray(primary)) lists.push(primary);
    for (const state of this.blocks.values()) {
      for (const value of Object.values(state)) {
        if (value && typeof value === "object" && Array.isArray((value as Json).web_results)) {
          lists.push((value as Json).web_results);
        }
      }
    }
    lists.push(workflowSources);
    const seen = new Set<string>();
    const out: WebSource[] = [];
    for (const list of lists) {
      for (const r of list) {
        const url = String(r?.url ?? "");
        const title = String(r?.name ?? r?.title ?? "");
        if (!url && !title) continue;
        const key = url || title;
        if (seen.has(key)) continue;
        seen.add(key);
        const snippet = typeof r?.snippet === "string" && r.snippet ? r.snippet : undefined;
        out.push({ title, url, ...(snippet ? { snippet } : {}) });
      }
    }
    return out.length ? out : this.textSources;
  }

  private collectMedia(): MediaItem[] {
    const items = this.blocks.get("media_items")?.media_block?.media_items;
    if (!Array.isArray(items)) return [];
    return items
      .map((m: Json) => ({ type: String(m?.medium ?? m?.type ?? ""), url: String(m?.url ?? m?.image ?? ""), name: m?.name }))
      .filter((m: MediaItem) => m.url);
  }

  private collectSteps(): string[] {
    const out: string[] = [];
    const push = (s: unknown) => {
      if (typeof s === "string" && s.trim() && !out.includes(s.trim())) out.push(s.trim());
    };
    for (const state of this.blocks.values()) {
      const plan = state.plan_block;
      if (plan && typeof plan === "object") {
        for (const g of Array.isArray(plan.goals) ? plan.goals : []) push(g?.description ?? g?.text);
        for (const step of Array.isArray(plan.steps) ? plan.steps : []) {
          for (const q of step?.search_web_content?.queries ?? step?.queries ?? []) push(q?.query ?? q);
        }
      }
    }
    return out;
  }
}

function relatedTexts(items: Json[]): string[] {
  return items
    .map((r: Json) => (typeof r === "string" ? r : r?.text ?? r?.query ?? r?.question ?? ""))
    .filter((s: unknown): s is string => typeof s === "string" && !!s.trim());
}

/** Parse the legacy `text` field: a JSON array of steps whose FINAL step holds the answer. */
export function parseStepsText(text: string): { answer: string; sources: WebSource[] } {
  try {
    const steps = JSON.parse(text);
    if (!Array.isArray(steps)) return { answer: "", sources: [] };
    const final = steps.find((s: Json) => s?.step_type === "FINAL");
    const raw = final?.content?.answer;
    if (typeof raw !== "string") return { answer: "", sources: [] };
    let parsed: Json;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { answer: raw, sources: [] };
    }
    const sources = (Array.isArray(parsed?.web_results) ? parsed.web_results : [])
      .map((r: Json) => ({ title: String(r?.name ?? ""), url: String(r?.url ?? ""), snippet: r?.snippet || undefined }))
      .filter((s: WebSource) => s.title || s.url);
    return { answer: typeof parsed?.answer === "string" ? parsed.answer : "", sources };
  } catch {
    return { answer: "", sources: [] };
  }
}

export function parseSse(text: string): AskResult {
  const p = new AskStreamParser();
  p.feed(text);
  p.end();
  return p.result();
}
