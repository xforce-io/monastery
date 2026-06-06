// src/engine/issue-step.ts
import { join } from "node:path";
import type { GitHubAdapter } from "../github/adapter.js";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue, Outcome } from "../types.js";
import type { ReviewFn } from "../judges/reviewer.js";
import { macroStateOf, stateLabel, THESIS, NEEDS_APPROVAL, APPROVED, NEEDS_REVISION, DECLINED, TRY_FIX, PATCH_PROPOSED, NEEDS_HUMAN } from "../github/labels.js";
import { thesisGate } from "../judges/thesis-gate.js";
import { triager } from "../judges/triager.js";
import type { FailTracker } from "../config/store.js";
import type { Workspace } from "../workspace/workspace.js";
import { runPatch, branchName } from "./patch.js";

export interface StepCtx {
  repo: string;
  gh: GitHubAdapter;
  provider: AgentProvider;
  model: string;
  artifactRoot: string;
  fails: FailTracker;
  ws: Workspace;
  /** Wall clock, injected for testability (real run = Date.now). */
  now: () => number;
  reviewModel?: string;   // model for the reviewer judge (defaults to `model`)
  review?: ReviewFn;      // injectable reviewer (defaults to the real judge via provider)
}

const PANEL_PREFIX = "<!--monastery-state\nprotocol: gate\n-->";
const GATE_FAIL_THRESHOLD = 3;
/** A needs-approval trace older than this with no human response is auto-skipped (only for timeout-able actions). */
export const APPROVAL_TIMEOUT_MS = 48 * 3_600_000;

/** A typed proposal awaiting approval. The action decides what "approve" does (see DISPATCH). */
export type ProposalAction = "close" | "implement";

/** The panel marker monastery stamps on a proposal so the engine knows what kind of approval this is. */
const APPROVAL_MARKER = (action: ProposalAction): string =>
  `<!--monastery-state\nprotocol: approval\naction: ${action}\n-->`;

/**
 * Read a proposal's action from its panel marker.
 * Legacy panels with no `action:` field default to `close` (back-compat with the original close-only gate).
 * An explicit but unknown action returns null.
 */
export function readProposalAction(panel: string): ProposalAction | null {
  const marker = panel.match(/<!--monastery-state\n([\s\S]*?)\n-->/);
  const block = marker ? marker[1] : "";
  const m = block.match(/^action:\s*(\S+)/m);
  if (!m) return "close";
  const action = m[1];
  return action === "close" || action === "implement" ? action : null;
}

/** Approve-side handler per action, plus whether an unanswered ask should auto-skip on timeout. */
interface Dispatch {
  execute: (ctx: StepCtx, issue: Issue) => Promise<Outcome>;
  timeout: boolean;
}
const DISPATCH: Record<ProposalAction, Dispatch> = {
  close: { execute: executeClose, timeout: true },       // a close ask is harmless to drop -> #6's 48h auto-skip
  implement: { execute: executeImplement, timeout: false }, // a design/impl ask must not be silently discarded
};

export async function issueStep(ctx: StepCtx, num: number): Promise<Outcome> {
  const issue = (await ctx.gh.listOpenIssues(ctx.repo, 0)).find((i) => i.number === num);
  if (!issue) return { kind: "noop" };
  const state = macroStateOf(issue.labels);

  if (issue.labels.includes(DECLINED)) {
    // Terminal: a declined proposal (human or auto-timeout) is never re-proposed.
    if (state === "done") return { kind: "noop" };
    return terminalizeDeclined(ctx, issue, "人工拒绝，monastery 不再提议");
  }

  if (issue.labels.includes(NEEDS_HUMAN)) return { kind: "noop" }; // parked for a human
  if (issue.labels.includes(PATCH_PROPOSED)) return reconcilePatchOutcome(ctx, issue);

  if (issue.labels.includes(TRY_FIX) && !issue.labels.includes(PATCH_PROPOSED) && !issue.labels.includes(NEEDS_HUMAN)) {
    return runPatch(ctx, issue);
  }

  switch (state) {
    case "new":
      return gateNewIssue(ctx, issue);
    case "needs-approval": {
      if (issue.labels.includes(NEEDS_REVISION)) return reviseProposal(ctx, issue);
      const action = readProposalAction(await ctx.gh.readPanel(ctx.repo, issue.number)) ?? "close";
      const dispatch = DISPATCH[action];
      if (issue.labels.includes(APPROVED)) return dispatch.execute(ctx, issue);
      return dispatch.timeout ? approvalWaitOrTimeout(ctx, issue) : { kind: "waiting", on: "human" };
    }
    case "triaged":
      return issue.labels.includes(THESIS.in) ? triageIssue(ctx, issue) : { kind: "noop" };
    default:
      return { kind: "noop" };
  }
}

