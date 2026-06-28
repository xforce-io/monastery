#!/usr/bin/env node
// src/cli/index.ts
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Store } from "../config/store.js";
import { StepLock, RepoLockError, isAlive } from "../config/step-lock.js";
import { GhAdapter } from "../github/gh-adapter.js";
import { DryRunAdapter } from "../github/dry-run.js";
import { reconcile } from "../engine/reconcile.js";
import { assess } from "../engine/assess.js";
import { run } from "../engine/run.js";
import { backlogFingerprint, isBacklogFresh, refreshBacklog } from "../engine/backlog.js";
import { issueStep, withReadOnlyCheckout, pendingApprovals } from "../engine/issue-step.js";
import { initRepo, type LabelEnsureCache } from "../engine/init.js";
import { StructuredAgentError } from "../agents/spec.js";
import { TransientGitHubError } from "../github/transient.js";
import type { BacklogSnapshot, Outcome, ReconcileResult } from "../types.js";
import type { GitHubAdapter } from "../github/adapter.js";
import { GitWorkspace } from "../workspace/git-workspace.js";
import { formatStatus, toStatusEntry, explainOutcome, readProgress, enrichWithProgress, type StatusEntry } from "./status.js";
import { formatBacklog, formatBacklogRepoError, formatMissingBacklog, formatPending, missingBacklog, type BacklogRepoError, type MissingBacklog, type PendingItem } from "./backlog.js";
import { wantsHelp, wantsVersion, usage, readPackageVersion } from "./help.js";
import { preflight, formatPreflightErrors, type Need } from "./preflight.js";
import { dirname } from "node:path";
import { resolveModelLevels, resolveProviderMode } from "../provider/models.js";
import { makeProviderPool, selectAgentProvider } from "../provider/select.js";

// Which external tools each command needs, so preflight runs only when it matters
// (offline commands like `repos` skip it). step is the only one that always needs an agent provider.
const NEEDS: Record<string, Need> = {
  init: { gh: true, agent: false },
  status: { gh: true, agent: false },
  backlog: { gh: true, agent: false },
  pending: { gh: true, agent: false },
  step: { gh: true, agent: true },
  assess: { gh: true, agent: true },
  run: { gh: true, agent: true },
};

export interface ParsedArgs {
  cmd: string; sub?: string; repo?: string; model?: string; issue?: string; dryRun?: boolean; json?: boolean; forceStaleLock?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  if (cmd === "repos") return { cmd, sub: rest[0], repo: rest[1], model: rest[2] };
  if (cmd === "init") return { cmd, repo: rest[0] };
  const flag = (name: string) => rest.includes(`--${name}`);
  const opt = (name: string) => { const k = rest.indexOf(`--${name}`); return k >= 0 ? rest[k + 1] : undefined; };
  if (cmd === "status" || cmd === "backlog" || cmd === "pending") return { cmd, repo: opt("repo"), json: flag("json") };
  return { cmd, repo: opt("repo"), issue: opt("issue"), dryRun: flag("dry-run"), json: flag("json"), forceStaleLock: flag("force-stale-lock") };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Help/version are pure output and must short-circuit BEFORE dispatch — notably so
  // `monastery step --help` prints usage instead of running a full reconcile (#70).
  if (wantsHelp(argv)) { console.log(usage()); return; }
  if (wantsVersion(argv)) { console.log(readPackageVersion(dirname(fileURLToPath(import.meta.url)))); return; }

  const args = parseArgs(argv);

  // Preflight: fail fast with actionable guidance when a required external tool is missing,
  // instead of a raw execa spawn error deep in a command (#70 D3).
  const need = NEEDS[args.cmd];
  if (need) {
    const pf = await preflight(need);
    if (!pf.ok) { console.error(formatPreflightErrors(pf.errors)); process.exit(1); }
  }

  const store = new Store(join(homedir(), ".monastery"));
  const legacy = store.cleanupLegacyReposFile();
  if (legacy) {
    const migrated = legacy.migratedRepos.length ? `; migrated ${legacy.migratedRepos.join(", ")} into config.json` : "";
    console.error(`[monastery] archived legacy repos.json at ${legacy.archivePath}${migrated}`);
  }

