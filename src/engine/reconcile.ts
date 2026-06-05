// src/engine/reconcile.ts
import type { ReconcileResult, WaitReason } from "../types.js";
import { macroStateOf, APPROVED, THESIS, TRY_FIX, PATCH_PROPOSED, NEEDS_HUMAN } from "../github/labels.js";
import { issueStep, type StepCtx } from "./issue-step.js";

export const MAX_ITEMS_PER_TICK = 20;

const HUMAN_BACKOFF_MS = 3_600_000;      // parked on a human (hours-scale)
const NEW_ISSUE_BACKOFF_MS = 7_200_000;  // fully idle, only watching for new issues (longest)

export async function reconcile(ctx: StepCtx): Promise<ReconcileResult> {
  const open = await ctx.gh.listOpenIssues(ctx.repo, 0);

  // Runnable: explicit try-fix, virtual-new, triaged(thesis:in) for classification, or approved-but-not-executed.
  const runnable = open.filter((i) => {
    if (i.labels.includes(TRY_FIX) && !i.labels.includes(PATCH_PROPOSED) && !i.labels.includes(NEEDS_HUMAN)) return true;
    const st = macroStateOf(i.labels);
    if (st === "new") return true;
    if (st === "triaged" && i.labels.includes(THESIS.in)) return true; // M2: needs classification
    if (st === "needs-approval" && i.labels.includes(APPROVED)) return true;
    return false;
  });

  const batch = runnable.slice(0, MAX_ITEMS_PER_TICK);
  const waiting: Record<WaitReason, number> = { human: 0, peer: 0, ci: 0 };
  let advanced = 0;

  for (const i of batch) {
    const out = await issueStep(ctx, i.number);
    if (out.kind === "progressed" || out.kind === "done") advanced++;
    else if (out.kind === "waiting") waiting[out.on]++;
  }

  // Count parked human-waiters across the whole repo (not just this batch) for backoff.
  for (const i of open) {
    const st = macroStateOf(i.labels);
    if (st === "needs-approval" && !i.labels.includes(APPROVED)) waiting.human++;
  }

  const idle = advanced === 0;
  const nextPollMs = !idle
    ? 60_000
    : waiting.human > 0
      ? HUMAN_BACKOFF_MS
      : NEW_ISSUE_BACKOFF_MS;

  return {
    repo: ctx.repo,
    advanced,
    waiting: (Object.entries(waiting) as [WaitReason, number][])
      .filter(([, n]) => n > 0).map(([on, count]) => ({ on, count })),
    idle,
    nextPollMs,
  };
}
