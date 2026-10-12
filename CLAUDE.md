# perplexity-session-mcp

Perplexity MCP server that drives the user's own logged-in web session (no API key). See README.md for usage.

## Run / check

- `npm test` (node:test, pure units: SSE parser, history store) · `npm run typecheck`
- Node ≥ 22.18 runs `src/*.ts` directly (type stripping): keep syntax erasable — no enums, no parameter properties, relative imports end in `.ts`.
- Live checks spend the account's quotas (deep research is only a few per day): prefer `node scripts/parse-sse.ts <capture.sse>` on streams saved with `PPLX_DEBUG=1` over new live runs.
- `node scripts/smoke-client.mjs '[["tool",{args}]]'` drives the server over stdio like a real MCP client.

## How the web API is reached (verified 2026-10-12)

- Every call is a same-origin `fetch` inside a perplexity.ai page (`page.evaluate`); plain Node HTTP is blocked by Cloudflare.
- Headless Chrome must present the regular Chrome UA (`regularUserAgent`); with "HeadlessChrome" Cloudflare challenges all `/rest/*` forever. `/api/auth/session` is never challenged, so readiness probes `/rest/user/info`.
- `buildAskBody` mirrors the web client's params (captured from the real UI). With `workflow_steps` in `supported_block_use_cases`, the answer is in `workflow_root.workflow_block.steps[].items[]` (`WORKFLOW_ITEM_TEXT`, variant `answer`); blocks arrive as full state or `diff_block` JSON patches.
- Pro search = `mode: copilot` + `model_preference: pplx_pro`; deep research = `pplx_alpha`. A follow-up's `thread_url_slug` is an alias of the original thread.

## Data

`~/.perplexity-session-mcp/` (`PPLX_MCP_HOME`): `session.enc` (AES-GCM, key in `master.key` wrapped by DPAPI on Windows), `login-profile/`, `history/`, `jobs/`, `account.json`, `debug/`. Never commit or print session contents.