  if (args.cmd === "repos") {
    if (args.sub === "add" && args.repo) store.addRepo(args.repo, args.model ? { model: args.model } : undefined);
    else if (args.sub === "remove" && args.repo) store.removeRepo(args.repo);
    console.log(store.listRepos().join("\n"));
    return;
  }

  if (args.cmd === "init") {
    if (!args.repo) { console.error("usage: monastery init <owner>/<repo>"); process.exit(2); }
    const r = await initRepo(new GhAdapter(), args.repo, { cache: store, force: true });
    console.log(`init ${args.repo}: ensured ${r.labels} labels; thesis ${r.thesisCreated ? "scaffolded" : "already present"}`);
    return;
  }

  if (args.cmd === "status") {
    const repos = args.repo ? [args.repo] : store.listRepos();
    const gh = new GhAdapter();
    const lock = new StepLock(join(homedir(), ".monastery"));
    const now = Date.now();
    const allEntries: StatusEntry[] = [];
    for (const repo of repos) {
      // #75: overlay the per-repo phase-progress snapshot onto the issue being stepped right now.
      const snap = readProgress(lock.progressPath(repo));
      const issues = await gh.listOpenIssues(repo, 0);
      for (const i of issues) {
        const entry = toStatusEntry(repo, i);
        allEntries.push(snap ? enrichWithProgress(entry, snap, { now, alive: isAlive(snap.pid) }) : entry);
      }
    }
    console.log(args.json ? JSON.stringify(allEntries, null, 2) : formatStatus(allEntries));
    return;
  }

  if (args.cmd === "backlog") {
    const repos = args.repo ? [args.repo] : store.listRepos();
    if (repos.length === 0) {
      const empty = { error: "no_tracked_repos", hint: "run monastery repos add <owner>/<repo>" };
      console.log(args.json ? JSON.stringify(empty, null, 2) : `no tracked repos; ${empty.hint}`);
      return;
    }
    const tracked = new Set(store.listRepos());
    const gh = new GhAdapter();
    let selection: Awaited<ReturnType<typeof selectAgentProvider>> | undefined;
    let modelLevels: ReturnType<typeof resolveModelLevels> | undefined;
    const ensureProvider = async () => {
      if (!selection) {
        try {
          const providerMode = resolveProviderMode();
          selection = await selectAgentProvider({ mode: providerMode });
        } catch (e) {
          console.error(formatPreflightErrors([(e as Error).message]));
          process.exit(1);
        }
        modelLevels = resolveModelLevels(selection.name);
      }
      return { selection, modelLevels: modelLevels! };
    };
    const items: (BacklogSnapshot | MissingBacklog | BacklogRepoError)[] = [];
    for (const repo of repos) {
      if (!tracked.has(repo)) {
        items.push(missingBacklog(repo, false));
        continue;
      }
      try {
        const open = await gh.listOpenIssues(repo, 0);
        const fingerprint = backlogFingerprint(open);
        const cached = store.readBacklog(repo);
        if (isBacklogFresh(cached, fingerprint)) {
          items.push(cached);
          continue;
        }
        const { selection: selected, modelLevels: levels } = await ensureProvider();
        if (selected.fallbackFrom && !args.json) console.error(`[monastery] ${selected.fallbackFrom} unavailable; using ${selected.name} provider`);
        const snapshot = await refreshBacklog({
          repo,
          gh,
          provider: selected.provider,
          model: store.repoModel(repo) ?? levels.standard,
          artifactDir: mkdtempSync(join(tmpdir(), "monastery-backlog-")),
          now: () => Date.now(),
          language: store.repoLanguage(repo),
        }, open);
        store.writeBacklog(repo, snapshot);
        items.push(snapshot);
      } catch (e) {
        items.push({ repo, error: "backlog_refresh_failed", message: (e as Error).message });
      }
    }
    console.log(args.json
      ? JSON.stringify(items, null, 2)
      : items.map((i) => "error" in i
        ? i.error === "missing_backlog_snapshot"
          ? formatMissingBacklog(i)
          : formatBacklogRepoError(i)
        : formatBacklog(i)).join("\n\n"));
    return;
  }

