// src/engine/issue-step.ts — v2 L_item (PROTOCOL §1, §5, §6).
//   active        -> call the maintainer agent once -> executeSafe its proposed Action[]
//   awaiting-gate -> check the human signal (👍 / 👎) -> gated executor (doClose) or terminalize  [no agent]
//   terminal      -> ignore
import { join } from "node:path";
import type { GitHubAdapter } from "../github/adapter.js";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue, Outcome } from "../types.js";
import { NEEDS_APPROVAL, DECLINED } from "../github/labels.js";
import { maintainer, maintainerSpec } from "../agents/maintainer.js";
import { effectivePolicy } from "../agents/spec.js";
import { executeSafe, doClose, proposeGate, ensureControlLabel, type GatedKind } from "../shell/actions.js";
import type { FailTracker, RepoPolicy, BacklogWriter } from "../config/store.js";
import { deriveEntry } from "./backlog.js";
import type { Workspace } from "../workspace/workspace.js";
import type { ReviewFn } from "../agents/reviewer.js";
import { runImplement, runRework, branchName } from "./patch.js";
import { gatherMaintainerContext } from "./context.js";
import { currentSpec } from "../shell/consensus.js";
import { isHumanComment } from "../shell/markers.js";
import { makePhaseLogger } from "../phase-logger.js";
import type { ModelLevels } from "../provider/models.js";

export interface StepCtx {
  repo: string;
  gh: GitHubAdapter;
  provider: AgentProvider;
  model: string;
  /** Provider-resolved model levels. Omitted in older tests/callers; `model` remains the fallback. */
  modelLevels?: ModelLevels;
  artifactRoot: string;
  fails: FailTracker;
  ws: Workspace;
  /** Wall clock, injected for testability (real run = Date.now). */
  now: () => number;
  // Patcher self-review knobs (src/engine/patch.ts, reached via an `implement` action): the review model
  // (defaults to `model`) and an injectable reviewer (defaults to the real judge via provider).
  reviewModel?: string;
  review?: ReviewFn;
  /** This repo's policy — overrides each agent's spec-default policy at runtime (effectivePolicy). */
  repoPolicy?: RepoPolicy;
  /** #76: this repo's resolved outward-text language (Store.repoLanguage). Threaded into every agent that
   *  writes outward GitHub text (maintainer/reviewer context, patcher persona) and the enforcement warn. */
  language?: string;
  /** Preview mode: don't execute the heavy patcher (the DryRunAdapter only mocks gh, not the workspace). */
  dryRun?: boolean;
  /** #86: when true, an approved implement gate is NOT run here — it's reported (readyImplement) so the
   *  reconcile tick scheduler can run at most one runImplement per tick. The single-issue CLI path leaves
   *  this false so `step --issue N` still implements immediately. */
  deferImplement?: boolean;
  /** Sink for the per-repo backlog snapshot (issue #82); reconcile writes through it. */
  backlog?: BacklogWriter;
  /** #108: read-only repo checkout for code-reading agents (maintainer). Shared per tick; the shell never
   *  commits it. When set, the maintainer runs with this as its cwd so it can verify root cause from code. */
  repoDir?: string;
  /** #75: emit NDJSON phase events to stdout (outlet A, machine stream). Human lines go to stderr regardless. */
  json?: boolean;
  /** #75: sidecar path for the per-repo phase-progress snapshot (outlet B). Threaded from StepLock.progressPath. */
  progressPath?: string;
  /** #75: inject phase-event sinks (tests only); production defaults to process.stderr/stdout. */
  logSink?: { err?: (line: string) => void; out?: (line: string) => void };
  /** #121: the tick's already-listed open set, threaded down so per-item steps don't each re-list. */
  openIssues?: Issue[];
}

/**
 * #108: run `fn` with a read-only repo checkout threaded into `ctx.repoDir`, so code-reading agents
 * (the maintainer) can verify root cause from source. Cloned once, cleaned up after. A clone failure
 * degrades gracefully to text-only (the pre-#108 behavior). Used by BOTH entry points — the reconcile
 * tick (once, shared across the batch) and the single-issue CLI path — so they behave identically.
 */
export async function withReadOnlyCheckout<T>(ctx: StepCtx, fn: (ctx: StepCtx) => Promise<T>): Promise<T> {
  let repoDir: string | undefined;
  try {
    repoDir = await ctx.ws.cloneReadOnly(ctx.repo);
  } catch (e) {
    console.warn(`[monastery] read-only clone failed for ${ctx.repo}; maintainer runs text-only: ${(e as Error).message}`);
  }
  try {
    return await fn(repoDir ? { ...ctx, repoDir } : ctx);
  } finally {
    if (repoDir) await ctx.ws.cleanup(repoDir).catch(() => { /* best effort */ });
  }
}

