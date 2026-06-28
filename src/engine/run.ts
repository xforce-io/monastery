// src/engine/run.ts
import type { BacklogEntry, ReconcileResult } from "../types.js";
import { DECLINED, NEEDS_APPROVAL } from "../github/labels.js";
import { issueStep, type StepCtx } from "./issue-step.js";
import { sortEntries } from "./backlog.js";

/**
 * #176: where a backlog entry sits in the assess→run flow. `terminal` (declined/done) never appears
 * in the open backlog, so an open-list entry is one of these three.
 */
export type EntryStatus = "ready" | "pending" | "blocked";

/**
 * #176: classify a backlog entry for the status-bearing list. `pending` (awaiting the human's 👍)
 * takes precedence over `blocked` — the human's approval is the actionable next signal. An entry that
 * is neither is `ready`. This is the single source the status/pending/blocked views filter on.
 */
export function entryStatus(entry: BacklogEntry): EntryStatus {
  if (entry.awaitingApproval) return "pending";
  if (entry.blockedBy && entry.blockedBy.length > 0) return "blocked";
  return "ready";
}

/** #176: entries partitioned by status. The single classification the status/pending/blocked views share. */
export interface StatusGroups {
  ready: BacklogEntry[];
  pending: BacklogEntry[];
  blocked: BacklogEntry[];
}

/**
 * #176: partition a (sorted) backlog list by status, preserving input order within each group. The
 * status view reads all groups; `pending`/`blocked` are just lenses onto one group each. Pure read —
 * no LLM, the basis for the zero-cost views.
 */
export function groupByStatus(entries: BacklogEntry[]): StatusGroups {
  const groups: StatusGroups = { ready: [], pending: [], blocked: [] };
  for (const e of entries) groups[entryStatus(e)].push(e);
  return groups;
}

/**
 * #176: `run` executes only the human-approved half of the loop — the gated (needs-approval) issues,
 * read their 👍/👎 and run the approved action. It never assesses (that is `assess`). GitHub is the
 * source of truth for what is gated (constitution: the shell stores no rich state), so it routes off
 * the needs-approval control label, not off the disposable backlog snapshot.
 *
 * Skeleton: list the gated issues; with none gated it is a no-op. (Next: iterate the gate executor
 * `awaitingGate` and apply the one-heavy-slot-per-tick schedule.)
 */
export async function run(ctx: StepCtx): Promise<ReconcileResult> {
  const open = ctx.openIssues ?? await ctx.gh.listOpenIssues(ctx.repo, 0);
  const octx: StepCtx = { ...ctx, openIssues: open };
  const gated = open.filter((i) => i.labels.includes(NEEDS_APPROVAL) && !i.labels.includes(DECLINED));

  let advanced = 0;
  let failed = 0;
  const ready: { number: number; title: string; entry?: BacklogEntry }[] = [];

  // Pass 1: each gated item routes (by the needs-approval label) to the gate executor `awaitingGate`:
  // read the 👍/👎 and run the approved action. `deferImplement` keeps heavy approved work (implement/
  // rework) from running here — it's only REPORTED (readyImplement) for the one-slot schedule below.
  // Per-item fault isolation (constitution §10).
  for (const i of gated) {
    try {
      const out = await issueStep({ ...octx, deferImplement: true }, i.number);
      if (out.readyImplement) { ready.push({ number: i.number, title: i.title, entry: out.entry }); continue; }
      if (out.kind === "progressed" || out.kind === "done" || (out.kind === "partial" && out.applied > 0)) advanced++;
      else if (out.kind === "failed") failed++;
    } catch (e) {
      failed++;
      console.warn(`[monastery] run ${ctx.repo}#${i.number} failed (skipped): ${(e as Error).message}`);
    }
  }

  // Pass 2: one heavy slot per run. Pick the backlog-top approved candidate and run only it (re-step with
  // deferImplement off → runImplement/runRework + gate consumed). The rest keep their 👍'd gate intact and
  // re-enter next run — deferring is safe, nothing is lost. (#86: implement & rework share the one slot.)
  if (ready.length > 0) {
    const winner = sortEntries(ready.map((r) => r.entry!))[0].number;
    try {
      const out = await issueStep({ ...octx, deferImplement: false }, winner);
      if (out.kind === "progressed" || out.kind === "done" || (out.kind === "partial" && out.applied > 0)) advanced++;
      else if (out.kind === "failed") failed++;
    } catch (e) {
      failed++;
      console.warn(`[monastery] run implement ${ctx.repo}#${winner} failed (skipped): ${(e as Error).message}`);
    }
  }

  return {
    repo: ctx.repo,
    advanced,
    failed,
    waiting: gated.length ? [{ on: "human", count: gated.length }] : [],
    idle: advanced === 0,
    nextPollMs: 0,
  };
}
