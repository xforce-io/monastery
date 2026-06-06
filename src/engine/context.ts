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
  // monastery's PR state for this issue's branch (so the agent won't re-implement while a PR is open, §8).
  const branch = branchName(issue.number, issue.title);
  const prState = await gh.prState(repo, branch);
  const pr = prState ? { branch, state: prState } : null;
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
