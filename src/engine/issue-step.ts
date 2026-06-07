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
import { executeSafe, doClose, type GatedKind } from "../shell/actions.js";
import type { FailTracker, RepoPolicy, BacklogWriter } from "../config/store.js";
import { deriveEntry } from "./backlog.js";
import type { Workspace } from "../workspace/workspace.js";
import type { ReviewFn } from "../agents/reviewer.js";
import { runImplement } from "./patch.js";
import { gatherMaintainerContext } from "./context.js";

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
  // Patcher self-review knobs (src/engine/patch.ts, reached via an `implement` action): the review model
  // (defaults to `model`) and an injectable reviewer (defaults to the real judge via provider).
  reviewModel?: string;
  review?: ReviewFn;
  /** This repo's policy — overrides each agent's spec-default policy at runtime (effectivePolicy). */
  repoPolicy?: RepoPolicy;
  /** Preview mode: don't execute the heavy patcher (the DryRunAdapter only mocks gh, not the workspace). */
  dryRun?: boolean;
  /** Sink for the per-repo backlog snapshot (issue #82); reconcile writes through it. */
  backlog?: BacklogWriter;
}

/** After this many consecutive ticks with no valid agent output, escalate to a human-visible panel. */
export const FAIL_THRESHOLD = maintainerSpec.policy.failThreshold ?? 3;
const NOTE_MARKER = "<!--monastery-state\nprotocol: note\n-->";
const APPROVAL_MARK = "protocol: approval";

/** One step over one item. Routes by the two control labels the shell owns (PROTOCOL §2). */
export async function issueStep(ctx: StepCtx, num: number): Promise<Outcome> {
  const issue = (await ctx.gh.listOpenIssues(ctx.repo, 0)).find((i) => i.number === num);
  if (!issue) return { kind: "noop" };                       // closed = terminal (left the open list)
  if (issue.labels.includes(DECLINED)) return { kind: "noop" }; // terminal
  if (issue.labels.includes(NEEDS_APPROVAL)) return awaitingGate(ctx, issue); // awaiting-gate (no agent)
  return active(ctx, issue);                                  // active
}

/** active: ask the maintainer agent for actions, then execute them (safe ones in-place; implement -> patcher). */
async function active(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  // The context layer (src/engine/context.ts) gathers this item's semantic context from GitHub.
  const input = await gatherMaintainerContext(ctx.gh, ctx.repo, issue);
  const blockedBy = (input.deps ?? []).filter((d) => d.state === "open").map((d) => d.ref);
  const dir = join(ctx.artifactRoot, `${issue.number}`);
  const actions = await maintainer(ctx.provider, ctx.model, input, dir);

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
  for (const a of actions) {
    try {
      if (a.kind === "implement") {
        if (ctx.dryRun) console.warn(`[dry-run] would implement ${ctx.repo}#${issue.number} (patcher skipped)`);
        else await runImplement(ctx, issue);
      } else await executeSafe(ctx.gh, ctx.repo, a);
    } catch (e) {
      console.warn(`[monastery] action ${a.kind} on ${ctx.repo}#${issue.number} failed (skipped): ${(e as Error).message}`);
    }
  }
  const entry = deriveEntry(issue, actions, blockedBy, ctx.fails.failCount(ctx.repo, issue.number));
  return actions.length ? { kind: "progressed", entry } : { kind: "noop", entry };
}

/** awaiting-gate: a gated proposal is parked on the approval panel; act only on a human signal (PROTOCOL §4). */
async function awaitingGate(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const parked = {
    number: issue.number, title: issue.title, priority: "parked" as const, rationale: "awaiting human approval",
  };
  const comments = await ctx.gh.listComments(ctx.repo, issue.number);
  const panel = comments.find((c) => c.body.includes(APPROVAL_MARK));
  if (!panel) return { kind: "waiting", on: "human", entry: parked }; // needs-approval but no panel: inconsistent, wait

  const reactions = await ctx.gh.reactions(ctx.repo, panel.id);
  if (reactions.includes("-1")) return terminalizeDeclined(ctx, issue, "👎 提议被拒，monastery 不再处理。");
  if (!reactions.includes("+1")) return { kind: "waiting", on: "human", entry: parked }; // no signal yet

  // Approved (👍). Execute the gated action the panel proposed.
  const kind = approvalKind(panel.body);
  if (kind === "close") {
    const reason = stripMarkers(panel.body) || "已批准，关闭。";
    await doClose(ctx.gh, ctx.repo, issue.number, reason); // closes first -> idempotent, leaves the open list
    return { kind: "done" };
  }
  // PROTOCOL §4: a merge is approved by the human clicking Merge on the PR directly (which closes the
  // issue via `Closes #N` -> terminal). The shell does not merge from an issue 👍. Keep waiting.
  // Still open + needs-approval, so it stays parked in the backlog.
  return { kind: "waiting", on: "human", entry: parked };
}

/** Stamp the terminal `declined` state, clear the approval ask, record why. Idempotent. */
async function terminalizeDeclined(ctx: StepCtx, issue: Issue, note: string): Promise<Outcome> {
  await ctx.gh.addLabel(ctx.repo, issue.number, DECLINED);
  await ctx.gh.removeLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
  await ctx.gh.upsertPanel(ctx.repo, issue.number, `${NOTE_MARKER}\n${note}`);
  return { kind: "done" };
}

/** Read the proposed gated kind from the approval panel marker (`action: close|merge`). */
function approvalKind(body: string): GatedKind | null {
  const m = body.match(/^action:\s*(close|merge)\s*$/m);
  return m ? (m[1] as GatedKind) : null;
}

/** The human-facing draft = the panel body with monastery markers stripped. */
function stripMarkers(body: string): string {
  return body.replace(/<!--monastery-state[\s\S]*?-->\s*/g, "").trim();
}
