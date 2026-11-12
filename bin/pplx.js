#!/usr/bin/env node
// Command entry for `pplx` / `perplexity-session-mcp`. A git clone (linked with `npm link`) runs the
// TypeScript sources directly, so `git pull` takes effect at once; the npm package ships only the
// compiled `dist/`, because Node does not strip types for files under node_modules.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = new URL("../src/index.ts", import.meta.url);
const runSource = existsSync(src) && !/[\/]node_modules[\/]/.test(fileURLToPath(src));
await import(runSource ? src.href : new URL("../dist/index.js", import.meta.url).href);
