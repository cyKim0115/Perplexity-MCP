// MCP server: registers the tools and resources over stdio.

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { log } from "./config.ts";
import { localTime } from "./format.ts";
import { Service, type ProgressFn } from "./service.ts";

const VERSION = "0.1.0";

const INSTRUCTIONS = `Perplexity through the user's own logged-in Perplexity account (no API key).
- Not logged in? Call perplexity_login: a browser window opens and the user signs in; the session is saved and reused.
- perplexity_search: web answer with citations (Pro Search on paid plans). Pass follow_up_id to continue a previous answer's thread.
- perplexity_research: deep research report (minutes; a few per day on Pro). If the call times out or returns a job_id, never start the same research again: use perplexity_research_status (without job_id it lists jobs).
- Every answer is saved locally with a history_id. Before re-asking something, check perplexity_history_search; reopen full answers with perplexity_history_get.
- perplexity_library_search / perplexity_thread_get read the user's Perplexity library, including threads made on the website or apps.`;

type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: any) => Promise<void>;
};

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function guard(fn: () => Promise<string> | string): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

/**
 * Run a handler with an MCP progress reporter (when the client sent a progressToken).
 * Progress keeps long calls alive in clients that reset their timeout on progress; the
 * reporter goes silent once the handler returns, even if background work continues.
 */
async function withProgress(
  extra: unknown,
  minIntervalMs: number,
  fn: (progress: ProgressFn | undefined) => Promise<string> | string,
): Promise<CallToolResult> {
  const { _meta, sendNotification } = extra as Extra;
  const token = _meta?.progressToken;
  let closed = false;
  let last = 0;
  let count = 0;
  const progress: ProgressFn | undefined =
    token === undefined
      ? undefined
      : (message) => {
          const now = Date.now();
          if (closed || now - last < minIntervalMs) return;
          last = now;
          count++;
          sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: count, message } }).catch(
            () => {},
          );
        };
  try {
    return await guard(() => fn(progress));
  } finally {
    closed = true;
  }
}

const sourcesSchema = z
  .array(z.enum(["web", "scholar", "social"]))
  .optional()
  .describe('Where to search: "web" (default), "scholar" (academic papers), "social" (discussions/forums).');

const languageSchema = z
  .string()
  .optional()
  .describe('UI locale sent to Perplexity, e.g. "en-US" or "ko-KR". Answers follow the language of the query either way.');

const maxCharsSchema = z
  .number()
  .int()
  .min(1000)
  .max(200_000)
  .optional()
  .describe("Max characters of answer text in this response (long text is also capped to fit client limits; the rest stays readable via perplexity_history_get offset).");

