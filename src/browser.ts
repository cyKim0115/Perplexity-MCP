// Runtime browser: a real Chrome driven by patchright. All Perplexity API calls run as
// same-origin fetch() inside a perplexity.ai page so they carry the browser's TLS
// fingerprint and Cloudflare clearance; plain Node HTTP gets challenged.

import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "patchright";
import { PPLX_ORIGIN, SESSION_COOKIE, log, settings } from "./config.ts";
import { CloudflareBlockedError, NotLoggedInError } from "./errors.ts";
import {
  CLOUDFLARE_COOKIES,
  filterPerplexityState,
  loadSession,
  saveSession,
  sessionTokenOf,
  sessionVersion,
  type SessionUser,
} from "./session.ts";

export { NotLoggedInError } from "./errors.ts";

const OFFSCREEN_ARG = "--window-position=-32000,-32000";

/** Launch Chrome, falling back to Edge and then patchright's bundled Chromium. */
export async function launchBrowser(opts: { headless: boolean; args?: string[] }): Promise<Browser> {
  const base: LaunchOptions = { headless: opts.headless, args: opts.args ?? [] };
  const attempts: { label: string; options: LaunchOptions }[] = [];
  if (settings.browserPath) {
    attempts.push({ label: settings.browserPath, options: { ...base, executablePath: settings.browserPath } });
  }
  attempts.push({ label: "chrome", options: { ...base, channel: "chrome" } });
  attempts.push({ label: "msedge", options: { ...base, channel: "msedge" } });
  attempts.push({ label: "bundled chromium", options: base });
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch(attempt.options);
      log(`browser: ${attempt.label} ${browser.version()} (${opts.headless ? "headless" : "headed"})`);
      return browser;
    } catch (err) {
      errors.push(`${attempt.label}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    "No usable browser found. Install Google Chrome, or set PPLX_BROWSER_PATH, " +
      "or run `npx patchright install chromium`.\n" + errors.join("\n"),
  );
}

/**
 * Headless Chrome announces itself as "HeadlessChrome" in its user agent, and Cloudflare
 * then challenges every /rest/* call forever. Presenting the regular Chrome UA string
 * (same version, same platform) passes instantly.
 */
export function regularUserAgent(browser: Browser): string {
  const major = browser.version().split(".")[0];
  const platform =
    process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : process.platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait until the page can talk to the Perplexity API (Cloudflare challenge solved).
 * /api/auth/session is not challenged, so probe a /rest endpoint; a JSON reply (even
 * 401 when logged out) means Cloudflare let us through. Matching the challenge page
 * title would not work: it is localized ("Just a moment...", "잠시만 기다리십시오…").
 */
export async function waitForPerplexity(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return false;
    try {
      const probe = await page.evaluate(async () => {
        const r = await fetch("/rest/user/info?version=2.18&source=default", { credentials: "include" });
        return { status: r.status, json: (r.headers.get("content-type") ?? "").includes("json") };
      });
      if (probe.json) return true;
    } catch {
      // navigation in progress (challenge redirect) destroys the execution context
    }
    await sleep(1000);
  }
  return false;
}

export class RuntimeBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private broken = false;
  private starting: Promise<Page> | null = null;
  private recovering: Promise<Page> | null = null;
  /** Tabs replaced by recoverPage, closed once no call is running. */
  private retired: Page[] = [];
  private loadedVersion = 0;
  private lastTokenSig = "";
  private user: SessionUser | null = null;
  private active = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  get isOpen(): boolean {
    return !!this.page && !this.page.isClosed() && !this.broken;
  }

  /**
   * Run `fn` against a ready perplexity.ai page. Concurrent calls share the page.
   * A Cloudflare challenge in the middle of a session gets one page reload and retry.
   */
  async run<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    this.active++;
    this.clearIdle();
    try {
      const page = await this.ensurePage();
      try {
        return await fn(page);
      } catch (err) {
        if (!(err instanceof CloudflareBlockedError)) throw err;
        log(`${err.message} Reloading perplexity.ai and retrying once.`);
        return await fn(await this.recoverPage(page));
      }
    } finally {
      this.active--;
      if (this.active === 0 && this.retired.length) {
        for (const old of this.retired.splice(0)) await old.close().catch(() => {});
      }
      await this.persistCookies().catch((err) => log("cookie persist failed:", (err as Error).message));
      this.armIdle();
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.starting) return this.starting;
    if (this.isOpen && this.context) {
      if (sessionVersion() !== this.loadedVersion) await this.reloadCookies();
      return this.page!;
    }
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<Page> {
    await this.close();
    // Take the version before reading: a save landing in between then triggers a reload.
    const version = sessionVersion();
    const session = await loadSession();
    if (!session || !sessionTokenOf(session.storageState)) throw new NotLoggedInError();
    this.user = session.user;
    this.loadedVersion = version;
    this.lastTokenSig = tokenSig(sessionTokenOf(session.storageState));

    let headless = settings.headless;
    for (let attempt = 0; attempt < 2; attempt++) {
      const browser = await launchBrowser({ headless, args: headless ? [] : [OFFSCREEN_ARG] });
      this.browser = browser;
      this.broken = false;
      browser.on("disconnected", () => {
        if (this.browser === browser) this.markBroken("browser disconnected");
      });
      this.context = await browser.newContext({
        storageState: filterPerplexityState(session.storageState),
        viewport: headless ? { width: 1366, height: 900 } : null,
        ...(headless ? { userAgent: regularUserAgent(browser) } : {}),
      });
      const page = await this.context.newPage();
      this.page = page;
      this.watchPage(page);
      await page
        .goto(`${PPLX_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 45_000 })
        .catch((err) => log("navigation warning:", (err as Error).message));
      if (await waitForPerplexity(page, 30_000)) return page;
      await this.close();
      if (!headless) break;
      log("Cloudflare did not clear in headless mode; retrying with an off-screen window.");
      headless = false;
    }
    throw new Error("Could not get past Cloudflare on perplexity.ai. Try again later or set PPLX_HEADLESS=0.");
  }

  private markBroken(why: string): void {
    if (this.broken) return;
    this.broken = true;
    log(`runtime browser unusable (${why}); the next call starts a fresh one.`);
  }

  private watchPage(page: Page): void {
    page.on("crash", () => {
      if (this.page === page) this.markBroken("page crashed");
    });
    page.on("close", () => {
      if (this.page === page) this.markBroken("page closed");
    });
  }

  /**
   * Earn a fresh Cloudflare clearance on a new tab and make it the shared page. The old tab
   * keeps serving in-flight calls (their in-page streams live there) and is closed once idle.
   * Only when nothing else is running may the whole browser be restarted.
   */
  private recoverPage(failed: Page): Promise<Page> {
    if (this.isOpen && this.page !== failed) return Promise.resolve(this.page!); // already swapped
    this.recovering ??= (async () => {
      if (this.context && this.isOpen) {
        const fresh = await this.context.newPage();
        await fresh.goto(`${PPLX_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
        if (await waitForPerplexity(fresh, 30_000)) {
          if (this.page) this.retired.push(this.page);
          this.page = fresh;
          this.watchPage(fresh);
          return fresh;
        }
        await fresh.close().catch(() => {});
      }
      if (this.active > 1) throw new Error("Cloudflare challenge could not be cleared right now; try again shortly.");
      await this.close();
      return this.ensurePage();
    })().finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  /** Another process (or the login tool) saved a new session: swap its cookies in place. */
  private async reloadCookies(): Promise<void> {
    const version = sessionVersion();
    const session = await loadSession();
    if (!session || !this.context) return;
    const state = filterPerplexityState(session.storageState);
    // Keep the Cloudflare cookies this browser earned; the saved session never has them.
    const keep = new RegExp(`^(?!(${[...CLOUDFLARE_COOKIES].join("|")})$)`);
    await this.context.clearCookies({ domain: /perplexity\.ai$/, name: keep });
    await this.context.addCookies(state.cookies);
    this.user = session.user;
    this.loadedVersion = version;
    this.lastTokenSig = tokenSig(sessionTokenOf(state));
    log("reloaded session cookies from disk.");
  }

  /** Perplexity refreshes the session cookie as it is used; keep the saved copy current. */
  private async persistCookies(): Promise<void> {
    if (!this.context || !this.isOpen) return;
    const cookies = await this.context.cookies(PPLX_ORIGIN);
    const token = cookies.find((c) => c.name === SESSION_COOKIE);
    if (!token) return; // never overwrite a good session with a logged-out one
    const sig = tokenSig(token);
    if (sig === this.lastTokenSig) return;
    const state = filterPerplexityState((await this.context.storageState()) as never);
    // Check right before writing: never clobber a login another process just saved.
    if (sessionVersion() !== this.loadedVersion) return;
    this.loadedVersion = await saveSession({ savedAt: new Date().toISOString(), user: this.user, storageState: state });
    this.lastTokenSig = sig;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle(): void {
    if (this.active > 0 || settings.idleCloseMs <= 0 || !this.browser) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (this.active === 0) {
        log("closing idle browser.");
        void this.close();
      }
    }, settings.idleCloseMs);
    this.idleTimer.unref();
  }

  async close(): Promise<void> {
    this.clearIdle();
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.retired = [];
    this.broken = false;
    if (browser) await browser.close().catch(() => {});
  }
}

function tokenSig(cookie: { value: string; expires: number } | undefined): string {
  return cookie ? `${cookie.value}|${Math.round(cookie.expires)}` : "";
}
