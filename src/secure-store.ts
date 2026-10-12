// Encrypts the saved Perplexity session at rest.
//
// A random 256-bit master key encrypts the session with AES-256-GCM. On Windows the
// master key itself is wrapped with DPAPI (CurrentUser scope), so the session file is
// useless when copied to another account or machine. Elsewhere the key sits in a 0600
// file next to the session, which only protects against casual reads.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { log, paths } from "./config.ts";

const execFileAsync = promisify(execFile);

interface KeyFile {
  scheme: "dpapi" | "plain";
  key: string;
}

interface SealedBlob {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/** The key plus the master.key mtime it was read from, so a replaced key file is noticed. */
let cached: { key: Buffer; mtimeMs: number } | null = null;

async function runPowerShell(script: string, input: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { env: { ...process.env, PPLX_DPAPI_IN: input }, windowsHide: true, timeout: 30_000 },
  );
  return stdout.trim();
}

async function dpapiProtect(raw: Buffer): Promise<string> {
  return runPowerShell(
    "Add-Type -AssemblyName System.Security; " +
      "$b = [Convert]::FromBase64String($env:PPLX_DPAPI_IN); " +
      "$p = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser'); " +
      "[Convert]::ToBase64String($p)",
    raw.toString("base64"),
  );
}

async function dpapiUnprotect(wrapped: string): Promise<Buffer> {
  const out = await runPowerShell(
    "Add-Type -AssemblyName System.Security; " +
      "$b = [Convert]::FromBase64String($env:PPLX_DPAPI_IN); " +
      "$p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'); " +
      "[Convert]::ToBase64String($p)",
    wrapped,
  );
  return Buffer.from(out, "base64");
}

/** Write via a temp file + rename. Returns the written file's mtime (rename keeps it). */
export function atomicWrite(file: string, data: string | Buffer, mode = 0o600): number {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { mode });
  const mtimeMs = statSync(tmp).mtimeMs;
  renameSync(tmp, file);
  return mtimeMs;
}

class KeyUnreadableError extends Error {
  /** True when the key can never be read (wrong user/machine, corrupt file), not a passing glitch. */
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}

async function readKeyFile(): Promise<Buffer> {
  let kf: KeyFile;
  try {
    kf = JSON.parse(readFileSync(paths.keyFile, "utf8")) as KeyFile;
  } catch (err) {
    throw new KeyUnreadableError(`${paths.keyFile} is not valid JSON (${(err as Error).message})`, true);
  }
  let key: Buffer;
  if (kf.scheme === "dpapi") {
    try {
      key = await dpapiUnprotect(kf.key);
    } catch (err) {
      const msg = (err as Error).message;
      // DPAPI refusing the blob (other user/machine, lost credentials) is permanent;
      // powershell missing or timing out is not.
      const permanent = /Cryptographic|Key not valid|parameter is incorrect|Base-64|FormatException/i.test(msg);
      throw new KeyUnreadableError(`DPAPI could not unwrap ${paths.keyFile}: ${msg.split("\n")[0]}`, permanent);
    }
  } else {
    key = Buffer.from(String(kf.key ?? ""), "base64");
  }
  if (key.length !== 32) throw new KeyUnreadableError(`${paths.keyFile} holds a key of the wrong length.`, true);
  return key;
}

async function createKey(): Promise<Buffer> {
  const raw = randomBytes(32);
  const kf: KeyFile =
    process.platform === "win32"
      ? { scheme: "dpapi", key: await dpapiProtect(raw) }
      : { scheme: "plain", key: raw.toString("base64") };
  const mtimeMs = atomicWrite(paths.keyFile, JSON.stringify(kf));
  try {
    chmodSync(paths.keyFile, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes
  }
  cached = { key: raw, mtimeMs };
  return raw;
}

/**
 * @param replaceUnreadable when saving, an existing key that can never be read is
 *   replaced (whatever it protected is unreadable anyway); reads never replace it.
 */
async function getKey(replaceUnreadable: boolean): Promise<Buffer> {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(paths.keyFile).mtimeMs;
  } catch {
    return createKey();
  }
  if (cached && cached.mtimeMs === mtimeMs) return cached.key;
  try {
    const key = await readKeyFile();
    cached = { key, mtimeMs };
    return key;
  } catch (err) {
    if (replaceUnreadable && err instanceof KeyUnreadableError && err.permanent) {
      log(`${err.message} Creating a new key; the old saved session is discarded.`);
      return createKey();
    }
    throw err;
  }
}

export async function sealJson(file: string, value: unknown): Promise<number> {
  const key = await getKey(true);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const blob: SealedBlob = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return atomicWrite(file, JSON.stringify(blob));
}

export async function unsealJson<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  const blob = JSON.parse(readFileSync(file, "utf8")) as SealedBlob;
  const key = await getKey(false);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}
