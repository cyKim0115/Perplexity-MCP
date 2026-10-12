#!/usr/bin/env node
// Entry point. `serve` (default) runs the MCP server over stdio; the other commands are
// for setup and quick checks from a terminal.

import { paths } from "./config.ts";

const [command = "serve", ...rest] = process.argv.slice(2);

function usage(): void {
  console.log(`perplexity-session-mcp — Perplexity via your own logged-in session (no API key)

Usage: node src/index.ts <command>

  serve                 Run the MCP server on stdio (default)
  login [--timeout s]   Open a browser window, sign in, and save the session
  logout [--wipe]       Remove the saved session (--wipe also clears the login browser profile)
  status                Show login state, plan, and remaining quotas
  search <query>        Run one search and print the answer
  research <query>      Run one deep research and print the report
  history <query>       Search saved answers

Data directory: ${paths.dataDir}`);
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function main(): Promise<void> {
  switch (command) {
    case "serve": {
      const { startServer } = await import("./server.ts");
      await startServer();
      return;
    }
    case "login": {
      const { interactiveLogin } = await import("./login.ts");
      const timeout = Number(flag("--timeout") ?? 300);
      const out = await interactiveLogin({ timeoutMs: timeout * 1000, onStatus: (m) => console.log(m) });
      console.log(out.message);
      process.exitCode = out.ok ? 0 : 1;
      return;
    }
    case "logout": {
      const { logout } = await import("./login.ts");
      console.log(logout(rest.includes("--wipe")));
      return;
    }
    case "status":
    case "search":
    case "research":
    case "history": {
      const { Service } = await import("./service.ts");
      const svc = new Service();
      let lastProgress = 0;
      const progress = (message: string) => {
        if (Date.now() - lastProgress < 5000) return;
        lastProgress = Date.now();
        console.error(`… ${message}`);
      };
      try {
        const query = rest.filter((a) => !a.startsWith("--")).join(" ");
        if (command === "status") console.log(await svc.accountReport(true));
        else if (command === "history") console.log(svc.historySearchReport({ query, limit: 10 }));
        else if (command === "search") console.log((await svc.search({ query }, progress)).text);
        else console.log((await svc.research({ query, waitSeconds: 3600 }, progress)).text);
      } finally {
        await svc.close();
      }
      return;
    }
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
