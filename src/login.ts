// Interactive login: open a visible Chrome window on perplexity.ai, let the user sign in
// any way they like (email code, Google, Apple, SSO), then capture the session cookies.
// The login window keeps its own persistent profile so later re-logins are one click.

import { chromium, type BrowserContext, type LaunchOptions, type Page } from "patchright";
import { mkdirSync, rmSync } from "node:fs";
import { PPLX_ORIGIN, SESSION_COOKIE, log, paths, settings } from "./config.ts";
import { fetchAccountInfo, fetchSessionUser, type AccountInfo } from "./perplexity.ts";
import { clearSession, filterPerplexityState, saveSession, type SessionUser } from "./session.ts";
import { saveAccountCache } from "./account-cache.ts";
import { waitForPerplexity } from "./browser.ts";

export interface LoginOutcome {
  ok: boolean;
  message: string;
  account?: AccountInfo;
}

async function launchLoginContext(): Promise<BrowserContext> {
  mkdirSync(paths.loginProfile, { recursive: true });
  const base: LaunchOptions & { viewport: null } = { headless: false, viewport: null };
  const variants: LaunchOptions[] = [];
  if (settings.browserPath) variants.push({ ...base, executablePath: settings.browserPath });
  variants.push({ ...base, channel: "chrome" }, { ...base, channel: "msedge" }, base);
  let lastErr: unknown;
  for (const v of variants) {
    try {
      return await chromium.launchPersistentContext(paths.loginProfile, v);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Could not open a browser for login: ${(lastErr as Error)?.message ?? lastErr}`);
}

/** Any open perplexity.ai tab whose session endpoint reports a user (sign-in may finish in a popup or new tab). */
async function findSignedInPage(ctx: BrowserContext): Promise<{ page: Page; user: SessionUser } | null> {
  for (const page of ctx.pages()) {
    if (page.isClosed() || !/^https:\/\/([a-z0-9-]+\.)*perplexity\.ai\//i.test(page.url())) continue;
    const user = await fetchSessionUser(page).catch(() => null);
    if (user) return { page, user };
  }
  return null;
}

export async function interactiveLogin(opts: { timeoutMs?: number; onStatus?: (msg: string) => void } = {}): Promise<LoginOutcome> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const status = opts.onStatus ?? ((m: string) => log(m));
  status("Opening the login browser window…");
  const ctx = await launchLoginContext();
  let closedByUser = false;
  ctx.on("close", () => {
    closedByUser = true;
  });
  const closedMessage = "Login window was closed before signing in.";
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${PPLX_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    status("Loading perplexity.ai in the login window…");
    if (!(await waitForPerplexity(page, 60_000))) {
      if (closedByUser) return { ok: false, message: closedMessage };
      return { ok: false, message: "perplexity.ai did not finish loading (Cloudflare check). Try again." };
    }
    status("Browser window opened: sign in to Perplexity there. It closes by itself once you are logged in.");

    const deadline = Date.now() + timeoutMs;
    let lastReminder = Date.now();
    while (Date.now() < deadline) {
      if (closedByUser) return { ok: false, message: closedMessage };
      const cookies = await ctx.cookies(PPLX_ORIGIN).catch(() => []);
      if (cookies.some((c) => c.name === SESSION_COOKIE)) {
        const found = await findSignedInPage(ctx);
        if (found) {
          const state = filterPerplexityState((await ctx.storageState()) as never);
          await saveSession({ savedAt: new Date().toISOString(), user: found.user, storageState: state });
          const account = await fetchAccountInfo(found.page).catch((err) => {
            log("account info fetch failed:", (err as Error).message);
            return undefined;
          });
          // Never leave another account's plan info behind.
          if (account) saveAccountCache(account);
          else rmSync(paths.accountCache, { force: true });
          const who = found.user.email ?? found.user.name ?? found.user.id;
          return { ok: true, message: `Logged in as ${who}${account ? ` (${account.tier})` : ""}. Session saved.`, account };
        }
      }
      if (Date.now() - lastReminder > 15_000) {
        lastReminder = Date.now();
        status(`Waiting for sign-in in the browser window (${Math.round((deadline - Date.now()) / 1000)}s left).`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { ok: false, message: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for sign-in.` };
  } finally {
    if (!closedByUser) await ctx.close().catch(() => {});
  }
}

/** Forget the saved session. With `wipeBrowserProfile`, also sign the login window out and drop the key. */
export function logout(wipeBrowserProfile: boolean): string {
  const had = clearSession();
  rmSync(paths.accountCache, { force: true });
  if (wipeBrowserProfile) {
    rmSync(paths.loginProfile, { recursive: true, force: true });
    rmSync(paths.keyFile, { force: true });
  }
  return had
    ? `Saved session removed${wipeBrowserProfile ? ", login browser profile and encryption key wiped" : ""}.`
    : `No saved session to remove${wipeBrowserProfile ? " (login browser profile and encryption key wiped)" : ""}.`;
}
