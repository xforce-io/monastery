// tests/context.test.ts — the context layer: gather one item's semantic context from the resource layer.
import { expect, test } from "vitest";
import { FakeGitHub } from "../src/github/fake.js";
import { gatherMaintainerContext } from "../src/engine/context.js";
import { executeSafe } from "../src/shell/actions.js";
import type { Issue } from "../src/types.js";

test("gatherMaintainerContext assembles thesis + comments + pr + deps + self + consensus from GitHub", async () => {
  const issue: Issue = { number: 5, title: "x", body: "needs upstream\nDepends-on: owner/up#9", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "the repo thesis", issues: [issue] });
  gh.selfLogin = "monastery-bot";
  gh.externalIssues["owner/up#9"] = { number: 9, title: "upstream", body: "", labels: [], state: "closed" };
  gh.prStates["feat/5-x"] = "open"; // monastery's PR for this issue
  gh.authoredComments[5] = [
    { body: "<!--monastery-spec version=1 parties=monastery-bot-->\nthe plan", author: "monastery-bot" },
  ];
  gh.commentReactions["ext0"] = ["+1"];        // a 👍 on the spec comment — endorsement (#92)
  gh.reactionAuthor["ext0"] = "monastery-bot"; // by the sole party

  const input = await gatherMaintainerContext(gh, "o/r", issue);

  expect(input.thesis).toBe("the repo thesis");
  expect(input.issue).toBe(issue);
  expect(input.self).toBe("monastery-bot");
  expect(input.comments.some((c) => c.author === "monastery-bot")).toBe(true);
  expect(input.pr).toEqual({ branch: "feat/5-x", state: "open" });
  expect(input.deps).toEqual([{ ref: "owner/up#9", state: "closed", title: "upstream" }]);
  expect(input.consensus?.spec?.version).toBe(1);
  expect(input.consensus?.reached).toBe(true); // sole party 👍'd the spec (reaction-based, #92)
});

