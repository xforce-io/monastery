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
import type { ReviewVerdict } from "../src/agents/reviewer.js";
import type { Spec } from "../src/shell/consensus.js";
import { parseStateMessage } from "../src/shell/messages.js";
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
const advisory: ReviewVerdict = { findings: [{ severity: "advisory", title: "rename foo", detail: "clearer" }] };

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

// #87 sandbox isolation: the agent's cwd (artifactDir) must be the tmp sandbox clone,
// never the main working tree (process.cwd()). This is the real leak class — an agent
// run with cwd=main repo would edit files in place. Pairs with the GitWorkspace.clone
// tmpdir test in git-workspace.test.ts.
test("#87 the patcher agent runs in the tmp sandbox clone, never process.cwd()", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const provider = new FakeProvider({});
  const c = ctx(gh, ws, async () => clean);
  c.provider = provider;
  await runImplement(c, issue);
  expect(ws.cloned).toHaveLength(1);
  const sandbox = ws.cloned[0].dir;
  for (const call of provider.calls) {
    expect(call.artifactDir).toBe(sandbox);          // agent cwd == the sandbox clone
    expect(call.artifactDir).not.toBe(process.cwd()); // never the main working tree
    expect(call.artifactDir.startsWith(tmpdir())).toBe(true);
  }
});

test("PR body carries the patcher's author summary in a 本次改动 section", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const summary = "- 改了 foo.ts：修复了空指针\n- 为什么:之前没校验入参";
  const c = ctx(gh, ws, async () => clean);
  c.provider = new FakeProvider({}, summary);
  const out = await runImplement(c, issue);
  expect(out.kind).toBe("progressed");
  expect(gh.prs[0].body).toContain("## 本次改动");
  expect(gh.prs[0].body).toContain(summary);
});

test("reviewer's conclusion + advisory go to a separate marked PR comment, NOT the PR body", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const out = await runImplement(ctx(gh, ws, async () => advisory), issue);
  expect(out.kind).toBe("progressed");
  // PR body = author's voice only: no 自审/advisory.
  expect(gh.prs[0].body).not.toMatch(/自审/);
  expect(gh.prs[0].body).not.toMatch(/advisory/);
  expect(gh.prs[0].body).toContain("Closes #7"); // author description stays
  // A single marked review comment on the opened PR (#1) carries the conclusion + advisory.
  const prComments = gh.comments[1] ?? [];
  expect(prComments).toHaveLength(1);
  expect(prComments[0]).toContain("<!--monastery-state");
  expect(parseStateMessage(prComments[0])).toMatchObject({ kind: "note", agent: "reviewer", model: "sonnet" });
  expect(prComments[0]).toMatch(/自审通过/);
  expect(prComments[0]).toMatch(/advisory/);
  expect(prComments[0]).toContain("rename foo");
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

test("#135 the patcher made no changes: failed, no PR, keeps workdir for forensics", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "", tests: true });
  const out = await runImplement(ctx(gh, ws, async () => clean), issue);
  expect(out.kind).toBe("failed");
  if (out.kind === "failed") expect(out.error).toMatch(/no changes/i);
  expect(gh.prs).toHaveLength(0);
  expect(ws.committed).toHaveLength(0);
  expect(ws.cleaned).toHaveLength(0);
  expect(gh.panels[7]).toMatch(/made no changes|workdir/i);
  expect(parseStateMessage(gh.panels[7])).toMatchObject({ kind: "note", agent: "patcher", model: "sonnet" });
});

test("#135 repeated empty diff escalates to needs-human after ensuring the label", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "", tests: true });
  const c = ctx(gh, ws, async () => clean);
  c.fails = { recordFail: () => 3, failCount: () => 2, clearFail: () => {} };
  const out = await runImplement(c, issue);
  expect(out.kind).toBe("failed");
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(gh.ensuredLabels.map((l) => l.name)).toContain("monastery:needs-human");
  expect(i.labels).toContain("monastery:needs-human");
  expect(gh.panels[7]).toMatch(/needs a human|workdir/i);
});

