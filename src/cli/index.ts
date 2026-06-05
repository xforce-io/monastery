#!/usr/bin/env node
// src/cli/index.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { Store } from "../config/store.js";
import { GhAdapter } from "../github/gh-adapter.js";
import { ClaudeCodeProvider } from "../provider/claude-code.js";
import { reconcile } from "../engine/reconcile.js";

export interface ParsedArgs {
  cmd: string; sub?: string; repo?: string; dryRun?: boolean; json?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  if (cmd === "repos") return { cmd, sub: rest[0], repo: rest[1] };
  const flag = (name: string) => rest.includes(`--${name}`);
  const opt = (name: string) => { const k = rest.indexOf(`--${name}`); return k >= 0 ? rest[k + 1] : undefined; };
  return { cmd, repo: opt("repo"), dryRun: flag("dry-run"), json: flag("json") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new Store(join(homedir(), ".monastery"));

  if (args.cmd === "repos") {
    if (args.sub === "add" && args.repo) store.addRepo(args.repo);
    else if (args.sub === "remove" && args.repo) store.removeRepo(args.repo);
    console.log(store.listRepos().join("\n"));
    return;
  }

  if (args.cmd === "step") {
    if (args.dryRun) {
      console.error("--dry-run is not supported in M1 (apply-only). Re-run without --dry-run.");
      process.exit(2);
    }
    const repos = args.repo ? [args.repo] : store.listRepos();
    const gh = new GhAdapter();
    const provider = new ClaudeCodeProvider();
    const model = process.env.MONASTERY_MODEL ?? "haiku";
    const results = [];
    for (const repo of repos) {
      const ctx = { repo, gh, provider, model, artifactRoot: mkdtempSync(join(tmpdir(), "monastery-")) };
      results.push(await reconcile(ctx)); // NOTE: --dry-run handled in a follow-up; M1 ships apply-only first
    }
    console.log(args.json ? JSON.stringify(results, null, 2) : summarize(results));
    return;
  }

  console.error(`unknown command: ${args.cmd}`);
  process.exit(1);
}

function summarize(results: { repo: string; advanced: number; idle: boolean; nextPollMs: number }[]): string {
  return results.map((r) => `${r.repo}: advanced=${r.advanced} idle=${r.idle} next=${Math.round(r.nextPollMs / 1000)}s`).join("\n");
}

// Only run when invoked as the binary (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