  if (args.cmd === "pending") {
    // Live full scan (issue #90 review fix): not the batched backlog snapshot, so it never misses an
    // awaiting issue past MAX_ITEMS_PER_TICK and never goes stale after you react.
    const gh = new GhAdapter();
    const repos = args.repo ? [args.repo] : store.listRepos();
    const items: PendingItem[] = [];
    for (const repo of repos) for (const it of await pendingApprovals(gh, repo)) items.push({ ...it, repo });
    console.log(args.json ? JSON.stringify(items, null, 2) : formatPending(items));
    return;
  }

  if (args.cmd === "step" || args.cmd === "assess" || args.cmd === "run") {
    // #176: assess (think half) and run (do half) reuse the same tick machinery (lock, provider, ctx);
    // they differ only in which engine pass executes. `step`/cron stays the composed tick (reconcile).
    const engineFn = args.cmd === "run" ? run : args.cmd === "assess" ? assess : reconcile;
    const repos = args.repo ? [args.repo] : store.listRepos();
    const baseGh = new GhAdapter();
    let selection;
    try {
      const providerMode = resolveProviderMode();
      selection = await selectAgentProvider({ mode: providerMode });
    } catch (e) {
      console.error(formatPreflightErrors([(e as Error).message]));
      process.exit(1);
    }
    if (selection.fallbackFrom && !args.json) console.error(`[monastery] ${selection.fallbackFrom} unavailable; using ${selection.name} provider`);
    const provider = selection.provider;
    const modelLevels = resolveModelLevels(selection.name);
    // #133: lazy pool for `agents.<role>.provider` — a non-primary provider is health-checked only
    // if some role's policy actually asks for it.
    const providerPool = makeProviderPool(selection);
    const stepLock = new StepLock(join(homedir(), ".monastery"));
    const results: Awaited<ReturnType<typeof reconcile>>[] = [];
    let singleIssueOutcome: Outcome | undefined;
    const rawCmd = process.argv.slice(2).join(" ");
    const exitCode = await stepRepos({
      repos, lock: stepLock, rawCmd, json: args.json, force: args.forceStaleLock,
      runOne: async (repo) => {
        // Per-repo policy wins, then env override, then default (memory: default ≥ sonnet).
        const model = store.repoModel(repo) ?? modelLevels.standard;
        const gh = args.dryRun ? new DryRunAdapter(baseGh) : baseGh;
        await prepareRepoForStep(gh, repo, { cache: store, dryRun: args.dryRun, log: args.json ? (s) => console.error(s) : undefined });
        // #75: thread the json flag (outlet A machine stream) and the per-repo progress sidecar path
        // (outlet B) so PhaseLogger emits NDJSON to stdout and overwrites the snapshot `status` reads.
        const ctx = { repo, gh, provider, model, modelLevels, providerPool, reviewModel: process.env.MONASTERY_REVIEW_MODEL, repoPolicy: store.repoPolicy(repo), language: store.repoLanguage(repo), dryRun: args.dryRun, artifactRoot: mkdtempSync(join(tmpdir(), "monastery-")), fails: store, backlog: store, ws: new GitWorkspace(), now: () => Date.now(), json: args.json, progressPath: stepLock.progressPath(repo) };
        if (args.issue) {
          // #108: a single-issue run gets the same read-only code checkout as a reconcile tick, so the
          // maintainer can verify root cause from source here too (parity between the two entry points).
          const out = await withReadOnlyCheckout(ctx, (c) => issueStep(c, Number(args.issue)));
          singleIssueOutcome = out;
          // #75: in json mode stdout is the NDJSON event stream; the human summary goes to stderr.
          const line = `${repo}#${args.issue}: ${out.kind} — ${explainOutcome(out)}`;
          if (args.json) console.error(line); else console.log(line);
        } else {
          results.push(await engineFn(ctx));
        }
        if (args.dryRun) {
          const dry = gh as DryRunAdapter;
          // #75: keep stdout a clean NDJSON stream in json mode — dry-run's human lines go to stderr there.
          const emit = (s: string) => (args.json ? console.error(s) : console.log(s));
          if (dry.actions.length === 0) {
            emit(`[dry-run] ${repo}: no GitHub writes would occur (local lock/progress cache may be refreshed)`);
          } else {
            for (const a of dry.actions) {
              emit(`[dry-run] ${a.op}(${JSON.stringify(a.args)})`);
            }
            emit(`[dry-run] ${repo}: GitHub writes suppressed; local lock/progress cache may be refreshed`);
          }
        }
      },
    });
    // #75 AC#2: stdout is the NDJSON event stream; the batch summary is its final {type:"summary"} event.
    if (!args.issue) console.log(args.json ? JSON.stringify({ type: "summary", results }) : summarize(results));
    const finalExitCode = stepExitCode(exitCode, results, singleIssueOutcome);
    if (finalExitCode !== 0) process.exit(finalExitCode);
    return;
  }