/** After this many consecutive ticks with no valid agent output, escalate to a human-visible panel. */
export const FAIL_THRESHOLD = maintainerSpec.policy.failThreshold ?? 3;
const NOTE_MARKER = "<!--monastery-state\nprotocol: note\n-->";
const APPROVAL_MARK = "protocol: approval";

/** One step over one item. Routes by the two control labels the shell owns (PROTOCOL §2). */
export async function issueStep(ctx: StepCtx, num: number): Promise<Outcome> {
  const issue = (ctx.openIssues ?? await ctx.gh.listOpenIssues(ctx.repo, 0)).find((i) => i.number === num);
  if (!issue) return { kind: "noop" };                       // closed = terminal (left the open list)
  if (issue.labels.includes(DECLINED)) return { kind: "noop" }; // terminal
  if (issue.labels.includes(NEEDS_APPROVAL)) return awaitingGate(ctx, issue); // awaiting-gate (no agent)
  // #124 repair: an earlier gate-open may have posted the approval comment but failed before the routing
  // label landed. The approval comment is still a shell-owned, GitHub-observable gate, so route it here
  // instead of letting active/maintainer treat it as an ordinary marked comment forever.
  const comments = await ctx.gh.listComments(ctx.repo, issue.number);
  const gate = latestApprovalGate(comments);
  const latestNoteAt = Math.max(0, ...comments.filter((c) => c.body.includes("protocol: note")).map((c) => c.updatedAt));
  if (gate && gate.updatedAt > latestNoteAt) {
    await ensureControlLabel(ctx.gh, ctx.repo, NEEDS_APPROVAL);
    await ctx.gh.addLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
    return awaitingGate(ctx, { ...issue, labels: [...issue.labels, NEEDS_APPROVAL] });
  }
  return active(ctx, issue);                                  // active
}

/** active: ask the maintainer agent for actions, then execute them (safe ones in-place; implement -> patcher). */
async function active(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  // #102: a closed-unmerged implement PR is a human rejection with no merge/terminal transition — recover
  // deterministically (guide the human, fix the lying panel) BEFORE consulting the agent.
  const rejected = await recoverRejectedImpl(ctx, issue);
  if (rejected) return rejected;
  // The context layer (src/engine/context.ts) gathers this item's semantic context from GitHub.
  // #76: thread the repo's outward-text language so the maintainer writes reply/panel/spec in it.
  const input = await gatherMaintainerContext(ctx.gh, ctx.repo, issue, ctx.language, ctx.openIssues);
  const blockedBy = (input.deps ?? []).filter((d) => d.state === "open").map((d) => d.ref);
  // #108: run the maintainer in the tick's read-only repo checkout (so it can verify root cause from code)
  // when available; otherwise a scratch artifact dir (text-only, the pre-#108 behavior).
  const dir = ctx.repoDir ?? join(ctx.artifactRoot, `${issue.number}`);
  // #72: the maintainer's model comes from its effective policy (agents.maintainer.model), not just ctx.model.
  const model = effectivePolicy(maintainerSpec, ctx.repoPolicy).model ?? ctx.modelLevels?.standard ?? ctx.model;
  const log = makePhaseLogger(ctx, issue.number);
  const mt = log.phase("maintainer", { model });
  const actions = await maintainer(ctx.provider, model, input, dir);
  if (actions === null) mt.fail("no-output"); else mt.done({ actions: actions.length });

  // The agent produced no schema-valid output OR tried to act outside this item — refuse the whole
  // batch (constitution §2: constrain, don't trust) and treat it as a transient, self-healing failure.
  if (actions === null || actions.some((a) => a.num !== issue.number)) {
    const fails = ctx.fails.recordFail(ctx.repo, issue.number);
    const failThreshold = effectivePolicy(maintainerSpec, ctx.repoPolicy).failThreshold ?? FAIL_THRESHOLD;
    if (fails >= failThreshold) {
      await ctx.gh.upsertPanel(ctx.repo, issue.number,
        `${NOTE_MARKER}\n⚠️ the maintainer agent has produced no valid actions for ${fails} consecutive ticks — needs a human.`);
    } else {
      console.warn(`[monastery] maintainer skip ${ctx.repo}#${issue.number} (${fails}/${failThreshold})`);
    }
    return {
      kind: "noop",
      entry: {
        number: issue.number, title: issue.title, priority: "later", rationale: "no valid output",
        ...(blockedBy.length ? { blockedBy } : {}), ...(fails > 0 ? { fails } : {}),
      },
    };
  }

  ctx.fails.clearFail(ctx.repo, issue.number);
  // implement is the shell-owned heavy executor (sandbox patcher + human-gated draft PR); the rest are
  // cheap idempotent GitHub writes. The agent never touches git/gh either way (constitution §3).
  // Each action is fault-isolated: one failing action (e.g. an undefined label) is noise, not a crash
  // that takes down the tick (constitution §10 — the safety layer always holds, even for a bad agent).
  const sa = log.phase("safe-actions", { count: actions.length });
  const actionErrors: string[] = [];
  for (const a of actions) {
    try {
      if (a.kind === "implement" || a.kind === "rework") {
        // #88/#79: implement & rework are heavy and human-gated. The agent only PROPOSES — open an approval
        // comment + needs-approval; the executor (runImplement / runRework) runs only after a real human 👍
        // next tick (awaitingGate). The agent can never self-approve its own heavy work.
        const verb = a.kind === "rework" ? "rework the open draft PR" : "implement";
        const draft = a.draft ?? `Proposed ${verb} for #${issue.number}. 👍 this approval comment to proceed.`;
        if (ctx.dryRun) console.warn(`[dry-run] would propose ${a.kind} ${ctx.repo}#${issue.number} (awaiting human 👍)`);
        else await proposeGate(ctx.gh, ctx.repo, issue.number, a.kind, draft);
      } else await executeSafe(ctx.gh, ctx.repo, a);
    } catch (e) {
      const msg = (e as Error).message;
      actionErrors.push(`${a.kind}: ${msg}`);
      console.warn(`[monastery] action ${a.kind} on ${ctx.repo}#${issue.number} failed (skipped): ${msg}`);
    }
  }
  if (actionErrors.length) sa.fail("action-failed", { failures: actionErrors.length });
  else sa.done();
  const entry = deriveEntry(issue, actions, blockedBy, ctx.fails.failCount(ctx.repo, issue.number));
  if (actionErrors.length) return { kind: "failed", error: actionErrors.join("; "), entry };
  return actions.length ? { kind: "progressed", entry } : { kind: "noop", entry };
}

