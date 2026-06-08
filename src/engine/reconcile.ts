// src/engine/reconcile.ts — L_repo (PROTOCOL §6).
// Each tick: list open items, classify into the three coarse states, step each non-terminal one.
import type { BacklogEntry, BacklogSnapshot, ReconcileResult, WaitReason } from "../types.js";
import { DECLINED, NEEDS_APPROVAL } from "../github/labels.js";
import { issueStep, withReadOnlyCheckout, type StepCtx } from "./issue-step.js";
import { sortEntries } from "./backlog.js";

export const MAX_ITEMS_PER_TICK = 20;

const HUMAN_BACKOFF_MS = 3_600_000;      // parked on a human (hours-scale)
const NEW_ISSUE_BACKOFF_MS = 7_200_000;  // fully idle, only watching for new issues (longest)

export async function reconcile(ctx: StepCtx): Promise<ReconcileResult> {
  const open = await ctx.gh.listOpenIssues(ctx.repo, 0);

  // terminal (declined) is ignored; everything else is stepped. issueStep itself splits the rest into
  // active (-> agent) vs awaiting-gate (-> signal check) by the needs-approval control label (PROTOCOL §1).
  const runnable = open.filter((i) => !i.labels.includes(DECLINED));
  const batch = runnable.slice(0, MAX_ITEMS_PER_TICK);

  const waiting: Record<WaitReason, number> = { human: 0, peer: 0, ci: 0 };
  let advanced = 0;
  const entries: BacklogEntry[] = [];

  // Step the whole batch. #108: under ONE shared read-only checkout (so the maintainer can verify root
  // cause from code), unless nothing is active (awaiting-gate items run no agent → no checkout needed).
  const stepBatch = async (sctx: StepCtx) => {
    for (const i of batch) {
      // Per-item fault isolation: one item blowing up must not abort the rest of the tick (constitution §10).
      try {
        const out = await issueStep(sctx, i.number);
        if (out.entry) entries.push(out.entry);
        if (out.kind === "progressed" || out.kind === "done") advanced++;
        else if (out.kind === "waiting" && out.on !== "human") waiting[out.on]++;
      } catch (e) {
        console.warn(`[monastery] step ${ctx.repo}#${i.number} failed (skipped): ${(e as Error).message}`);
      }
    }
  };
  const hasActive = batch.some((i) => !i.labels.includes(NEEDS_APPROVAL));
  if (hasActive) await withReadOnlyCheckout(ctx, stepBatch);
  else await stepBatch(ctx);

  // waiting.human = awaiting-gate items (needs-approval, not declined) across the whole repo — they sit
  // until a human signals. This is the single source for waiting.human (the batch loop skips on==human).
  for (const i of open) {
    if (i.labels.includes(DECLINED)) continue;
    if (i.labels.includes(NEEDS_APPROVAL)) waiting.human++;
  }

  const idle = advanced === 0;
  const nextPollMs = !idle
    ? 60_000
    : waiting.human > 0
      ? HUMAN_BACKOFF_MS
      : NEW_ISSUE_BACKOFF_MS;

  // Backlog snapshot (issue #82): maintainer-written projection of this tick's decisions.
  // Disposable; rebuilt every tick. Skipped under dry-run (no persistent side effects).
  if (!ctx.dryRun && ctx.backlog) {
    const snapshot: BacklogSnapshot = {
      generatedAt: new Date(ctx.now()).toISOString(),
      repo: ctx.repo,
      rankedOf: { ranked: entries.length, open: runnable.length },
      entries: sortEntries(entries),
    };
    ctx.backlog.writeBacklog(ctx.repo, snapshot);
  }

  return {
    repo: ctx.repo,
    advanced,
    waiting: (Object.entries(waiting) as [WaitReason, number][])
      .filter(([, n]) => n > 0).map(([on, count]) => ({ on, count })),
    idle,
    nextPollMs,
  };
}