async function gateNewIssue(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const thesis = await ctx.gh.readThesis(ctx.repo);
  const dir = join(ctx.artifactRoot, `${issue.number}`);
  const v = await thesisGate(ctx.provider, ctx.model, thesis, issue, dir);
  if (!v) {
    const fails = ctx.fails.recordFail(ctx.repo, issue.number);
    if (fails < GATE_FAIL_THRESHOLD) {
      // transient, self-healing skip: stay local (next tick retries), do NOT write GitHub
      console.warn(`[monastery] thesis-gate skip ${ctx.repo}#${issue.number} (${fails}/${GATE_FAIL_THRESHOLD})`);
      return { kind: "noop" };
    }
    // persistent failure -> escalate to a visible, actionable note
    await ctx.gh.upsertPanel(ctx.repo, issue.number,
      `${PANEL_PREFIX}\n⚠️ thesis-gate has failed ${fails} consecutive ticks for this issue — needs a human.`);
    return { kind: "noop" };
  }

  const priorFails = ctx.fails.failCount(ctx.repo, issue.number);
  ctx.fails.clearFail(ctx.repo, issue.number);

  await ctx.gh.addLabel(ctx.repo, issue.number, THESIS[v.verdict]);

  if (v.verdict === "out") {
    const quotedReason = v.reason.split("\n").map((l) => `> ${l}`).join("\n");
    const draft = [
      "**待审提议** — 关闭并回复（移除 `monastery:needs-approval` 改打 `monastery:approved` 即执行）：",
      "",
      quotedReason,
    ].join("\n");
    await propose(ctx, issue, { action: "close", draft });
  } else {
    if (priorFails >= GATE_FAIL_THRESHOLD) {
      // had escalated; reconcile the panel back to current (resolved) state
      await ctx.gh.upsertPanel(ctx.repo, issue.number, `${PANEL_PREFIX}\n✓ thesis-gate resolved (\`${THESIS[v.verdict]}\`).`);
    }
    await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("triaged"));
  }
  return { kind: "progressed" };
}

async function triageIssue(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const dir = join(ctx.artifactRoot, `${issue.number}-triage`);
  const t = await triager(ctx.provider, ctx.model, issue, dir);
  if (!t) {
    const fails = ctx.fails.recordFail(ctx.repo, issue.number);
    if (fails < GATE_FAIL_THRESHOLD) {
      console.warn(`[monastery] triager skip ${ctx.repo}#${issue.number} (${fails}/${GATE_FAIL_THRESHOLD})`);
      return { kind: "noop" };
    }
    await ctx.gh.upsertPanel(ctx.repo, issue.number,
      `${PANEL_PREFIX}\n⚠️ triager has failed ${fails} consecutive ticks for this issue — needs a human.`);
    return { kind: "noop" };
  }
  ctx.fails.clearFail(ctx.repo, issue.number);
  await ctx.gh.addLabel(ctx.repo, issue.number, `type:${t.type}`);
  // advance triaged -> classified (add new state before removing old; never drop to zero state labels)
  await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("classified"));
  await ctx.gh.removeLabel(ctx.repo, issue.number, stateLabel("triaged"));
  return { kind: "progressed" };
}

/** Proposer side: stamp the typed marker + draft into the panel and raise the approval ask. */
async function propose(ctx: StepCtx, issue: Issue, p: { action: ProposalAction; draft: string }): Promise<void> {
  await ctx.gh.upsertPanel(ctx.repo, issue.number, `${APPROVAL_MARKER(p.action)}\n${p.draft}`);
  await ctx.gh.addLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
  await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("needs-approval"));
}

async function executeClose(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const panel = await ctx.gh.readPanel(ctx.repo, issue.number);
  const reason = extractDraft(panel) ?? "Closing as out of scope for this repo's thesis.";
  // Close FIRST: a closed issue is no longer returned by listOpenIssues, so this
  // transition can never re-run -> the outward comment can never be double-posted.
  await ctx.gh.closeIssue(ctx.repo, issue.number);
  await ctx.gh.postComment(ctx.repo, issue.number, reason);
  // Add the terminal state label BEFORE removing the prior one (never drop to zero labels).
  await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("done"));
  await ctx.gh.removeLabel(ctx.repo, issue.number, stateLabel("needs-approval"));
  return { kind: "done" };
}

