// src/engine/issue-step.ts
import { join } from "node:path";
import type { GitHubAdapter } from "../github/adapter.js";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue, Outcome } from "../types.js";
import { macroStateOf, stateLabel, THESIS, NEEDS_APPROVAL, APPROVED } from "../github/labels.js";
import { thesisGate } from "../judges/thesis-gate.js";

export interface StepCtx {
  repo: string;
  gh: GitHubAdapter;
  provider: AgentProvider;
  model: string;
  artifactRoot: string;
}

const PANEL_PREFIX = "<!--monastery-state\nprotocol: gate\n-->";

export async function issueStep(ctx: StepCtx, num: number): Promise<Outcome> {
  const issue = (await ctx.gh.listOpenIssues(ctx.repo, 0)).find((i) => i.number === num);
  if (!issue) return { kind: "noop" };
  const state = macroStateOf(issue.labels);

  switch (state) {
    case "new":
      return gateNewIssue(ctx, issue);
    case "needs-approval":
      return issue.labels.includes(APPROVED) ? executeClose(ctx, issue) : { kind: "waiting", on: "human" };
    case "triaged":
      return { kind: "noop" };
    default:
      return { kind: "noop" };
  }
}

async function gateNewIssue(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const thesis = await ctx.gh.readThesis(ctx.repo);
  const dir = join(ctx.artifactRoot, `${issue.number}`);
  const v = await thesisGate(ctx.provider, ctx.model, thesis, issue, dir);
  if (!v) {
    await ctx.gh.upsertPanel(ctx.repo, issue.number, `${PANEL_PREFIX}\n⚠️ thesis-gate produced no valid verdict; skipped this tick.`);
    return { kind: "noop" };
  }

  await ctx.gh.addLabel(ctx.repo, issue.number, THESIS[v.verdict]);

  if (v.verdict === "out") {
    const draft = [
      PANEL_PREFIX,
      "**待审提议** — 关闭并回复（移除 `monastery:needs-approval` 改打 `monastery:approved` 即执行）：",
      "",
      `> ${v.reason}`,
    ].join("\n");
    await ctx.gh.upsertPanel(ctx.repo, issue.number, draft);
    await ctx.gh.addLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
    await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("needs-approval"));
  } else {
    await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("triaged"));
  }
  return { kind: "progressed" };
}

async function executeClose(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const panel = await ctx.gh.readPanel(ctx.repo, issue.number);
  const reason = extractDraft(panel) ?? "Closing as out of scope for this repo's thesis.";
  await ctx.gh.postComment(ctx.repo, issue.number, reason);
  await ctx.gh.closeIssue(ctx.repo, issue.number);
  await ctx.gh.removeLabel(ctx.repo, issue.number, stateLabel("needs-approval"));
  await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("done"));
  return { kind: "done" };
}

/** The draft reason is the last `> quoted` block in the panel. */
function extractDraft(panel: string): string | null {
  const quoted = panel.split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2));
  return quoted.length ? quoted.join("\n") : null;
}
