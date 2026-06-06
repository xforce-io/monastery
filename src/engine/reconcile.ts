// src/engine/reconcile.ts — L_repo (PROTOCOL §6).
// Each tick: list open items, classify into the three coarse states, step each non-terminal one.
import type { ReconcileResult, WaitReason } from "../types.js";
import { DECLINED, NEEDS_APPROVAL } from "../github/labels.js";
import { issueStep, type StepCtx } from "./issue-step.js";

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

  for (const i of batch) {
    const out = await issueStep(ctx, i.number);
    if (out.kind === "progressed" || out.kind === "done") advanced++;
    else if (out.kind === "waiting" && out.on !== "human") waiting[out.on]++;
  }

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

  return {
    repo: ctx.repo,
    advanced,
    waiting: (Object.entries(waiting) as [WaitReason, number][])
      .filter(([, n]) => n > 0).map(([on, count]) => ({ on, count })),
    idle,
    nextPollMs,
  };
}
