// src/engine/context.ts — the context layer (ARCHITECTURE §2.3): the shell's "prepare context" arm.
// It gathers one item's semantic context from the resource layer (GitHub) into the agent's typed input.
// A thin assembly module, not a framework.
import type { GitHubAdapter } from "../github/adapter.js";
import type { Issue } from "../types.js";
import type { MaintainerInput } from "../agents/maintainer.js";
import { branchName } from "./patch.js";
import { parseDeps } from "./deps.js";
import { currentSpec, parseEndorsements, consensusReached } from "../shell/consensus.js";

/** Gather everything the maintainer needs for one item, from the resource layer. */
export async function gatherMaintainerContext(gh: GitHubAdapter, repo: string, issue: Issue): Promise<MaintainerInput> {
  const thesis = await gh.readThesis(repo);
  const comments = await gh.listComments(repo, issue.number);
  // monastery's PR for this issue's branch: gather state + rich context so the agent sees human PR feedback.
  const branch = branchName(issue.number, issue.title);
  const prState = await gh.prState(repo, branch);
  let pr: MaintainerInput["pr"] = null;
  if (prState) {
    const details = await gh.getPrDetails(repo, branch);
    if (details) {
      const [prComments, prReviews, checks] = await Promise.all([
        gh.listPrComments(repo, details.number),
        gh.listPrReviews(repo, details.number),
        gh.getPrChecks(repo, details.number),
      ]);
      pr = { branch, state: prState, ...details, comments: prComments, reviews: prReviews, checks };
    } else {
      pr = { branch, state: prState };
    }
  }
  // read-only cross-repo awareness: each `Depends-on:` upstream's current state (P0).
  const deps = await resolveDeps(gh, issue.body);
  // multi-party consensus state: current shared spec + endorsements (P1).
  const self = await gh.login();
  const spec = currentSpec(comments);
  const endorsedCurrent = spec
    ? parseEndorsements(comments).filter((e) => e.version === spec.version).map((e) => e.by)
    : [];
  const consensus = { spec, endorsedCurrent, reached: consensusReached(comments) };
  // backlog awareness (ARCHITECTURE §2.3): the other open issues, summarized, so the PM can prioritize.
  // (Re-listed per item — cheap, and self-contained; thread the open list down only if scale needs it.)
  const open = await gh.listOpenIssues(repo, 0);
  const backlog = open
    .filter((i) => i.number !== issue.number)
    .map((i) => ({ number: i.number, title: i.title, state: i.state, labels: i.labels }));
  return { thesis, issue, comments, pr, deps, self, consensus, backlog };
}

/** Resolve an issue's `Depends-on:` upstream refs to their current state (read-only; missing skipped). */
async function resolveDeps(gh: GitHubAdapter, body: string): Promise<{ ref: string; state: "open" | "closed"; title: string }[]> {
  const out: { ref: string; state: "open" | "closed"; title: string }[] = [];
  for (const { repo, num } of parseDeps(body)) {
    const dep = await gh.getIssue(repo, num);
    if (dep) out.push({ ref: `${repo}#${num}`, state: dep.state, title: dep.title });
  }
  return out;
}