/** awaiting-gate: a gated proposal is parked on the newest approval comment; act only on a human signal (PROTOCOL §4). */
async function awaitingGate(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const parked = {
    number: issue.number, title: issue.title, priority: "parked" as const, rationale: "awaiting human approval",
  };
  const comments = await ctx.gh.listComments(ctx.repo, issue.number);
  const gate = latestApprovalGate(comments);
  if (!gate) {
    // Mirror of #124: the routing label exists but the approval comment is missing. There is no concrete
    // proposal for a human to approve, so waiting would park forever (and `pending` cannot link anywhere).
    return demoteGate(ctx, issue, "⟳ approval gate was inconsistent（缺少审批评论），已退回重新评估。");
  }

  const reactions = await ctx.gh.reactions(ctx.repo, gate.id);
  if (reactions.some((r) => r.content === "-1")) return terminalizeDeclined(ctx, issue, "👎 提议被拒，monastery 不再处理。");

  // #95: a parked implement gate goes STALE when a newer spec lands under it — invalidate it (back to
  // active) instead of letting a 👍 approve an outdated design. Scoped to implement (the spec-bearing gate).
  if (approvalKind(gate.body) === "implement") {
    const cur = currentSpec(comments)?.version ?? 0;
    if (cur > approvalSpecVersion(gate.body)) {
      return demoteGate(ctx, issue, `⟳ 设计已更新（spec v${cur}），原 implement 提议作废，已退回重新评估。`);
    }
  }
  // #95: 👀 is the human's NON-terminal "reconsider" signal (vs 👎 which terminalizes). Send it back to
  // active so the maintainer re-proposes. The shell never writes reactions, so a 👀 is necessarily human.
  if (reactions.some((r) => r.content === "eyes")) {
    return demoteGate(ctx, issue, "⟳ 已打回（👀），原提议作废，已退回重新评估。");
  }

  if (!reactions.some((r) => r.content === "+1")) {
    // #97: the human left a NEW, unanswered comment under the gate — that's them talking to us, not approving.
    // Send the item back to active so the maintainer reads it and replies/reconsiders next tick. Execution
    // stays reaction-gated (this branch only runs when there is no 👍). Checked AFTER the 👍 path above so a
    // genuine approval is never intercepted by a late comment.
    if (hasNewUnansweredHumanComment(comments, gate)) {
      return demoteGate(ctx, issue, "⟳ 收到新的人类评论，已退回重新评估以回应你的反馈。");
    }
    // #90: a genuine awaiting-your-approval item — keep it high-priority (not sunk to parked) and tag it
    // with the approval kind + comment id, so backlog/`monastery pending` can surface it with a direct link.
    const k = approvalKind(gate.body) ?? undefined;
    return {
      kind: "waiting", on: "human",
      entry: {
        number: issue.number, title: issue.title, priority: "now",
        rationale: `⏳ awaiting your 👍${k ? ` (${k})` : ""}`,
        awaitingApproval: true, approvalKind: k, approvalCommentId: gate.id,
      },
    };
  }

  // Approved (👍). Execute the gated action the panel proposed.
  const kind = approvalKind(gate.body);
  if (kind === "close") {
    const reason = stripMarkers(gate.body) || "已批准，关闭。";
    await doClose(ctx.gh, ctx.repo, issue.number, reason); // closes first -> idempotent, leaves the open list
    return { kind: "done" };
  }
  if (kind === "implement" || kind === "rework") {
    // #86: defer to the tick scheduler — don't run the heavy executor here. Report this as a ready candidate
    // (gate left intact, so it re-enters awaitingGate next tick) and let reconcile run at most one per tick.
    // Both implement and rework are heavy patcher work, so both share the one-per-tick budget.
    if (ctx.deferImplement) {
      return {
        kind: "waiting", on: "human", readyImplement: true,
        entry: {
          number: issue.number, title: issue.title, priority: "now",
          rationale: `✅ approved ${kind} — ready (tick scheduler)`,
          awaitingApproval: true, approvalKind: kind, approvalCommentId: gate.id,
        },
      };
    }
    // #88/#79: the human endorsed (👍). Run the gated executor.
    // implement: #100 feeds the ENDORSED spec (not the possibly-stale issue body); the #95 stale-gate guard
    //   above already ensured currentSpec.version == the gate's `spec: N`. No spec -> falls back to the body.
    // rework: runRework checks out the existing branch and updates the SAME PR from the PR's human feedback.
    const out = kind === "rework"
      ? await runRework(ctx, issue)
      : await runImplement(ctx, issue, currentSpec(comments));
    // Consume the gate on success: clear needs-approval + rewrite the panel to a plain note, so the item
    // doesn't re-enter awaitingGate on the stale 👍 every tick (which would re-count as advanced forever).
    if (out.kind === "progressed") {
      await ctx.gh.removeLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
      const done = kind === "rework"
        ? `✅ rework approved — the draft PR was updated${out.note ? ` (${out.note})` : ""}. Awaiting your review/merge.`
        : `✅ implement approved — draft PR opened${out.note ? ` (${out.note})` : ""}. Awaiting your review/merge.`;
      await ctx.gh.upsertPanel(ctx.repo, issue.number, `${NOTE_MARKER}\n${done}`);
    }
    return out;
  }
  // PROTOCOL §4: a merge is approved by the human clicking Merge on the PR directly (which closes the
  // issue via `Closes #N` -> terminal). The shell does not merge from an issue 👍. Keep waiting.
  // Still open + needs-approval, so it stays parked in the backlog.
  return { kind: "waiting", on: "human", entry: parked };
}

