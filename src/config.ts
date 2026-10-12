import { homedir } from "node:os";
import { join } from "node:path";

export const PPLX_ORIGIN = "https://www.perplexity.ai";
export const API_VERSION = "2.18";
export const API_QUERY = `version=${API_VERSION}&source=default`;
export const SESSION_COOKIE = "__Secure-next-auth.session-token";

export const DATA_DIR = process.env.PPLX_MCP_HOME || join(homedir(), ".perplexity-session-mcp");

export const paths = {
  dataDir: DATA_DIR,
  sessionFile: join(DATA_DIR, "session.enc"),
  keyFile: join(DATA_DIR, "master.key"),
  accountCache: join(DATA_DIR, "account.json"),
  loginProfile: join(DATA_DIR, "login-profile"),
  historyDir: join(DATA_DIR, "history"),
  jobsDir: join(DATA_DIR, "jobs"),
  debugDir: join(DATA_DIR, "debug"),
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const settings = {
  /** Runtime browser runs headless unless PPLX_HEADLESS=0. Login is always headed. */
  headless: process.env.PPLX_HEADLESS !== "0",
  /** Explicit browser executable; otherwise Chrome → Edge → patchright's bundled Chromium. */
  browserPath: process.env.PPLX_BROWSER_PATH || "",
  /** Close the runtime browser after this much idle time (0 = keep it open). */
  idleCloseMs: envNumber("PPLX_IDLE_CLOSE_MS", 10 * 60_000),
  language: process.env.PPLX_LANGUAGE || "en-US",
  searchModel: process.env.PPLX_SEARCH_MODEL || "pplx_pro",
  researchModel: process.env.PPLX_RESEARCH_MODEL || "pplx_alpha",
  /** Hard cap for one streamed answer (deep research can take 10+ minutes). */
  askTimeoutMs: envNumber("PPLX_ASK_TIMEOUT_MS", 40 * 60_000),
  /** Save raw SSE streams to the debug dir. */
  debug: process.env.PPLX_DEBUG === "1",
};

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function log(...args: unknown[]): void {
  // stdout is the MCP JSON-RPC channel; diagnostics go to stderr only.
  console.error("[perplexity-session-mcp]", ...args);
}
