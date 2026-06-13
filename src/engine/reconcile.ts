// src/engine/reconcile.ts — L_repo (PROTOCOL §6).
// Each tick: list open items, classify into the three coarse states, step each non-terminal one.
import type { BacklogEntry, ReconcileResult, WaitReason } from "../types.js";
import { DECLINED, NEEDS_APPROVAL } from "../github/labels.js";
import { issueStep, withReadOnlyCheckout, type StepCtx } from "./issue-step.js";
import { sortEntries } from "./backlog.js";

export const MAX_ITEMS_PER_TICK = 20;

const HUMAN_BACKOFF_MS = 3_600_000;      // parked on a human (hours-scale)
const NEW_ISSUE_BACKOFF_MS = 7_200_000;  // fully idle, only watching for new issues (longest)

export async function reconcile(ctx: StepCtx): Promise<ReconcileResult> {
  const open = await ctx.gh.listOpenIssues(ctx.repo, 0);
  // #121: thread the tick's open set into every per-item step so issueStep/gatherMaintainerContext don't re-list.
  const octx: StepCtx = { ...ctx, openIssues: open };

  // terminal (declined) is ignored; everything else is stepped. issueStep itself splits the rest into
  // active (-> agent) vs awaiting-gate (-> signal check) by the needs-approval control label (PROTOCOL §1).
  const runnable = open.filter((i) => !i.labels.includes(DECLINED));
  const batch = runnable.slice(0, MAX_ITEMS_PER_TICK);

  const waiting: Record<WaitReason, number> = { human: 0, peer: 0, ci: 0 };
  let advanced = 0;
  let failed = 0;
  const entries: BacklogEntry[] = [];

  // #86: a tick runs at most ONE implement (the heavy runImplement / patcher). Pass 1 steps the whole batch
  // with deferImplement, so approved implement gates are only REPORTED (readyImplement), not run; every other
  // action (maintainer judgment, lightweight writes, close/demote, non-approved gates) executes as usual.
  const ready: { number: number; title: string; entry?: BacklogEntry }[] = [];

  // Step the whole batch. #108: under ONE shared read-only checkout (so the maintainer can verify root
  // cause from code), unless nothing is active (awaiting-gate items run no agent → no checkout needed).
  const stepBatch = async (sctx: StepCtx) => {
    for (const i of batch) {
      // Per-item fault isolation: one item blowing up must not abort the rest of the tick (constitution §10).
      try {
        const out = await issueStep({ ...sctx, deferImplement: true }, i.number);
        if (out.readyImplement) { ready.push({ number: i.number, title: i.title, entry: out.entry }); continue; }
        if (out.entry) entries.push(out.entry);
        if (out.kind === "progressed" || out.kind === "done" || (out.kind === "partial" && out.applied > 0)) advanced++;
        else if (out.kind === "failed") failed++;
        else if (out.kind === "waiting" && out.on !== "human") waiting[out.on]++;
      } catch (e) {
        failed++;
        console.warn(`[monastery] step ${ctx.repo}#${i.number} failed (skipped): ${(e as Error).message}`);
      }
    }
  };
  const hasActive = batch.some((i) => !i.labels.includes(NEEDS_APPROVAL));
  if (hasActive) await withReadOnlyCheckout(octx, stepBatch);
  else await stepBatch(octx);

  // Pass 2: schedule the single heavy slot. Pick the backlog-top approved candidate and run only it (re-step
  // with deferImplement off → the normal approved-gate path: runImplement + gate consumed). The rest keep their
  // 👍'd gate intact and re-enter next tick — deferring is safe, nothing is lost.
  if (ready.length > 0) {
    const winner = sortEntries(ready.map((r) => r.entry!))[0].number;
    for (const r of ready) {
      if (r.number !== winner) {
        entries.push({ number: r.number, title: r.title, priority: "now", rationale: "⏳ approved implement → deferred (one per tick; next tick)" });
        continue;
      }
      try {
        const out = await issueStep({ ...octx, deferImplement: false }, r.number);
        if (out.kind === "progressed" || out.kind === "done" || (out.kind === "partial" && out.applied > 0)) {
          advanced++;
          entries.push({ number: r.number, title: r.title, priority: "now", rationale: "✅ approved implement → executed this tick" });
        } else if (out.kind === "failed") {
          failed++;
          entries.push({ number: r.number, title: r.title, priority: "now", rationale: `approved implement → failed: ${out.error}` });
        } else {
          entries.push({ number: r.number, title: r.title, priority: "now", rationale: `approved implement → ${out.kind}` });
        }
      } catch (e) {
        failed++;
        console.warn(`[monastery] implement ${ctx.repo}#${r.number} failed (skipped): ${(e as Error).message}`);
        entries.push({ number: r.number, title: r.title, priority: "now", rationale: "approved implement → failed this tick" });
      }
    }
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
    failed,
    waiting: (Object.entries(waiting) as [WaitReason, number][])
      .filter(([, n]) => n > 0).map(([on, count]) => ({ on, count })),
    idle,
    nextPollMs,
  };
}
