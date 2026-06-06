// tests/context.test.ts — the context layer: gather one item's semantic context from the resource layer.
import { expect, test } from "vitest";
import { FakeGitHub } from "../src/github/fake.js";
import { gatherMaintainerContext } from "../src/engine/context.js";
import type { Issue } from "../src/types.js";

test("gatherMaintainerContext assembles thesis + comments + pr + deps + self + consensus from GitHub", async () => {
  const issue: Issue = { number: 5, title: "x", body: "needs upstream\nDepends-on: owner/up#9", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "the repo thesis", issues: [issue] });
  gh.selfLogin = "monastery-bot";
  gh.externalIssues["owner/up#9"] = { number: 9, title: "upstream", body: "", labels: [], state: "closed" };
  gh.prStates["feat/5-x"] = "open"; // monastery's PR for this issue
  gh.authoredComments[5] = [
    { body: "<!--monastery-spec version=1 parties=monastery-bot-->\nthe plan", author: "monastery-bot" },
    { body: "ok\n<!--monastery-endorse version=1-->", author: "monastery-bot" },
  ];

  const input = await gatherMaintainerContext(gh, "o/r", issue);

  expect(input.thesis).toBe("the repo thesis");
  expect(input.issue).toBe(issue);
  expect(input.self).toBe("monastery-bot");
  expect(input.comments.some((c) => c.author === "monastery-bot")).toBe(true);
  expect(input.pr).toEqual({ branch: "feat/5-x", state: "open" });
  expect(input.deps).toEqual([{ ref: "owner/up#9", state: "closed", title: "upstream" }]);
  expect(input.consensus?.spec?.version).toBe(1);
  expect(input.consensus?.reached).toBe(true); // sole party (monastery-bot) endorsed v1
});

test("gatherMaintainerContext: no pr / no deps / no spec → null pr, empty deps, consensus not reached", async () => {
  const issue: Issue = { number: 6, title: "y", body: "plain", labels: [], state: "open" };
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const input = await gatherMaintainerContext(gh, "o/r", issue);
  expect(input.pr).toBeNull();
  expect(input.deps).toEqual([]);
  expect(input.consensus?.reached).toBe(false);
});