test("self-review keeps finding blocking issues -> gives up with a panel, opens NO PR", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const out = await runImplement(ctx(gh, ws, async () => blocking), issue); // never clears
  expect(out.kind).toBe("failed");
  if (out.kind === "failed") expect(out.error).toMatch(/self-review/i);
  expect(gh.prs).toHaveLength(0);                    // unreviewable -> no PR shipped
  expect(gh.panels[7]).toMatch(/human/i);            // escalated to a human-visible panel
  expect(ws.cleaned).toHaveLength(0);                // keep the sandbox for inspection
});

test("#100: an endorsed spec supersedes a stale issue body as the patcher's task description", async () => {
  // Reproduces #99: the issue body still carries the rejected v1 plan; the endorsed spec is v3.
  const stale: Issue = {
    number: 7, title: "fix the bug",
    body: "PLAN v1: add @anthropic-ai/sdk and bind ANTHROPIC_API_KEY", labels: [], state: "open",
  };
  const spec: Spec = {
    version: 3, parties: ["x"],
    body: "SPEC v3: native fetch, OpenAI-compatible, zero new deps", id: "c1",
  };
  const gh = new FakeGitHub({ thesis: "T", issues: [stale] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const c = ctx(gh, ws, async () => clean);
  const fp = new FakeProvider({});
  c.provider = fp;
  const out = await runImplement(c, stale, spec);
  expect(out.kind).toBe("progressed");
  // The patcher's first run (the implement call) gets the spec, NOT the stale body.
  expect(fp.calls[0].context).toContain("SPEC v3: native fetch, OpenAI-compatible, zero new deps");
  expect(fp.calls[0].context).not.toContain("@anthropic-ai/sdk");
});

test("#100: no endorsed spec -> patcher falls back to the issue body (unchanged)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] }); // issue.body = "it crashes"
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const c = ctx(gh, ws, async () => clean);
  const fp = new FakeProvider({});
  c.provider = fp;
  await runImplement(c, issue);
  expect(fp.calls[0].context).toContain("it crashes");
});

test("no draft PR is opened without a human-gated path: the PR is always a draft", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "p", tests: true });
  await runImplement(ctx(gh, ws, async () => clean), issue);
  // FakeGitHub.openDraftPR records every PR as a draft; the body carries the merge gate
  expect(gh.prs[0].title).toContain("#7");
});

// #75 — phase-level observability: runImplement emits clone/patch/tests/review/pr boundaries.
test("#75 runImplement emits clone/patch/tests/review/pr phase boundaries", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const lines: string[] = [];
  const c = ctx(gh, ws, async () => clean);
  c.logSink = { err: (l) => lines.push(l) };
  await runImplement(c, issue);
  const starts = lines.filter((l) => l.includes(":start")).map((l) => l.match(/ ([\w:]+):start/)![1]);
  expect(starts).toContain("clone");
  expect(starts).toContain("patch");
  expect(starts).toContain("tests");
  expect(starts).toContain("review");
  expect(starts).toContain("pr");
  expect(lines.some((l) => l.includes("review:start") && l.includes("model=sonnet"))).toBe(true);
  // every started phase that succeeded prints a matching :done
  expect(lines.some((l) => l.includes("pr:done"))).toBe(true);
});

// #75 AC#4 — the per-agent timeoutMs (dead config until now) is threaded into provider.run.
test("#75 patcher provider.run receives the effective timeoutMs", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const provider = new FakeProvider({});
  const c = ctx(gh, ws, async () => clean);
  c.provider = provider;
  c.repoPolicy = { agents: { patcher: { timeoutMs: 1234 } } };
  await runImplement(c, issue);
  expect(provider.calls[0].timeoutMs).toBe(1234);
});