/**
 * Approve an `implement` proposal: hand the issue to the patch flow. Idempotent — add the driving
 * label + new state before clearing the approval ask (never drop to zero state labels). The next
 * tick's try-fix branch drives the patcher.
 */
async function executeImplement(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  await ctx.gh.addLabel(ctx.repo, issue.number, TRY_FIX);
  await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("classified"));
  await ctx.gh.removeLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
  await ctx.gh.removeLabel(ctx.repo, issue.number, stateLabel("needs-approval"));
  return { kind: "progressed" };
}

/**
 * Human asked for a revision: clear the revision request (and any stale approval) so the issue sits
 * back at needs-approval, awaiting a fresh draft. Re-drafting per action (close re-runs the out-draft;
 * implement is produced by the designer) is out of scope for this gate.
 */
async function reviseProposal(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  await ctx.gh.removeLabel(ctx.repo, issue.number, NEEDS_REVISION);
  if (issue.labels.includes(APPROVED)) await ctx.gh.removeLabel(ctx.repo, issue.number, APPROVED);
  return { kind: "progressed" };
}

/** needs-approval but not yet approved: auto-skip if the trace is stale, else keep waiting on the human. */
async function approvalWaitOrTimeout(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const at = await ctx.gh.labelEventTime(ctx.repo, issue.number, NEEDS_APPROVAL);
  if (at != null && ctx.now() - at >= APPROVAL_TIMEOUT_MS) {
    const hours = Math.round(APPROVAL_TIMEOUT_MS / 3_600_000);
    return terminalizeDeclined(ctx, issue, `⏱ ${hours} 小时未审，已自动跳过`);
  }
  return { kind: "waiting", on: "human" };
}

/** Idempotent terminal transition: stamp declined, mark done, clear the approval ask, record why. */
async function terminalizeDeclined(ctx: StepCtx, issue: Issue, note: string): Promise<Outcome> {
  // Stamp declined so timeout-skipped and human-declined proposals share one terminal state
  // (declined + done) — uniformly queryable and excluded from re-proposal. Idempotent.
  await ctx.gh.addLabel(ctx.repo, issue.number, DECLINED);
  // Add the terminal state label BEFORE removing the prior one (never drop to zero state labels).
  await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("done"));
  await ctx.gh.removeLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
  await ctx.gh.removeLabel(ctx.repo, issue.number, stateLabel("needs-approval"));
  await ctx.gh.upsertPanel(ctx.repo, issue.number, `${PANEL_PREFIX}\n${note}`);
  return { kind: "done" };
}

/** A patch-proposed issue: reconcile against its PR's actual outcome. The human merges/closes the PR
 *  directly (their merge is the approval); monastery only detects the result. */
async function reconcilePatchOutcome(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const branch = branchName(issue.number, issue.title);
  switch (await ctx.gh.prState(ctx.repo, branch)) {
    case "merged":
      // Defensive: `Closes #N` usually auto-closes the issue (so we never see it here). Mark done anyway.
      await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("done"));
      await ctx.gh.removeLabel(ctx.repo, issue.number, PATCH_PROPOSED);
      return { kind: "done" };
    case "closed":
      return terminalizePatchDeclined(ctx, issue);
    default:
      return { kind: "noop" }; // open / null -> keep waiting on the human
  }
}

/** Human closed the PR unmerged -> the patch is declined; un-stick the issue to a terminal state. */
async function terminalizePatchDeclined(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  await ctx.gh.addLabel(ctx.repo, issue.number, DECLINED);
  await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("done"));
  await ctx.gh.removeLabel(ctx.repo, issue.number, PATCH_PROPOSED);
  await ctx.gh.upsertPanel(ctx.repo, issue.number, `${PANEL_PREFIX}\nPR 已关闭未合并 — patch 被拒，monastery 不再处理。`);
  return { kind: "done" };
}

/** The draft reason = all `> ` quoted lines in the panel, joined (round-trips gateNewIssue). */
function extractDraft(panel: string): string | null {
  const quoted = panel.split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2));
  return quoted.length ? quoted.join("\n") : null;
}
