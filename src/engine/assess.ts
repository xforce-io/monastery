// src/engine/assess.ts — #176: the assessment half (the "think"), split out of reconcile.
// assess runs the maintainer over the ACTIVE (non-gated) issues — it judges, proposes, and maintains
// display labels. It never executes approved heavy work; that is `run` (the gate executor). The two
// halves are kept apart so the data flow is one-directional: assess → 〔human gate〕 → run.
import type { ReconcileResult } from "../types.js";
import { DECLINED, NEEDS_APPROVAL } from "../github/labels.js";
import { issueStep, withReadOnlyCheckout, type StepCtx } from "./issue-step.js";

export async function assess(ctx: StepCtx): Promise<ReconcileResult> {
  const open = ctx.openIssues ?? await ctx.gh.listOpenIssues(ctx.repo, 0);
  const octx: StepCtx = { ...ctx, openIssues: open };
  // Active = open, not declined, not awaiting a human gate. Gated issues belong to `run`, not assess.
  const active = open.filter((i) => !i.labels.includes(NEEDS_APPROVAL) && !i.labels.includes(DECLINED));

  let advanced = 0;
  let failed = 0;

  // #108: the maintainer verifies root cause against real code, so the whole active batch runs under ONE
  // shared read-only checkout. Per-item fault isolation: one item blowing up never aborts the rest (§10).
  const stepBatch = async (sctx: StepCtx) => {
    for (const i of active) {
      try {
        const out = await issueStep(sctx, i.number);
        if (out.kind === "progressed" || out.kind === "done" || (out.kind === "partial" && out.applied > 0)) advanced++;
        else if (out.kind === "failed") failed++;
      } catch (e) {
        failed++;
        console.warn(`[monastery] assess ${ctx.repo}#${i.number} failed (skipped): ${(e as Error).message}`);
      }
    }
  };
  if (active.length) await withReadOnlyCheckout(octx, stepBatch);

  return {
    repo: ctx.repo,
    advanced,
    failed,
    waiting: [],
    idle: advanced === 0,
    nextPollMs: 0,
  };
}
