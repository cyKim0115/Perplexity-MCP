// The saved login: Perplexity cookies (plus localStorage) captured after the user signs in.

import { existsSync, rmSync, statSync } from "node:fs";
import { paths, SESSION_COOKIE } from "./config.ts";
import { sealJson, unsealJson } from "./secure-store.ts";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface StorageState {
  cookies: StoredCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
}

export interface StoredSession {
  savedAt: string;
  user: SessionUser | null;
  storageState: StorageState;
}

// Cloudflare clearance cookies are bound to the browser fingerprint that solved the
// challenge. The headed login browser and the headless runtime browser differ, so these
// are never carried over; each browser earns its own.
export const CLOUDFLARE_COOKIES = new Set(["cf_clearance", "__cf_bm", "_cfuvid", "__cflb"]);

export function filterPerplexityState(state: StorageState): StorageState {
  return {
    cookies: state.cookies.filter(
      (c) => /(^|\.)perplexity\.ai$/i.test(c.domain.replace(/^\./, "")) && !CLOUDFLARE_COOKIES.has(c.name),
    ),
    origins: state.origins.filter((o) => /^https:\/\/([a-z0-9-]+\.)*perplexity\.ai$/i.test(o.origin)),
  };
}

export function sessionTokenOf(state: StorageState | null | undefined): StoredCookie | undefined {
  return state?.cookies.find((c) => c.name === SESSION_COOKIE);
}

export async function loadSession(): Promise<StoredSession | null> {
  try {
    return await unsealJson<StoredSession>(paths.sessionFile);
  } catch (err) {
    throw new Error(
      `Saved session could not be decrypted (${(err as Error).message}). ` +
        `Run perplexity_login to replace it (if that fails too, delete ${paths.sessionFile} and ${paths.keyFile}).`,
    );
  }
}

/** Save and return the new session version (see sessionVersion). */
export async function saveSession(session: StoredSession): Promise<number> {
  return sealJson(paths.sessionFile, session);
}

export function clearSession(): boolean {
  if (!existsSync(paths.sessionFile)) return false;
  rmSync(paths.sessionFile, { force: true });
  return true;
}

/** Changes whenever any process saves a new session; used to hot-reload cookies. */
export function sessionVersion(): number {
  try {
    return statSync(paths.sessionFile).mtimeMs;
  } catch {
    return 0;
  }
}
