#!/usr/bin/env node
// src/cli/index.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { Store } from "../config/store.js";
import { StepLock, RepoLockError } from "../config/step-lock.js";
import { GhAdapter } from "../github/gh-adapter.js";
import { DryRunAdapter } from "../github/dry-run.js";
import { ClaudeCodeProvider } from "../provider/claude-code.js";
import { reconcile } from "../engine/reconcile.js";
import { issueStep } from "../engine/issue-step.js";
import { initRepo } from "../engine/init.js";
import { StructuredAgentError } from "../agents/spec.js";
import { GitWorkspace } from "../workspace/git-workspace.js";
import { formatStatus, toStatusEntry, explainOutcome, type StatusEntry } from "./status.js";
import { formatBacklog } from "./backlog.js";
import type { BacklogSnapshot } from "../types.js";

export interface ParsedArgs {
  cmd: string; sub?: string; repo?: string; model?: string; issue?: string; dryRun?: boolean; json?: boolean; forceStaleLock?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  if (cmd === "repos") return { cmd, sub: rest[0], repo: rest[1], model: rest[2] };
  if (cmd === "init") return { cmd, repo: rest[0] };
  const flag = (name: string) => rest.includes(`--${name}`);
  const opt = (name: string) => { const k = rest.indexOf(`--${name}`); return k >= 0 ? rest[k + 1] : undefined; };
  if (cmd === "status" || cmd === "backlog") return { cmd, repo: opt("repo"), json: flag("json") };
  return { cmd, repo: opt("repo"), issue: opt("issue"), dryRun: flag("dry-run"), json: flag("json"), forceStaleLock: flag("force-stale-lock") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new Store(join(homedir(), ".monastery"));

  if (args.cmd === "repos") {
    if (args.sub === "add" && args.repo) store.addRepo(args.repo, args.model ? { model: args.model } : undefined);
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

  if (args.cmd === "backlog") {
    const repos = args.repo ? [args.repo] : store.listRepos();
    const snaps = repos
      .map((r) => store.readBacklog(r))
      .filter((s): s is BacklogSnapshot => s !== null);
    console.log(args.json ? JSON.stringify(snaps, null, 2) : snaps.map(formatBacklog).join("\n\n"));
    return;
  }

  if (args.cmd === "step") {
    const repos = args.repo ? [args.repo] : store.listRepos();
    const baseGh = new GhAdapter();
    const provider = new ClaudeCodeProvider();
    const stepLock = new StepLock(join(homedir(), ".monastery"));
    const results: Awaited<ReturnType<typeof reconcile>>[] = [];
    const rawCmd = process.argv.slice(2).join(" ");
    const exitCode = await stepRepos({
      repos, lock: stepLock, rawCmd, json: args.json, force: args.forceStaleLock,
      runOne: async (repo) => {
        // Per-repo policy wins, then env override, then default (memory: default ≥ sonnet).
        const model = store.repoModel(repo) ?? process.env.MONASTERY_MODEL ?? "sonnet";
        const gh = args.dryRun ? new DryRunAdapter(baseGh) : baseGh;
        const ctx = { repo, gh, provider, model, reviewModel: process.env.MONASTERY_REVIEW_MODEL ?? model, repoPolicy: store.repoPolicy(repo), dryRun: args.dryRun, artifactRoot: mkdtempSync(join(tmpdir(), "monastery-")), fails: store, backlog: store, ws: new GitWorkspace(), now: () => Date.now() };
        if (args.issue) {
          const out = await issueStep(ctx, Number(args.issue));
          console.log(`${repo}#${args.issue}: ${out.kind} — ${explainOutcome(out)}`);
        } else {
          results.push(await reconcile(ctx));
        }
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
      },
    });
    if (!args.issue) console.log(args.json ? JSON.stringify(results, null, 2) : summarize(results));
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }

  console.error(`unknown command: ${args.cmd}`);
  process.exit(2); // usage error
}

export interface StepReposDeps {
  repos: string[];
  lock: StepLock;
  rawCmd: string;
  json?: boolean;
  force?: boolean;
  runOne: (repo: string) => Promise<void>;
  err?: (msg: string) => void;
}

/**
 * Step each repo under its own lock. A repo locked by a live process is skipped
 * (fail-fast, no provider/GitHub work) and reported, but does NOT abort the whole
 * batch — the remaining repos still run. Returns exit code 4 if any repo was lock-conflicted,
 * else 0. The lock is always released after a repo's work finishes or throws.
 */
export async function stepRepos(deps: StepReposDeps): Promise<number> {
  const err = deps.err ?? ((m: string) => console.error(m));
  let exitCode = 0;
  for (const repo of deps.repos) {
    let release: (() => void) | undefined;
    try {
      release = deps.lock.acquire(repo, deps.rawCmd, deps.force);
    } catch (e) {
      if (e instanceof RepoLockError) {
        if (deps.json) {
          err(JSON.stringify({ repo: e.repo, error: "repo_locked", pid: e.pid, startedAt: e.startedAt }));
        } else {
          err(`[monastery] repo ${e.repo} is already being stepped by pid ${e.pid} since ${e.startedAt}`);
          err(`[monastery] refusing concurrent run; retry later or use --force-stale-lock only if the prior process is gone`);
        }
        exitCode = 4; // repo lock conflict — distinct code so cron/scripts can retry vs. alert
        continue;
      }
      throw e;
    }
    try {
      await deps.runOne(repo);
    } finally {
      release();
    }
  }
  return exitCode;
}

function summarize(results: { repo: string; advanced: number; idle: boolean; nextPollMs: number }[]): string {
  return results.map((r) => `${r.repo}: advanced=${r.advanced} idle=${r.idle} next=${Math.round(r.nextPollMs / 1000)}s`).join("\n");
}

// Only run when invoked as the binary (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    // Exit-code taxonomy: 1 runtime, 2 usage, 3 agent structured-output failure, 4 repo lock.
    process.exit(e instanceof StructuredAgentError ? 3 : 1);
  });
}
