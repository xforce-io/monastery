// tests/patch-implement.test.ts — runImplement: the shell-owned patcher executor (proposal-driven).
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { runImplement } from "../src/engine/patch.js";
import type { StepCtx } from "../src/engine/issue-step.js";
import type { ReviewVerdict } from "../src/judges/reviewer.js";
import type { Issue } from "../src/types.js";

const issue: Issue = { number: 7, title: "fix the bug", body: "it crashes", labels: [], state: "open" };

function ctx(gh: FakeGitHub, ws: FakeWorkspace, review?: StepCtx["review"]): StepCtx {
  return {
    repo: "o/r", gh, provider: new FakeProvider({}), model: "sonnet",
    artifactRoot: mkdtempSync(join(tmpdir(), "monastery-impl-")),
    fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
    ws, now: () => 0, review,
  };
}
const clean: ReviewVerdict = { findings: [] };
const blocking: ReviewVerdict = { findings: [{ severity: "blocking", title: "no test", detail: "add one" }] };

test("happy path: writes a patch in a sandbox, self-review passes, opens a draft PR", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const out = await runImplement(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("progressed");
  expect(ws.cloned).toHaveLength(1);                 // ran in a sandbox clone
  expect(ws.committed.map((c) => c.branch)).toEqual(["feat/7-fix-the-bug"]);
  expect(gh.prs).toHaveLength(1);                    // a draft PR was opened
  expect(gh.prs[0].body).toContain("Closes #7");     // human-merge gate
  expect(ws.cleaned).toHaveLength(1);                // sandbox cleaned up
});

test("idempotent: an open PR for the branch already exists -> converge, do NOT re-run the patcher", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  await gh.openDraftPR("o/r", "feat/7-fix-the-bug", "t", "b"); // a prior run's PR
  const ws = new FakeWorkspace({ diff: "x", tests: true });
  const out = await runImplement(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("progressed");
  expect(ws.cloned).toHaveLength(0);                 // converged: no clone, no agent
  expect(gh.prs).toHaveLength(1);                    // no second PR
});

test("the patcher made no changes: transient skip, no PR", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "", tests: true });
  const out = await runImplement(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("noop");
  expect(gh.prs).toHaveLength(0);
});

test("self-review keeps finding blocking issues -> gives up with a panel, opens NO PR", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const out = await runImplement(ctx(gh, ws, async () => blocking), issue); // never clears
  expect(out.kind).toBe("noop");
  expect(gh.prs).toHaveLength(0);                    // unreviewable -> no PR shipped
  expect(gh.panels[7]).toMatch(/human/i);            // escalated to a human-visible panel
});

test("no draft PR is opened without a human-gated path: the PR is always a draft", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "p", tests: true });
  await runImplement(ctx(gh, ws, async () => clean), issue);
  // FakeGitHub.openDraftPR records every PR as a draft; the body carries the merge gate
  expect(gh.prs[0].title).toContain("#7");
});
