import type { AskResult } from "./sse.ts";

export class NotLoggedInError extends Error {
  constructor(detail = "") {
    super(
      `Not logged in to Perplexity${detail ? ` (${detail})` : ""}. ` +
        "Call the perplexity_login tool (or run `npm run login` in the server folder) and sign in in the browser window that opens.",
    );
    this.name = "NotLoggedInError";
  }
}

/** A /rest call came back as Cloudflare's HTML challenge instead of JSON. */
export class CloudflareBlockedError extends Error {
  constructor(where: string) {
    super(`Cloudflare challenged ${where}.`);
    this.name = "CloudflareBlockedError";
  }
}

/**
 * The answer stream stopped before Perplexity marked it COMPLETED. The thread keeps
 * running server-side, so callers can still recover the answer from the thread.
 */
export class StreamInterruptedError extends Error {
  readonly threadSlug?: string;
  readonly backendUuid?: string;
  readonly partial: AskResult;

  constructor(message: string, partial: AskResult) {
    super(message);
    this.name = "StreamInterruptedError";
    this.partial = partial;
    this.threadSlug = partial.threadSlug;
    this.backendUuid = partial.backendUuid;
  }
}
