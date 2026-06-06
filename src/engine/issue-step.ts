// src/engine/issue-step.ts — v2 L_item (PROTOCOL §1, §5, §6).
//   active        -> call the maintainer agent once -> executeSafe its proposed Action[]
//   awaiting-gate -> check the human signal (👍 / 👎) -> gated executor (doClose) or terminalize  [no agent]
//   terminal      -> ignore
import { join } from "node:path";
import type { GitHubAdapter } from "../github/adapter.js";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue, Outcome } from "../types.js";
import { NEEDS_APPROVAL, DECLINED } from "../github/labels.js";
import { maintainer } from "../judges/maintainer.js";
import { executeSafe, doClose, type GatedKind } from "../shell/actions.js";
import type { FailTracker } from "../config/store.js";
import type { Workspace } from "../workspace/workspace.js";
import type { ReviewFn } from "../judges/reviewer.js";
import { runImplement, branchName } from "./patch.js";

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
}

/** After this many consecutive ticks with no valid agent output, escalate to a human-visible panel. */
export const FAIL_THRESHOLD = 3;
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
  const thesis = await ctx.gh.readThesis(ctx.repo);
  const comments = await ctx.gh.listComments(ctx.repo, issue.number);
  // Surface monastery's PR state so the agent won't re-propose implement while a patch PR is open (§8).
  const branch = branchName(issue.number, issue.title);
  const prState = await ctx.gh.prState(ctx.repo, branch);
  const pr = prState ? { branch, state: prState } : null;
  const dir = join(ctx.artifactRoot, `${issue.number}`);
  const actions = await maintainer(ctx.provider, ctx.model, { thesis, issue, comments, pr }, dir);

  // The agent produced no schema-valid output OR tried to act outside this item — refuse the whole
  // batch (constitution §2: constrain, don't trust) and treat it as a transient, self-healing failure.
  if (actions === null || actions.some((a) => a.num !== issue.number)) {
    const fails = ctx.fails.recordFail(ctx.repo, issue.number);
    if (fails >= FAIL_THRESHOLD) {
      await ctx.gh.upsertPanel(ctx.repo, issue.number,
        `${NOTE_MARKER}\n⚠️ the maintainer agent has produced no valid actions for ${fails} consecutive ticks — needs a human.`);
    } else {
      console.warn(`[monastery] maintainer skip ${ctx.repo}#${issue.number} (${fails}/${FAIL_THRESHOLD})`);
    }
    return { kind: "noop" };
  }

  ctx.fails.clearFail(ctx.repo, issue.number);
  // implement is the shell-owned heavy executor (sandbox patcher + human-gated draft PR); the rest are
  // cheap idempotent GitHub writes. The agent never touches git/gh either way (constitution §3).
  for (const a of actions) {
    if (a.kind === "implement") await runImplement(ctx, issue);
    else await executeSafe(ctx.gh, ctx.repo, a);
  }
  return actions.length ? { kind: "progressed" } : { kind: "noop" };
}

/** awaiting-gate: a gated proposal is parked on the approval panel; act only on a human signal (PROTOCOL §4). */
async function awaitingGate(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const comments = await ctx.gh.listComments(ctx.repo, issue.number);
  const panel = comments.find((c) => c.body.includes(APPROVAL_MARK));
  if (!panel) return { kind: "waiting", on: "human" }; // needs-approval but no panel: inconsistent, wait

  const reactions = await ctx.gh.reactions(ctx.repo, panel.id);
  if (reactions.includes("-1")) return terminalizeDeclined(ctx, issue, "👎 提议被拒，monastery 不再处理。");
  if (!reactions.includes("+1")) return { kind: "waiting", on: "human" }; // no signal yet

  // Approved (👍). Execute the gated action the panel proposed.
  const kind = approvalKind(panel.body);
  if (kind === "close") {
    const reason = stripMarkers(panel.body) || "已批准，关闭。";
    await doClose(ctx.gh, ctx.repo, issue.number, reason); // closes first -> idempotent, leaves the open list
    return { kind: "done" };
  }
  // PROTOCOL §4: a merge is approved by the human clicking Merge on the PR directly (which closes the
  // issue via `Closes #N` -> terminal). The shell does not merge from an issue 👍. Keep waiting.
  return { kind: "waiting", on: "human" };
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
