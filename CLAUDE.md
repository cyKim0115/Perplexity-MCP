# perplexity-session-mcp

Perplexity MCP server that drives the user's own logged-in web session (no API key). See README.md for usage.

## Run / check

- `npm test` (node:test: SSE parser, history store, and all 11 tools through an in-memory MCP client on a scratch `PPLX_MCP_HOME`, no browser) · `npm run typecheck`
- Every tool spells out all four hints (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) as literals; `test/tools.test.ts` pins them, so a new or changed tool needs its row there.
- Keep what static scanners (M8ven) read plain: tool descriptions are single string literals (no `+` joins) and env vars are read as `process.env.NAME`. CI (`.github/workflows/ci.yml`) runs typecheck + tests on Node 22 and 24.
- Node ≥ 22.18 runs `src/*.ts` directly (type stripping): keep syntax erasable — no enums, no parameter properties, relative imports end in `.ts`.
- `pplx` (bin/pplx.js) runs `src/` in a linked clone and `dist/` in the npm package: Node refuses type stripping under node_modules, so `npm pack`/`publish` build `dist/` first (`prepack` → `npm run build`) and ship only `bin/` + `dist/`. The version comes from package.json (`PACKAGE_VERSION`); bump it with `npm version`.
- Live checks spend the account's quotas (deep research is only a few per day): prefer `node scripts/parse-sse.ts <capture.sse>` on streams saved with `PPLX_DEBUG=1` over new live runs.
- `node scripts/smoke-client.mjs '[["tool",{args}]]'` drives the server over stdio like a real MCP client.

## How the web API is reached (verified 2026-10-12)

- Every call is a same-origin `fetch` inside a perplexity.ai page (`page.evaluate`); plain Node HTTP is blocked by Cloudflare.
- Headless Chrome must present the regular Chrome UA (`regularUserAgent`); with "HeadlessChrome" Cloudflare challenges all `/rest/*` forever. `/api/auth/session` is never challenged, so readiness probes `/rest/user/info`.
- `buildAskBody` mirrors the web client's params (captured from the real UI). With `workflow_steps` in `supported_block_use_cases`, the answer is in `workflow_root.workflow_block.steps[].items[]` (`WORKFLOW_ITEM_TEXT`, variant `answer`); blocks arrive as full state or `diff_block` JSON patches.
- Pro search = `mode: copilot` + `model_preference: pplx_pro`; deep research = `pplx_alpha`. A follow-up's `thread_url_slug` is an alias of the original thread.

## Data

`~/.perplexity-session-mcp/` (`PPLX_MCP_HOME`): `session.enc` (AES-GCM, key in `master.key` wrapped by DPAPI on Windows), `login-profile/`, `history/`, `jobs/`, `account.json`, `debug/`. Never commit or print session contents.
