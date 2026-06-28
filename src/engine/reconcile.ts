// src/engine/reconcile.ts — L_repo (PROTOCOL §6).
// #176: a tick is exactly `assess` (the think half) then `run` (the do half), composed here. One list of
// open issues, capped, threaded into both; this file owns only the repo-level rollup (waiting/idle/poll).
import type { ReconcileResult, WaitReason } from "../types.js";
import { DECLINED, NEEDS_APPROVAL } from "../github/labels.js";
import { type StepCtx } from "./issue-step.js";
import { assess } from "./assess.js";
import { run } from "./run.js";

export const MAX_ITEMS_PER_TICK = 20;

const HUMAN_BACKOFF_MS = 3_600_000;      // parked on a human (hours-scale)
const NEW_ISSUE_BACKOFF_MS = 7_200_000;  // fully idle, only watching for new issues (longest)

export async function reconcile(ctx: StepCtx): Promise<ReconcileResult> {
  const open = await ctx.gh.listOpenIssues(ctx.repo, 0);
  // #121: list ONCE, thread the (capped) set into both halves so issueStep/gatherMaintainerContext don't re-list.
  const runnable = open.filter((i) => !i.labels.includes(DECLINED));
  const batch = runnable.slice(0, MAX_ITEMS_PER_TICK);
  const octx: StepCtx = { ...ctx, openIssues: batch };

  // assess judges/proposes over active items (under one read-only checkout); run executes the human-approved
  // gated items (one heavy slot per tick). One-directional: assess → 〔human gate on GitHub〕 → run.
  const a = await assess(octx);
  const r = await run(octx);

  const advanced = a.advanced + r.advanced;
  const failed = a.failed + r.failed;

  // waiting.human = every gated, non-declined item across the WHOLE repo (not just the batch) — they sit
  // until a human signals. peer/ci come from the two halves' own waits.
  const waiting: Record<WaitReason, number> = { human: 0, peer: 0, ci: 0 };
  for (const i of open) {
    if (i.labels.includes(DECLINED)) continue;
    if (i.labels.includes(NEEDS_APPROVAL)) waiting.human++;
  }
  for (const w of [...a.waiting, ...r.waiting]) if (w.on !== "human") waiting[w.on] += w.count;

  const idle = advanced === 0;
  const nextPollMs = !idle
    ? 60_000
    : waiting.human > 0
      ? HUMAN_BACKOFF_MS
      : NEW_ISSUE_BACKOFF_MS;

  return {
    repo: ctx.repo,
    advanced,
    failed,
    waiting: (Object.entries(waiting) as [WaitReason, number][])
      .filter(([, n]) => n > 0).map(([on, count]) => ({ on, count })),
    idle,
    nextPollMs,
  };
}