test("#76: the resolved language flows onto the maintainer input when supplied", async () => {
  const issue: Issue = { number: 5, title: "x", body: "y", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const input = await gatherMaintainerContext(gh, "o/r", issue, "zh-CN");
  expect(input.language).toBe("zh-CN");
  // omitted -> undefined (back-compat: no policy block downstream)
  const noLang = await gatherMaintainerContext(gh, "o/r", issue);
  expect(noLang.language).toBeUndefined();
});

test("#92: a self-endorse COMMENT does NOT reach consensus — only a 👍 reaction on the spec counts", async () => {
  const issue: Issue = { number: 5, title: "x", body: "y", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  gh.selfLogin = "monastery-bot";
  gh.authoredComments[5] = [
    { body: "<!--monastery-spec version=1 parties=monastery-bot-->\nplan", author: "monastery-bot" },
    { body: "Endorsed.\n<!--monastery-endorse version=1-->", author: "monastery-bot" }, // forgeable
  ];
  // NO 👍 reaction on the spec comment.
  const input = await gatherMaintainerContext(gh, "o/r", issue);
  expect(input.consensus?.reached).toBe(false); // self-endorse comment doesn't count; needs a real 👍
});

test("regression: an executed endorse action is visible to consensus", async () => {
  const issue: Issue = { number: 6, title: "x", body: "y", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  gh.selfLogin = "monastery-bot";
  await executeSafe(gh, "o/r", { kind: "spec", num: 6, body: "plan", parties: ["monastery-bot"] });
  await executeSafe(gh, "o/r", { kind: "endorse", num: 6, version: 1 });

  const input = await gatherMaintainerContext(gh, "o/r", issue);

  expect(input.consensus?.endorsedCurrent).toContain("monastery-bot");
  expect(input.consensus?.reached).toBe(true);
});

test("gatherMaintainerContext surfaces the backlog (other open issues, summarized, excluding self)", async () => {
  const issues: Issue[] = [
    { number: 5, title: "this one", body: "b", labels: [], state: "open" },
    { number: 7, title: "another", body: "b", labels: ["type:bug"], state: "open" },
    { number: 9, title: "third", body: "b", labels: [], state: "open" },
  ];
  const gh = new FakeGitHub({ thesis: "T", issues });
  const input = await gatherMaintainerContext(gh, "o/r", issues[0]);
  expect(input.backlog).toEqual([
    { number: 7, title: "another", state: "open", labels: ["type:bug"] },
    { number: 9, title: "third", state: "open", labels: [] },
  ]); // excludes #5 (self), summarized (no body)
});

test("gatherMaintainerContext: no pr / no deps / no spec → null pr, empty deps, consensus not reached", async () => {
  const issue: Issue = { number: 6, title: "y", body: "plain", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const input = await gatherMaintainerContext(gh, "o/r", issue);
  expect(input.pr).toBeNull();
  expect(input.deps).toEqual([]);
  expect(input.consensus?.reached).toBe(false);
});

test("gatherMaintainerContext enriches pr with url/number/title/body/isDraft when getPrDetails returns data", async () => {
  const issue: Issue = { number: 5, title: "x", body: "b", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  gh.prStates["feat/5-x"] = "open";
  gh.prDetailsByBranch["feat/5-x"] = { number: 10, url: "https://github.com/o/r/pull/10", title: "fix x", body: "PR body", isDraft: true };

  const input = await gatherMaintainerContext(gh, "o/r", issue);

  expect(input.pr?.url).toBe("https://github.com/o/r/pull/10");
  expect(input.pr?.number).toBe(10);
  expect(input.pr?.title).toBe("fix x");
  expect(input.pr?.body).toBe("PR body");
  expect(input.pr?.isDraft).toBe(true);
});

test("gatherMaintainerContext includes PR conversation comments in pr.comments", async () => {
  const issue: Issue = { number: 5, title: "x", body: "b", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  gh.prStates["feat/5-x"] = "open";
  gh.prDetailsByBranch["feat/5-x"] = { number: 10, url: "https://github.com/o/r/pull/10", title: "t", body: "b", isDraft: false };
  gh.prCommentsByPr[10] = [
    { id: "c1", body: "please fix this", author: "alice" },
    { id: "c2", body: "<!--monastery-panel-->status", author: "monastery" },
  ];

  const input = await gatherMaintainerContext(gh, "o/r", issue);

  expect(input.pr?.comments).toHaveLength(2);
  expect(input.pr?.comments?.[0]).toEqual({ id: "c1", body: "please fix this", author: "alice" });
});

test("gatherMaintainerContext includes PR reviews in pr.reviews", async () => {
  const issue: Issue = { number: 5, title: "x", body: "b", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  gh.prStates["feat/5-x"] = "open";
  gh.prDetailsByBranch["feat/5-x"] = { number: 10, url: "https://github.com/o/r/pull/10", title: "t", body: "b", isDraft: false };
  gh.prReviewsByPr[10] = [{ author: "bob", state: "REQUEST_CHANGES", body: "not ready yet" }];

  const input = await gatherMaintainerContext(gh, "o/r", issue);

  expect(input.pr?.reviews).toEqual([{ author: "bob", state: "REQUEST_CHANGES", body: "not ready yet" }]);
});

test("gatherMaintainerContext includes PR checks summary in pr.checks", async () => {
  const issue: Issue = { number: 5, title: "x", body: "b", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  gh.prStates["feat/5-x"] = "open";
  gh.prDetailsByBranch["feat/5-x"] = { number: 10, url: "https://github.com/o/r/pull/10", title: "t", body: "b", isDraft: false };
  gh.prChecksByPr[10] = "fail";

  const input = await gatherMaintainerContext(gh, "o/r", issue);

  expect(input.pr?.checks).toBe("fail");
});

/** Counts listOpenIssues calls so we can assert the open set is reused, not re-fetched (#121). */
class CountingGitHub extends FakeGitHub {
  public listCalls = 0;
  async listOpenIssues(repo?: string, since?: number) { this.listCalls++; return super.listOpenIssues(repo, since); }
}

test("#121: a threaded-down open list is reused for the backlog — no extra listOpenIssues call", async () => {
  const issues: Issue[] = [
    { number: 5, title: "this one", body: "b", labels: [], state: "open" },
    { number: 7, title: "another", body: "b", labels: ["type:bug"], state: "open" },
  ];
  const gh = new CountingGitHub({ thesis: "T", issues });
  const input = await gatherMaintainerContext(gh, "o/r", issues[0], undefined, issues);
  expect(gh.listCalls).toBe(0);                                  // reused the passed-in set, didn't re-list
  expect(input.backlog).toEqual([{ number: 7, title: "another", state: "open", labels: ["type:bug"] }]);
});

test("#121: called standalone (no open list threaded) it still lists once — back-compat fallback", async () => {
  const issues: Issue[] = [
    { number: 5, title: "this one", body: "b", labels: [], state: "open" },
    { number: 7, title: "another", body: "b", labels: [], state: "open" },
  ];
  const gh = new CountingGitHub({ thesis: "T", issues });
  const input = await gatherMaintainerContext(gh, "o/r", issues[0]);
  expect(gh.listCalls).toBe(1);                                  // no set threaded -> falls back to listing
  expect(input.backlog).toEqual([{ number: 7, title: "another", state: "open", labels: [] }]);
});
