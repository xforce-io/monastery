// tests/patch-rework.test.ts — runRework (#79): update an OPEN draft PR from human feedback, in place.
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { runRework, branchName } from "../src/engine/patch.js";
import type { StepCtx } from "../src/engine/issue-step.js";
import type { ReviewVerdict } from "../src/agents/reviewer.js";
import type { Issue } from "../src/types.js";

const issue: Issue = { number: 7, title: "fix the bug", body: "it crashes", labels: [], state: "open" };
const branch = branchName(issue.number, issue.title);
const clean: ReviewVerdict = { findings: [] };

/** An open monastery draft PR for the issue's branch, carrying human feedback on the PR. */
function reworkable(prNum = 5): FakeGitHub {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  gh.prStates[branch] = "open";
  gh.prDetailsByBranch[branch] = { number: prNum, url: `u/${prNum}`, title: "monastery: fix #7", body: "PR body\nCloses #7", isDraft: true };
  gh.prCommentsByPr[prNum] = [{ id: "pc1", body: "please rename foo to bar", author: "alice" }];
  return gh;
}

function ctx(gh: FakeGitHub, ws: FakeWorkspace, review?: StepCtx["review"]): StepCtx {
  return {
    repo: "o/r", gh, provider: new FakeProvider({}), model: "sonnet",
    artifactRoot: mkdtempSync(join(tmpdir(), "monastery-rework-")),
    fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
    ws, now: () => 0, review,
  };
}

test("happy path: checks out the existing branch, reworks from feedback, updates the SAME PR (no new PR)", async () => {
  const gh = reworkable();
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const c = ctx(gh, ws, async () => clean);
  c.provider = new FakeProvider({}, "改了 foo→bar");
  const out = await runRework(c, issue);
  expect(out.kind).toBe("progressed");
  expect(ws.checkedOut).toHaveLength(1);                 // EXISTING branch checkout, not a fresh clone
  expect(ws.checkedOut[0].branch).toBe(branch);
  expect(ws.cloned).toHaveLength(0);
  expect(ws.committed.map((x) => x.branch)).toEqual([branch]); // pushed to the same branch
  expect(gh.prs).toHaveLength(0);                        // never opens a new PR
  expect((c.provider as FakeProvider).calls[0].context).toContain("please rename foo to bar"); // feedback injected
  const prThread = gh.comments[5] ?? [];
  expect(prThread.some((b) => b.includes("rework"))).toBe(true); // a round summary on the PR
  expect(ws.cleaned).toHaveLength(1);
});

test("regression: rework push succeeds but round comment fails -> next tick does NOT rework again", async () => {
  const gh = reworkable();
  const postComment = gh.postComment.bind(gh);
  let failRoundComment = true;
  gh.postComment = async (repo, num, body) => {
    if (failRoundComment && body.includes("<!--monastery-rework")) {
      failRoundComment = false;
      throw new Error("comment write failed after push");
    }
    await postComment(repo, num, body);
  };
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const c = ctx(gh, ws, async () => clean);

  await expect(runRework(c, issue)).rejects.toThrow(/comment write failed/);
  expect(ws.committed).toHaveLength(1); // the branch was already pushed

  const out = await runRework(c, issue);

  expect(out.kind).toBe("progressed");
  expect(ws.committed).toHaveLength(1);   // no second patch/push for the same feedback
  expect(ws.checkedOut).toHaveLength(1);  // no second checkout either
});

test("no open draft PR for the issue → nothing to rework: panel + noop, no checkout", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] }); // no PR details
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const out = await runRework(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("noop");
  expect(ws.checkedOut).toHaveLength(0);
  expect(gh.panels[7]).toBeDefined();
});

test("a merged PR is terminal: never reworked", async () => {
  const gh = reworkable();
  gh.prStates[branch] = "merged";
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const out = await runRework(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("noop");
  expect(ws.checkedOut).toHaveLength(0);
  expect(gh.panels[7]).toMatch(/merge|合并/i);
});

test("no human feedback on the PR → refuse (nothing to act on): panel + noop, no checkout", async () => {
  const gh = reworkable();
  gh.prCommentsByPr[5] = []; // no human feedback
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const out = await runRework(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("noop");
  expect(ws.checkedOut).toHaveLength(0);
  expect(gh.panels[7]).toMatch(/feedback|反馈/i);
});

test("attempt budget (≤3) exhausted → panel + noop, no checkout", async () => {
  const gh = reworkable();
  gh.comments[5] = [
    "<!--monastery-rework round=1-->\na",
    "<!--monastery-rework round=2-->\nb",
    "<!--monastery-rework round=3-->\nc",
  ];
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const out = await runRework(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("noop");
  expect(ws.checkedOut).toHaveLength(0);
  expect(gh.panels[7]).toMatch(/budget|上限|attempt|轮/i);
});

test("PR review feedback (not just a comment) also triggers rework", async () => {
  const gh = reworkable();
  gh.prCommentsByPr[5] = [];                                              // no conversation comment
  gh.prReviewsByPr[5] = [{ author: "alice", state: "CHANGES_REQUESTED", body: "guard the null case" }];
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const c = ctx(gh, ws, async () => clean);
  const out = await runRework(c, issue);
  expect(out.kind).toBe("progressed");
  expect(ws.checkedOut).toHaveLength(1);
  expect((c.provider as FakeProvider).calls[0].context).toContain("guard the null case");
});

test("a closed (unmerged) PR is not reworked — that's the maintainer's call to re-judge (#102)", async () => {
  const gh = reworkable();
  gh.prStates[branch] = "closed";
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const out = await runRework(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("noop");
  expect(ws.checkedOut).toHaveLength(0);
  expect(gh.panels[7]).toBeDefined();
});

test("an open but non-draft PR (human marked ready) is not reworked", async () => {
  const gh = reworkable();
  gh.prDetailsByBranch[branch] = { number: 5, url: "u/5", title: "t", body: "b", isDraft: false };
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const out = await runRework(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("noop");
  expect(ws.checkedOut).toHaveLength(0);
});

test("#135 patcher made no changes on rework: failed, no commit, keeps checkout for forensics", async () => {
  const gh = reworkable();
  const ws = new FakeWorkspace({ diff: "", tests: true }); // patcher produced nothing
  const out = await runRework(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("failed");
  if (out.kind === "failed") expect(out.error).toMatch(/no changes/i);
  expect(ws.committed).toHaveLength(0);
  expect(ws.cleaned).toHaveLength(0);
  expect(gh.panels[7]).toMatch(/made no changes|workdir/i);
});
