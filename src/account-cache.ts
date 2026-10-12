import { existsSync, readFileSync } from "node:fs";
import { paths } from "./config.ts";
import { atomicWrite } from "./secure-store.ts";
import type { AccountInfo } from "./perplexity.ts";

export function saveAccountCache(info: AccountInfo): void {
  atomicWrite(paths.accountCache, JSON.stringify(info, null, 2));
}

export function loadAccountCache(): AccountInfo | null {
  if (!existsSync(paths.accountCache)) return null;
  try {
    return JSON.parse(readFileSync(paths.accountCache, "utf8")) as AccountInfo;
  } catch {
    return null;
  }
}
