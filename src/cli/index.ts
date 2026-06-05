#!/usr/bin/env node
// src/cli/index.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { Store } from "../config/store.js";
import { GhAdapter } from "../github/gh-adapter.js";
import { DryRunAdapter } from "../github/dry-run.js";
import { ClaudeCodeProvider } from "../provider/claude-code.js";
import { reconcile } from "../engine/reconcile.js";
import { initRepo } from "../engine/init.js";
import { GitWorkspace } from "../workspace/git-workspace.js";
import { formatStatus, toStatusEntry, type StatusEntry } from "./status.js";

export interface ParsedArgs {
  cmd: string; sub?: string; repo?: string; dryRun?: boolean; json?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  if (cmd === "repos") return { cmd, sub: rest[0], repo: rest[1] };
  if (cmd === "init") return { cmd, repo: rest[0] };
  const flag = (name: string) => rest.includes(`--${name}`);
  const opt = (name: string) => { const k = rest.indexOf(`--${name}`); return k >= 0 ? rest[k + 1] : undefined; };
  if (cmd === "status") return { cmd, repo: opt("repo"), json: flag("json") };
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

  if (args.cmd === "init") {
    if (!args.repo) { console.error("usage: monastery init <owner>/<repo>"); process.exit(2); }
    const r = await initRepo(new GhAdapter(), args.repo);
    console.log(`init ${args.repo}: ensured ${r.labels} labels; thesis ${r.thesisCreated ? "scaffolded" : "already present"}`);
    return;
  }

  if (args.cmd === "status") {
    const repos = args.repo ? [args.repo] : store.listRepos();
    const gh = new GhAdapter();
    const allEntries: StatusEntry[] = [];
    for (const repo of repos) {
      const issues = await gh.listOpenIssues(repo, 0);
      allEntries.push(...issues.map((i) => toStatusEntry(repo, i)));
    }
    console.log(args.json ? JSON.stringify(allEntries, null, 2) : formatStatus(allEntries));
    return;
  }

  if (args.cmd === "step") {
    const repos = args.repo ? [args.repo] : store.listRepos();
    const baseGh = new GhAdapter();
    const provider = new ClaudeCodeProvider();
    const model = process.env.MONASTERY_MODEL ?? "haiku";
    const results = [];
    for (const repo of repos) {
      const gh = args.dryRun ? new DryRunAdapter(baseGh) : baseGh;
      const ctx = { repo, gh, provider, model, artifactRoot: mkdtempSync(join(tmpdir(), "monastery-")), fails: store, ws: new GitWorkspace() };
      results.push(await reconcile(ctx));
      if (args.dryRun) {
        const dry = gh as DryRunAdapter;
        if (dry.actions.length === 0) {
          console.log(`[dry-run] ${repo}: no writes would occur`);
        } else {
          for (const a of dry.actions) {
            console.log(`[dry-run] ${a.op}(${JSON.stringify(a.args)})`);
          }
        }
      }
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
