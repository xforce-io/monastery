// src/engine/context.ts — the context layer (ARCHITECTURE §2.3): the shell's "prepare context" arm.
// It gathers one item's semantic context from the resource layer (GitHub) into the agent's typed input.
// A thin assembly module, not a framework.
import type { GitHubAdapter } from "../github/adapter.js";
import type { Issue } from "../types.js";
import type { MaintainerInput } from "../agents/maintainer.js";
import { branchName } from "./patch.js";
import { parseDeps } from "./deps.js";
import { currentSpec, consensusReached } from "../shell/consensus.js";

/** Gather everything the maintainer needs for one item, from the resource layer.
 *  `language` (#76) is the repo's resolved outward-text language, threaded onto the input so the maintainer
 *  writes reply/panel/spec/proposal drafts in it; omitted -> no policy block (back-compat). */
export async function gatherMaintainerContext(gh: GitHubAdapter, repo: string, issue: Issue, language?: string, openIssues?: Issue[]): Promise<MaintainerInput> {
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
  // Endorsement = a 👍 reaction on the spec comment (forge-proof, #92), NOT an endorse comment whose
  // author == owner is forgeable by the agent. Parties who reacted 👍 are the real endorsers.
  const endorsedCurrent = spec
    ? [...new Set((await gh.reactions(repo, spec.id)).filter((r) => r.content === "+1").map((r) => r.author))]
    : [];
  const consensus = { spec, endorsedCurrent, reached: consensusReached(spec, endorsedCurrent) };
  // backlog awareness (ARCHITECTURE §2.3): the other open issues, summarized, so the PM can prioritize.
  // #121: reuse the tick's already-listed open set when threaded down; only re-list when called standalone.
  const open = openIssues ?? await gh.listOpenIssues(repo, 0);
  const backlog = open
    .filter((i) => i.number !== issue.number)
    .map((i) => ({ number: i.number, title: i.title, state: i.state, labels: i.labels }));
  return { thesis, issue, comments, pr, deps, self, consensus, backlog, language };
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