export function createServer(svc: Service): McpServer {
  const server = new McpServer({ name: "perplexity-session", version: VERSION }, { instructions: INSTRUCTIONS });

  // New answers become new resources.
  svc.history.onAdd = () => {
    if (server.isConnected()) server.sendResourceListChanged();
  };

  server.registerTool(
    "perplexity_login",
    {
      title: "Log in to Perplexity",
      description:
        "Open a browser window on perplexity.ai so the user can sign in (email code, Google, Apple, SSO). " +
        "Waits until sign-in completes, then saves the session encrypted on disk for all later calls. " +
        "Tell the user to look for the browser window before calling. A second call while the window is open waits for the same login.",
      inputSchema: {
        timeout_seconds: z.number().int().min(30).max(1800).optional().describe("How long to wait for the user (default 300)."),
      },
      annotations: { openWorldHint: true },
    },
    async ({ timeout_seconds }, extra) =>
      withProgress(extra, 1000, (progress) => svc.login(timeout_seconds ?? 300, progress && ((m) => progress(m, 0)))),
  );

  server.registerTool(
    "perplexity_logout",
    {
      title: "Log out",
      description:
        "Delete the saved Perplexity session from this machine. Optionally also wipe the login browser profile and the encryption key.",
      inputSchema: {
        wipe_browser_profile: z.boolean().optional().describe("Also sign out the login browser window and delete the encryption key."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ wipe_browser_profile }) => guard(() => svc.logout(wipe_browser_profile ?? false)),
  );

  server.registerTool(
    "perplexity_account",
    {
      title: "Account status",
      description: "Show whether a session is saved, which account and plan it is, and remaining Pro Search / Research quotas.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Fetch fresh numbers from Perplexity instead of the cached snapshot (default true)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh }) => guard(() => svc.accountReport(refresh ?? true)),
  );

  server.registerTool(
    "perplexity_models",
    {
      title: "List models",
      description: "List the model ids this account can pass as `model` to perplexity_search.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => guard(() => svc.modelsReport()),
  );

  server.registerTool(
    "perplexity_search",
    {
      title: "Perplexity search",
      description:
        "Ask Perplexity a question and get a web-grounded answer with numbered sources. " +
        "Uses Pro Search automatically on paid plans. The answer is saved to local history (history_id in the footer). " +
        "Use follow_up_id (a history_id, or a Perplexity thread URL/slug) to ask a follow-up in the same thread.",
      inputSchema: {
        query: z.string().min(1).describe("The question or search query."),
        style: z
          .enum(["auto", "fast", "pro"])
          .optional()
          .describe('"auto" (default): Pro Search if the plan allows; "fast": quick answer; "pro": force Pro Search.'),
        model: z.string().optional().describe("Specific model id from perplexity_models (e.g. a reasoning model). Optional."),
        sources: sourcesSchema,
        recency: z.enum(["day", "week", "month", "year"]).optional().describe("Only use sources from this recent period."),
        language: languageSchema,
        follow_up_id: z.string().optional().describe("history_id or thread URL/slug to continue."),
        max_chars: maxCharsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ query, style, model, sources, recency, language, follow_up_id, max_chars }, extra) =>
      withProgress(extra, 2500, async (progress) =>
        (
          await svc.search(
            { query, style, model, sources, recency, language, followUpId: follow_up_id, maxChars: max_chars },
            progress,
          )
        ).text,
      ),
  );

  server.registerTool(
    "perplexity_research",
    {
      title: "Perplexity deep research",
      description:
        "Run Perplexity Deep Research: many searches plus a long, cited report (usually 2–10 minutes; uses one of the account's limited research runs). " +
        "Waits up to wait_seconds; if still running it returns a job_id for perplexity_research_status. " +
        "If this call is interrupted or times out, do NOT call it again for the same question: call perplexity_research_status " +
        "(without job_id it lists running jobs). The finished report is always saved to local history.",
      inputSchema: {
        query: z.string().min(1).describe("The research question. Be specific about scope and what the report should cover."),
        sources: sourcesSchema,
        language: languageSchema,
        follow_up_id: z.string().optional().describe("history_id or thread URL/slug to research as a follow-up."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(3600)
          .optional()
          .describe("Max seconds to block before returning a job_id (default 600). Use 0 to start it in the background."),
        max_chars: maxCharsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ query, sources, language, follow_up_id, wait_seconds, max_chars }, extra) =>
      withProgress(extra, 5000, async (progress) =>
        (
          await svc.research(
            { query, sources, language, followUpId: follow_up_id, waitSeconds: wait_seconds, maxChars: max_chars },
            progress,
          )
        ).text,
      ),
  );

  server.registerTool(
    "perplexity_research_status",
    {
      title: "Deep research status",
      description:
        "Check a deep research job started by perplexity_research and return the report once it is done; also recovers jobs " +
        "whose server restarted or whose stream dropped. Omit job_id to list recent jobs.",
      inputSchema: {
        job_id: z.string().optional().describe("The job_id returned by perplexity_research."),
        wait_seconds: z.number().int().min(0).max(1800).optional().describe("Block up to this many seconds for completion (default 0)."),
        max_chars: maxCharsSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ job_id, wait_seconds, max_chars }, extra) =>
      withProgress(extra, 5000, (progress) =>
        job_id ? svc.researchStatus(job_id, wait_seconds ?? 0, progress, max_chars) : svc.listJobs(),
      ),
  );

  server.registerTool(
    "perplexity_history_search",
    {
      title: "Search saved answers",
      description:
        "Full-text search over every answer and research report saved locally (query, answer text, source titles/URLs). " +
        'All terms must match; "quoted phrases" stay together. Empty query lists the most recent answers. Returns ids and snippets.',
      inputSchema: {
        query: z.string().describe("Search terms (Korean and English both work; substring match). Empty lists recent answers."),
        kind: z.enum(["search", "research", "thread"]).optional().describe("Only this kind of entry."),
        since: z.string().optional().describe("Only entries created on/after this date: 2026-10-01 (local midnight) or an ISO date-time."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, kind, since, limit }) => guard(() => svc.historySearchReport({ query, kind, since, limit })),
  );

  server.registerTool(
    "perplexity_history_get",
    {
      title: "Open a saved answer",
      description:
        "Return a saved answer/report in full with its sources. Long reports come in pages: continue with the offset the response gives. " +
        "sources_only=true lists every source with its [n] number.",
      inputSchema: {
        id: z.string().describe("history_id from a search result footer or perplexity_history_search."),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)."),
        max_chars: maxCharsSchema,
        sources_only: z.boolean().optional().describe("Return the full numbered source list instead of the answer."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, offset, max_chars, sources_only }) =>
      guard(() => svc.historyGet({ id, offset, maxChars: max_chars, sourcesOnly: sources_only })),
  );

  server.registerTool(
    "perplexity_library_search",
    {
      title: "Search Perplexity library",
      description:
        "Search the user's Perplexity library on perplexity.ai (all threads, including ones made in the browser or apps). " +
        "Empty query lists the newest threads.",
      inputSchema: {
        query: z.string().optional().describe("Search term; empty lists recent threads."),
        limit: z.number().int().min(1).max(100).optional().describe("Max threads (default 20)."),
        offset: z.number().int().min(0).optional().describe("Paging offset (default 0)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit, offset }) => guard(() => svc.librarySearch({ query, limit, offset })),
  );

  server.registerTool(
    "perplexity_thread_get",
    {
      title: "Read a Perplexity thread",
      description:
        "Fetch a whole thread from the user's Perplexity library by slug or URL (all questions and answers with sources; " +
        "deep research entries come back as their full report). By default also saves it to local history so it becomes " +
        "searchable and usable for follow-ups.",
      inputSchema: {
        slug: z.string().describe("Thread slug or https://www.perplexity.ai/search/... URL."),
        save: z.boolean().optional().describe("Save into local history (default true)."),
        max_chars: maxCharsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ slug, save, max_chars }) => guard(() => svc.threadGet({ slug, save: save ?? true, maxChars: max_chars })),
  );

  server.registerResource(
    "history",
    new ResourceTemplate("perplexity-history://{id}", {
      list: async () => ({
        resources: svc.history.list({ limit: 50 }).items.map((m) => ({
          uri: `perplexity-history://${m.id}`,
          name: m.title,
          title: m.title,
          description: `${m.kind} · ${localTime(m.createdAt)} · ${m.sourceCount} sources`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Saved Perplexity answers",
      description: "Answers and research reports saved by this server, as Markdown.",
      mimeType: "text/markdown",
    },
    async (uri, { id }) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: svc.historyMarkdown(String(id)) }],
    }),
  );

  return server;
}

export async function startServer(): Promise<void> {
  const svc = new Service();
  const server = createServer(svc);
  let closing = false;
  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    log(`shutting down (${why}).`);
    await svc.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await server.connect(new StdioServerTransport());
  log(`ready (v${VERSION}).`);
}