  console.error(`unknown command: ${args.cmd}`);
  process.exit(2); // usage error
}

export interface PrepareRepoOptions {
  /** Per-repo label-ensured cache (#148) — skips the ensureLabel pass once labels are in place. */
  cache?: LabelEnsureCache;
  /** A dry-run never really creates labels, so it must NOT mark the cache as ensured (#148). */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export async function prepareRepoForStep(gh: GitHubAdapter, repo: string, opts: PrepareRepoOptions = {}): Promise<void> {
  // #148: pass the per-repo cache so the ensureLabel pass is skipped once labels are in place,
  // keeping a flaky label API off the per-tick (per cron invocation) critical path. Under dry-run
  // ensureLabel only records intent (no real label is created), so withhold the cache — otherwise a
  // single `step --dry-run` would mark the repo "ensured" and make later real steps skip label init.
  const r = await initRepo(gh, repo, { cache: opts.dryRun ? undefined : opts.cache });
  if (r.thesisCreated) opts.log?.(`[monastery] initialized ${repo}: scaffolded .monastery/thesis.md; edit it to define repo scope`);
}

export function stepExitCode(lockExitCode: number, results: ReconcileResult[], singleIssueOutcome?: Outcome): number {
  if (singleIssueOutcome?.kind === "failed" || results.some((r) => r.failed > 0)) return 1;
  return lockExitCode;
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

export function summarize(results: ReconcileResult[]): string {
  return results.map((r) => {
    const awaiting = r.waiting.find((w) => w.on === "human")?.count ?? 0;
    const base = `${r.repo}: advanced=${r.advanced} failed=${r.failed} idle=${r.idle} next=${Math.round(r.nextPollMs / 1000)}s`;
    return awaiting > 0 ? `${base} awaiting-your-👍=${awaiting}` : base; // #88: surface items blocked on you
  }).join("\n");
}

// True when this module is the process entrypoint. Compares *real* paths so that
// symlinked bins (npm link's node_modules/.bin, Homebrew shim) and macOS
// /tmp→/private/tmp differences still match; a plain string compare leaves the
// global `monastery` command a silent no-op (#106). Returns false when imported
// (argv1 undefined) or when either path can't be resolved.
export function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

// Only run when invoked as the binary (not when imported by tests).
if (isEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((e) => {
    // #148: a sustained GitHub API blip is a clean, retryable terminal state — print the
    // one-line guidance, not a raw ExecaError stack dump that reads like a code crash.
    if (e instanceof TransientGitHubError) {
      console.error(`[monastery] ${e.message}`);
      process.exit(1);
    }
    console.error(e);
    // Exit-code taxonomy: 1 runtime, 2 usage, 3 agent structured-output failure, 4 repo lock.
    process.exit(e instanceof StructuredAgentError ? 3 : 1);
  });
}
