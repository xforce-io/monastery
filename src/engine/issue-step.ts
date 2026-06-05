// src/engine/issue-step.ts
import { join } from "node:path";
import type { GitHubAdapter } from "../github/adapter.js";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue, Outcome } from "../types.js";
import { macroStateOf, stateLabel, THESIS, NEEDS_APPROVAL, APPROVED, TRY_FIX, PATCH_PROPOSED, NEEDS_HUMAN } from "../github/labels.js";
import { thesisGate } from "../judges/thesis-gate.js";
import { triager } from "../judges/triager.js";
import type { FailTracker } from "../config/store.js";
import type { Workspace } from "../workspace/workspace.js";
import { runPatch } from "./patch.js";

export interface StepCtx {
  repo: string;
  gh: GitHubAdapter;
  provider: AgentProvider;
  model: string;
  artifactRoot: string;
  fails: FailTracker;
  ws: Workspace;
}

const PANEL_PREFIX = "<!--monastery-state\nprotocol: gate\n-->";
const GATE_FAIL_THRESHOLD = 3;

export async function issueStep(ctx: StepCtx, num: number): Promise<Outcome> {
  const issue = (await ctx.gh.listOpenIssues(ctx.repo, 0)).find((i) => i.number === num);
  if (!issue) return { kind: "noop" };
  const state = macroStateOf(issue.labels);

  if (issue.labels.includes(PATCH_PROPOSED) || issue.labels.includes(NEEDS_HUMAN)) return { kind: "noop" }; // parked

  if (issue.labels.includes(TRY_FIX) && !issue.labels.includes(PATCH_PROPOSED) && !issue.labels.includes(NEEDS_HUMAN)) {
    return runPatch(ctx, issue);
  }

  switch (state) {
    case "new":
      return gateNewIssue(ctx, issue);
    case "needs-approval":
      return issue.labels.includes(APPROVED) ? executeClose(ctx, issue) : { kind: "waiting", on: "human" };
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
      PANEL_PREFIX,
      "**待审提议** — 关闭并回复（移除 `monastery:needs-approval` 改打 `monastery:approved` 即执行）：",
      "",
      quotedReason,
    ].join("\n");
    await ctx.gh.upsertPanel(ctx.repo, issue.number, draft);
    await ctx.gh.addLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
    await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("needs-approval"));
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

/** The draft reason = all `> ` quoted lines in the panel, joined (round-trips gateNewIssue). */
function extractDraft(panel: string): string | null {
  const quoted = panel.split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2));
  return quoted.length ? quoted.join("\n") : null;
}