function latestApprovalGate<T extends { body: string; updatedAt: number }>(comments: T[]): T | undefined {
  return comments
    .filter((c) => c.body.includes(APPROVAL_MARK))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** Stamp the terminal `declined` state, clear the approval ask, record why. Idempotent. */
async function terminalizeDeclined(ctx: StepCtx, issue: Issue, note: string): Promise<Outcome> {
  await ensureControlLabel(ctx.gh, ctx.repo, DECLINED);
  await ctx.gh.addLabel(ctx.repo, issue.number, DECLINED);
  await ctx.gh.removeLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
  await ctx.gh.upsertPanel(ctx.repo, issue.number, `${NOTE_MARKER}\n${note}`);
  return { kind: "done" };
}

/** Read the proposed gated kind from the approval comment marker (`action: close|merge|implement|rework`). */
function approvalKind(body: string): GatedKind | null {
  const m = body.match(/^action:\s*(close|merge|implement|rework)\s*$/m);
  return m ? (m[1] as GatedKind) : null;
}

/** #95: the spec version a gate was opened against (`spec: N` in the approval marker); 0 if absent. */
function approvalSpecVersion(body: string): number {
  const m = body.match(/^spec:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : 0;
}

/**
 * #97: is there a human comment that landed AFTER the gate and hasn't been replied to yet? Such a comment
 * is the human talking to us mid-gate — we should respond, not sit. "newer than the gate" guarantees
 * termination (a comment that predates the gate, or one already answered, never re-triggers); "unanswered"
 * is the absence of a `<!--monastery-reply to=<id>-->` for it. Identity is by marker, not author (#92).
 */
function hasNewUnansweredHumanComment(
  comments: { id: string; body: string; updatedAt: number }[],
  gate: { updatedAt: number },
): boolean {
  return comments.some(
    (c) =>
      isHumanComment(c) &&
      c.updatedAt > gate.updatedAt &&
      !comments.some((r) => r.body.includes(`<!--monastery-reply to=${c.id}-->`)),
  );
}

/**
 * #95: invalidate a parked gate WITHOUT terminalizing it (unlike terminalizeDeclined) — clear
 * needs-approval and rewrite the panel to a plain note, so next tick the item is `active` again and the
 * maintainer re-proposes. Used when the design moved on under the gate (stale spec) or a human asked to
 * reconsider (👀). The stale gate comment is left in place for audit; a fresh proposal supersedes it.
 */
async function demoteGate(ctx: StepCtx, issue: Issue, note: string): Promise<Outcome> {
  await ctx.gh.removeLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
  await ctx.gh.upsertPanel(ctx.repo, issue.number, `${NOTE_MARKER}\n${note}`);
  return { kind: "progressed", entry: { number: issue.number, title: issue.title, priority: "now", rationale: note } };
}

/**
 * #102: when the human closes monastery's deterministic implement PR without merging it, that is a
 * non-terminal rejection of this implementation attempt. Post guidance once per PR and repair the sticky
 * panel so it no longer claims we're waiting for review/merge; the next tick is active again, with the
 * closed PR available in maintainer context.
 */
async function recoverRejectedImpl(ctx: StepCtx, issue: Issue): Promise<Outcome | null> {
  const branch = branchName(issue.number, issue.title);
  if ((await ctx.gh.prState(ctx.repo, branch)) !== "closed") return null;

  const pr = await ctx.gh.getPrDetails(ctx.repo, branch);
  if (!pr) return null;

  const marker = `<!--monastery-impl-rejected pr=${pr.number}-->`;
  const comments = await ctx.gh.listComments(ctx.repo, issue.number);
  if (comments.some((c) => c.body.includes(marker))) return null;

  const note = `实现被拒：PR #${pr.number} 已关闭且未合并。请在 issue 中说明希望调整的方向，monastery 会重新评估并提出新的实现。`;
  await ctx.gh.postComment(ctx.repo, issue.number, `${marker}\n${note}`);
  await ctx.gh.upsertPanel(ctx.repo, issue.number, `${NOTE_MARKER}\n${note}`);
  return {
    kind: "waiting",
    on: "human",
    entry: { number: issue.number, title: issue.title, priority: "now", rationale: note },
  };
}

/** The human-facing draft = the panel body with monastery markers stripped. */
function stripMarkers(body: string): string {
  return body
    .replace(/<!--monastery-state[\s\S]*?-->\s*/g, "")
    .replace(/^⏳ \*\*NEEDS YOUR APPROVAL\*\*[^\n]*\n*/m, "") // drop the #90 approval banner from the human draft
    .trim();
}

/**
 * Read-only scan of ALL open awaiting-gate issues for `monastery pending` (issue #90 review fix): every
 * open `needs-approval` issue whose latest approval comment has no 👍 yet. Live (not the batched snapshot),
 * so it never misses items past MAX_ITEMS_PER_TICK and never goes stale after you react.
 */
export async function pendingApprovals(
  gh: GitHubAdapter,
  repo: string,
): Promise<{ number: number; title: string; approvalKind?: string; approvalCommentId: string }[]> {
  const open = await gh.listOpenIssues(repo, 0);
  const out: { number: number; title: string; approvalKind?: string; approvalCommentId: string }[] = [];
  for (const i of open) {
    if (i.labels.includes(DECLINED) || !i.labels.includes(NEEDS_APPROVAL)) continue;
    const comments = await gh.listComments(repo, i.number);
    const gate = comments.filter((c) => c.body.includes(APPROVAL_MARK)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!gate) continue; // needs-approval but no panel: inconsistent, skip
    const reactions = await gh.reactions(repo, gate.id);
    if (reactions.some((r) => r.content === "+1")) continue; // already approved
    out.push({ number: i.number, title: i.title, approvalKind: approvalKind(gate.body) ?? undefined, approvalCommentId: gate.id });
  }
  return out;
}
