// src/engine/assess.ts — #176: the assessment half (the "think"), split out of reconcile.
// assess runs the maintainer over the ACTIVE (non-gated) issues — it judges, proposes, and maintains
// display labels. It never executes approved heavy work; that is `run` (the gate executor). The two
// halves are kept apart so the data flow is one-directional: assess → 〔human gate〕 → run.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReconcileResult, WaitReason } from "../types.js";
import { DECLINED, NEEDS_APPROVAL } from "../github/labels.js";
import { issueStep, withReadOnlyCheckout, type StepCtx } from "./issue-step.js";
import { refreshBacklog, backlogFingerprint, isBacklogFresh } from "./backlog.js";

export async function assess(ctx: StepCtx): Promise<ReconcileResult> {
  const open = ctx.openIssues ?? await ctx.gh.listOpenIssues(ctx.repo, 0);
  // #192: load the last assessment's per-issue input fingerprints from the backlog snapshot. issueStep skips
  // the maintainer LLM for any issue whose freshly-gathered input matches. Pure cost cache — an absent/stale
  // map only forces a full re-assess; it never changes what gets done.
  const lastSnapshot = ctx.backlog ? ctx.backlog.readBacklog(ctx.repo) : null;
  const lastFingerprints = new Map<number, string>();
  for (const e of lastSnapshot?.entries ?? []) if (e.inputFingerprint) lastFingerprints.set(e.number, e.inputFingerprint);
  const octx: StepCtx = { ...ctx, openIssues: open, lastFingerprints };
  // Active = open, not declined, not awaiting a human gate. Gated issues belong to `run`, not assess.
  const active = open.filter((i) => !i.labels.includes(NEEDS_APPROVAL) && !i.labels.includes(DECLINED));

  let advanced = 0;
  let failed = 0;
  const waiting: Record<WaitReason, number> = { human: 0, peer: 0, ci: 0 };
  // #192: this tick's freshly-computed fingerprints, collected to persist onto the refreshed snapshot.
  const fpByNum = new Map<number, string>();

  // #108: the maintainer verifies root cause against real code, so the whole active batch runs under ONE
  // shared read-only checkout. Per-item fault isolation: one item blowing up never aborts the rest (§10).
  const stepBatch = async (sctx: StepCtx) => {
    for (const i of active) {
      try {
        const out = await issueStep(sctx, i.number);
        if (out.fingerprint) fpByNum.set(i.number, out.fingerprint);
        if (out.kind === "progressed" || out.kind === "done" || (out.kind === "partial" && out.applied > 0)) advanced++;
        else if (out.kind === "failed") failed++;
        else if (out.kind === "waiting" && out.on !== "human") waiting[out.on]++;
      } catch (e) {
        failed++;
        console.warn(`[monastery] assess ${ctx.repo}#${i.number} failed (skipped): ${(e as Error).message}`);
      }
    }
  };
  if (active.length) await withReadOnlyCheckout(octx, stepBatch);

  // #176 (#12): assess owns the backlog snapshot. Refresh it (fingerprint-cached) over the POST-assess
  // state so the read-only views (status/pending) always have a fresh ranked list with ZERO LLM at view
  // time. The ranking is read-only triage from issue facts (#140) — never reverse-derived from the actions
  // above. Skipped when no backlog sink is wired (e.g. the reconcile tick's #121 single-list test path).
  if (ctx.backlog && !ctx.dryRun) {
    const post = await ctx.gh.listOpenIssues(ctx.repo, 0);
    const fingerprint = backlogFingerprint(post);
    if (!isBacklogFresh(lastSnapshot, fingerprint)) {
      const snapshot = await refreshBacklog({
        repo: ctx.repo, gh: ctx.gh, provider: ctx.provider, model: ctx.model,
        artifactDir: mkdtempSync(join(tmpdir(), "monastery-assess-backlog-")),
        now: ctx.now, language: ctx.language,
      }, post);
      // #192: persist each issue's input fingerprint onto its entry. Prefer this tick's freshly-computed value;
      // carry the last known one forward for issues not assessed this pass (e.g. gated) so it isn't lost.
      for (const e of snapshot.entries) {
        const fp = fpByNum.get(e.number) ?? lastFingerprints.get(e.number);
        if (fp) e.inputFingerprint = fp;
      }
      ctx.backlog.writeBacklog(ctx.repo, snapshot);
    }
  }

  return {
    repo: ctx.repo,
    advanced,
    failed,
    waiting: (Object.entries(waiting) as [WaitReason, number][]).filter(([, n]) => n > 0).map(([on, count]) => ({ on, count })),
    idle: advanced === 0,
    nextPollMs: 0,
  };
}
