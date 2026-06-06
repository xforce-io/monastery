// tests/issue-step.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { issueStep, readProposalAction } from "../src/engine/issue-step.js";
import type { ReviewFn, ReviewVerdict } from "../src/judges/reviewer.js";

const approvalPanel = (action: string, draft = "") =>
  `<!--monastery-state\nprotocol: approval\naction: ${action}\n-->\n${draft}`;

const fakeFails = () => {
  const m = new Map<string, number>();
  return {
    recordFail: (r: string, n: number) => { const k = `${r}#${n}`; const v = (m.get(k) ?? 0) + 1; m.set(k, v); return v; },
    failCount: (r: string, n: number) => m.get(`${r}#${n}`) ?? 0,
    clearFail: (r: string, n: number) => { m.delete(`${r}#${n}`); },
  };
};
const ctx = (
  gh: FakeGitHub,
  provider: FakeProvider,
  ws: FakeWorkspace = new FakeWorkspace(),
  now: () => number = () => 0,
  review?: ReviewFn,
) => ({
  repo: "o/r", gh, provider, model: "haiku",
  artifactRoot: mkdtempSync(join(tmpdir(), "monastery-step-")),
  fails: fakeFails(),
  ws,
  now,
  review,
});

// Returns a ReviewFn yielding scripted verdicts in order (repeats the last if over-called).
const scriptedReview = (verdicts: (ReviewVerdict | null)[]): ReviewFn => {
  let i = 0;
  return async () => verdicts[Math.min(i++, verdicts.length - 1)];
};

test("virtual new + thesis:out -> needs-approval, panel draft", async () => {
  const gh = new FakeGitHub({ thesis: "AI maintainer only", issues: [{ number: 1, title: "chat", body: "social chat", labels: [], state: "open" }] });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"social chat is off-thesis"}' });
  const c = ctx(gh, provider);
  const out = await issueStep(c, 1);
  expect(out).toEqual({ kind: "progressed" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("thesis:out");
  expect(i.labels).toContain("monastery/state:needs-approval"); // out skips triaged -> straight to needs-approval
  expect(i.labels).toContain("monastery:needs-approval");
  expect(gh.panels[1]).toContain("off-thesis"); // draft reason rendered as a `> ` line in panel
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("virtual new + thesis:in -> triaged parked (no proposal, no approval)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 2, title: "bug", body: "x", labels: [], state: "open" }] });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"within scope"}' });
  const c = ctx(gh, provider);
  await issueStep(c, 2);
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("thesis:in");
  expect(i.labels).toContain("monastery/state:triaged");
  expect(i.labels).not.toContain("monastery:needs-approval");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("needs-approval without approved -> waiting:human (idempotent, gate NOT re-run)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 3, title: "x", body: "y", labels: ["monastery/state:needs-approval", "thesis:out", "monastery:needs-approval"], state: "open" }] });
  const provider = new FakeProvider({}); // must NOT be called
  const c = ctx(gh, provider);
  const out = await issueStep(c, 3);
  expect(out).toEqual({ kind: "waiting", on: "human" });
  expect(provider.calls.length).toBe(0);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("declined -> terminalize to state:done, clear approval ask, panel notes the refusal", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 50, title: "x", body: "y", labels: ["monastery/state:needs-approval", "monastery:needs-approval", "monastery:declined"], state: "open" }] });
  const c = ctx(gh, new FakeProvider({}));
  const out = await issueStep(c, 50);
  expect(out).toEqual({ kind: "done" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery/state:done");
  expect(i.labels).not.toContain("monastery:needs-approval");
  expect(i.labels).not.toContain("monastery/state:needs-approval");
  expect(gh.panels[50]).toContain("人工拒绝");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("declined already terminalized -> noop (idempotent, never re-proposes)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 51, title: "x", body: "y", labels: ["monastery/state:done", "monastery:declined"], state: "open" }] });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"r"}' });
  const c = ctx(gh, provider);
  const out = await issueStep(c, 51);
  expect(out).toEqual({ kind: "noop" });
  expect(provider.calls.length).toBe(0); // gate not re-run
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("needs-approval past timeout -> auto-skip to declined/done with timeout note", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 52, title: "x", body: "y", labels: ["monastery/state:needs-approval", "monastery:needs-approval"], state: "open" }] });
  gh.labelTimes["52:monastery:needs-approval"] = 0;          // labeled at t=0
  const c = ctx(gh, new FakeProvider({}), undefined, () => 48 * 3_600_000); // exactly 48h later
  const out = await issueStep(c, 52);
  expect(out).toEqual({ kind: "done" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery/state:done");
  expect(i.labels).not.toContain("monastery:needs-approval");
  expect(i.labels).toContain("monastery:declined"); // timeout shares the declined terminal state
  expect(gh.panels[52]).toContain("自动跳过");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("needs-approval not yet past timeout -> still waiting:human, untouched", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 53, title: "x", body: "y", labels: ["monastery/state:needs-approval", "monastery:needs-approval"], state: "open" }] });
  gh.labelTimes["53:monastery:needs-approval"] = 1000;       // labeled at t=1000
  const c = ctx(gh, new FakeProvider({}), undefined, () => 1000 + 48 * 3_600_000 - 1); // 1ms short of 48h
  const out = await issueStep(c, 53);
  expect(out).toEqual({ kind: "waiting", on: "human" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:needs-approval");
  expect(i.labels).not.toContain("monastery/state:done");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("needs-approval with no recorded label time -> waiting:human (no auto-skip)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 54, title: "x", body: "y", labels: ["monastery/state:needs-approval", "monastery:needs-approval"], state: "open" }] });
  const c = ctx(gh, new FakeProvider({}), undefined, () => 999 * 3_600_000); // far future, but no labelTime
  const out = await issueStep(c, 54);
  expect(out).toEqual({ kind: "waiting", on: "human" });
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("approved -> post reason + close + state:done", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 4, title: "x", body: "y", labels: ["monastery/state:needs-approval", "thesis:out", "monastery:approved"], state: "open" }] });
  await gh.upsertPanel("o/r", 4, "<!--monastery-state\nprotocol: gate\n-->\n**待审提议**\n\n> thanks, but out of scope");
  const c = ctx(gh, new FakeProvider({}));
  const out = await issueStep(c, 4);
  expect(out).toEqual({ kind: "done" });
  expect(gh.closed).toContain(4);
  expect(gh.comments[4]?.join("\n")).toContain("out of scope");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("multi-line out reason round-trips: every line quoted, full reason posted on approval", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 9, title: "x", body: "y", labels: [], state: "open" }] });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"line one.\\nline two."}' });
  const c = ctx(gh, provider);
  await issueStep(c, 9);                 // virtual new -> needs-approval, panel draft
  expect(gh.panels[9]).toContain("> line one.");
  expect(gh.panels[9]).toContain("> line two.");
  await gh.addLabel("o/r", 9, "monastery:approved"); // human approves
  const out = await issueStep(c, 9);     // needs-approval + approved -> close
  expect(out).toEqual({ kind: "done" });
  const posted = gh.comments[9]?.join("\n") ?? "";
  expect(posted).toContain("line one.");
  expect(posted).toContain("line two.");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("readProposalAction: legacy panel (no action field) defaults to close; reads close/implement; null for unknown", () => {
  expect(readProposalAction("<!--monastery-state\nprotocol: gate\n-->\n> reason")).toBe("close"); // back-compat
  expect(readProposalAction(approvalPanel("close", "> r"))).toBe("close");
  expect(readProposalAction(approvalPanel("implement", "draft"))).toBe("implement");
  expect(readProposalAction(approvalPanel("frobnicate"))).toBeNull();
  expect(readProposalAction("")).toBe("close"); // empty panel -> back-compat close
});

test("out proposal panel carries the typed approval marker (action: close)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 60, title: "x", body: "y", labels: [], state: "open" }] });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"off-thesis"}' });
  const c = ctx(gh, provider);
  await issueStep(c, 60);
  expect(gh.panels[60]).toContain("action: close");
  expect(readProposalAction(gh.panels[60])).toBe("close");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("action:implement + approved -> try-fix added, state:classified, approval labels cleared", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 61, title: "x", body: "y", labels: ["monastery/state:needs-approval", "monastery:needs-approval", "monastery:approved"], state: "open" }] });
  await gh.upsertPanel("o/r", 61, approvalPanel("implement", "**待审设计提案** — 实现方案 draft"));
  const c = ctx(gh, new FakeProvider({}));
  const out = await issueStep(c, 61);
  expect(out).toEqual({ kind: "progressed" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:try-fix");
  expect(i.labels).toContain("monastery/state:classified");
  expect(i.labels).not.toContain("monastery:needs-approval");
  expect(i.labels).not.toContain("monastery/state:needs-approval");
  expect(gh.closed).not.toContain(61); // implement never closes the issue
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("action:implement past 48h with no approval -> still waiting:human (NOT auto-skipped)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 62, title: "x", body: "y", labels: ["monastery/state:needs-approval", "monastery:needs-approval"], state: "open" }] });
  await gh.upsertPanel("o/r", 62, approvalPanel("implement", "design draft"));
  gh.labelTimes["62:monastery:needs-approval"] = 0;
  const c = ctx(gh, new FakeProvider({}), undefined, () => 999 * 48 * 3_600_000); // far past 48h
  const out = await issueStep(c, 62);
  expect(out).toEqual({ kind: "waiting", on: "human" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:needs-approval");
  expect(i.labels).not.toContain("monastery/state:done"); // design proposals are never silently skipped
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("needs-revision -> clears approved + needs-revision, returns to needs-approval (no execute)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 63, title: "x", body: "y", labels: ["monastery/state:needs-approval", "monastery:needs-approval", "monastery:approved", "monastery:needs-revision"], state: "open" }] });
  await gh.upsertPanel("o/r", 63, approvalPanel("close", "> reason"));
  const c = ctx(gh, new FakeProvider({}));
  const out = await issueStep(c, 63);
  expect(out).toEqual({ kind: "progressed" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).not.toContain("monastery:approved");
  expect(i.labels).not.toContain("monastery:needs-revision");
  expect(i.labels).toContain("monastery:needs-approval");
  expect(i.labels).toContain("monastery/state:needs-approval"); // stays awaiting a fresh draft
  expect(gh.closed).not.toContain(63); // revision must not execute the (previously approved) action
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("transient gate failure: first skips are local — no GitHub write, issue stays virtual-new", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 10, title: "x", body: "y", labels: [], state: "open" }] });
  const c = ctx(gh, new FakeProvider({})); // null verdict (no file, no resultText)
  const out = await issueStep(c, 10);
  expect(out).toEqual({ kind: "noop" });
  expect(gh.panels[10]).toBeUndefined();
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toEqual([]);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("persistent gate failure escalates to a panel note after threshold (3)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 11, title: "x", body: "y", labels: [], state: "open" }] });
  const c = ctx(gh, new FakeProvider({}));
  await issueStep(c, 11);
  await issueStep(c, 11);
  expect(gh.panels[11]).toBeUndefined(); // silent at 2
  await issueStep(c, 11);
  expect(gh.panels[11]).toContain("needs a human"); // escalated at 3
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("success after failures resets counter and reconciles the stale escalation panel", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 12, title: "x", body: "y", labels: [], state: "open" }] });
  const c = ctx(gh, new FakeProvider({}));
  await issueStep(c, 12); await issueStep(c, 12); await issueStep(c, 12); // escalated
  expect(gh.panels[12]).toContain("needs a human");
  // same ctx (same fails tracker), but now the provider yields a valid verdict:
  const ok = { ...c, provider: new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"ok"}' }) };
  const out = await issueStep(ok, 12);
  expect(out).toEqual({ kind: "progressed" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("thesis:in");
  expect(i.labels).toContain("monastery/state:triaged");
  expect(gh.panels[12]).toContain("resolved"); // stale escalation reconciled
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("triaged + thesis:in -> triager classifies and advances to classified", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 20, title: "crash", body: "broken", labels: ["monastery/state:triaged", "thesis:in"], state: "open" }] });
  const c = ctx(gh, new FakeProvider({ "triage.json": '{"type":"bug"}' }));
  const out = await issueStep(c, 20);
  expect(out).toEqual({ kind: "progressed" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("type:bug");
  expect(i.labels).toContain("monastery/state:classified");
  expect(i.labels).not.toContain("monastery/state:triaged");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("triaged + thesis:unclear -> parked (noop, triager not run)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 21, title: "x", body: "y", labels: ["monastery/state:triaged", "thesis:unclear"], state: "open" }] });
  const provider = new FakeProvider({ "triage.json": '{"type":"bug"}' });
  const c = ctx(gh, provider);
  const out = await issueStep(c, 21);
  expect(out).toEqual({ kind: "noop" });
  expect(provider.calls.length).toBe(0);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("try-fix with changes -> draft PR opened, patch-proposed added, try-fix removed", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 30, title: "bug", body: "broken", labels: ["monastery:try-fix", "type:bug"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const c = ctx(gh, new FakeProvider({}), ws, () => 0, scriptedReview([{ findings: [] }]));
  const out = await issueStep(c, 30);
  expect(out.kind).toBe("progressed");
  expect(ws.cloned[0]).toMatchObject({ repo: "o/r", branch: "feat/30-bug" });
  expect(ws.committed).toHaveLength(1);
  expect(gh.prs[0].head).toBe("feat/30-bug");
  expect(gh.prs[0].body).toContain("Closes #30");
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:patch-proposed");
  expect(i.labels).not.toContain("monastery:try-fix");
  expect(ws.cleaned).toHaveLength(1); // cleanup always runs (finally)
  expect(ws.diffCalls).toBe(2);       // re-stage after tests so regenerated files (e.g. lockfile) get committed
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("try-fix with NO changes -> no PR, transient skip, escalates to needs-human after threshold", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 31, title: "bug", body: "x", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "", tests: null });
  const c = ctx(gh, new FakeProvider({}), ws);
  await issueStep(c, 31);
  await issueStep(c, 31);
  expect(gh.prs).toHaveLength(0);
  expect((await gh.listOpenIssues("o/r", 0))[0].labels).not.toContain("monastery:needs-human");
  await issueStep(c, 31); // 3rd -> escalate
  expect((await gh.listOpenIssues("o/r", 0))[0].labels).toContain("monastery:needs-human");
  expect(gh.prs).toHaveLength(0);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("patch-proposed / needs-human issues are parked (noop, nothing run)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 41, title: "x", body: "y", labels: ["monastery:patch-proposed"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "d" });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"x"}' });
  const c = ctx(gh, provider, ws);
  const out = await issueStep(c, 41);
  expect(out).toEqual({ kind: "noop" });
  expect(provider.calls).toHaveLength(0); // not gated
  expect(ws.cloned).toHaveLength(0);      // not patched
});

test("try-fix when a PR already exists for the branch -> converge labels, no re-clone", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 40, title: "x", body: "y", labels: ["monastery:try-fix"], state: "open" }] });
  await gh.openDraftPR("o/r", "feat/40-x", "t", "b"); // prior run opened the PR but failed to label
  const ws = new FakeWorkspace({ diff: "d", tests: true });
  const c = ctx(gh, new FakeProvider({}), ws);
  const out = await issueStep(c, 40);
  expect(out.kind).toBe("progressed");
  expect(ws.cloned).toHaveLength(0); // converged without re-cloning
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:patch-proposed");
  expect(i.labels).not.toContain("monastery:try-fix");
});

test("patch-proposed issue is not patched again", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 32, title: "x", body: "y", labels: ["monastery:try-fix", "monastery:patch-proposed", "monastery/state:classified", "thesis:in", "type:bug"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "d", tests: true });
  const c = ctx(gh, new FakeProvider({}), ws);
  await issueStep(c, 32);
  expect(ws.cloned).toHaveLength(0); // override skipped (already proposed); classified -> noop
  expect(gh.prs).toHaveLength(0);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("try-fix clean review -> draft PR opened, no fix run, diff staged twice", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 70, title: "bug", body: "broken", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const provider = new FakeProvider({});
  const c = ctx(gh, provider, ws, () => 0, scriptedReview([{ findings: [] }]));
  const out = await issueStep(c, 70);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);
  expect(provider.calls).toHaveLength(1); // only the initial edit; no fix run
  expect(ws.diffCalls).toBe(2);           // re-stage after tests reused for the first review
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("try-fix reviewer fails (null) -> conservative pass, PR opens with a note", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 71, title: "bug", body: "broken", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const c = ctx(gh, new FakeProvider({}), ws, () => 0, scriptedReview([null]));
  const out = await issueStep(c, 71);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);
  expect(gh.prs[0].body).toContain("自审未能运行"); // conservative-pass note
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("try-fix blocking then clean -> one fix run, then PR opened", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 72, title: "bug", body: "broken", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const provider = new FakeProvider({});
  const review = scriptedReview([
    { findings: [{ severity: "blocking", title: "off-by-one", detail: "loop bound" }] },
    { findings: [] },
  ]);
  const c = ctx(gh, provider, ws, () => 0, review);
  const out = await issueStep(c, 72);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);
  expect(provider.calls).toHaveLength(2);       // initial edit + one fix run
  expect(provider.calls[1].persona).toContain("addressing review feedback");
  expect(ws.diffCalls).toBe(3);                 // re-stage after tests, then after the fix
  expect(gh.prs[0].body).toContain("off-by-one"); // the fixed blocking title is listed in the PR body
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("try-fix review never clean -> needs-human after 3 iters, no PR", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 73, title: "bug", body: "broken", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const blocking = { findings: [{ severity: "blocking" as const, title: "still wrong", detail: "d" }] };
  const c = ctx(gh, new FakeProvider({}), ws, () => 0, scriptedReview([blocking, blocking, blocking]));
  const out = await issueStep(c, 73);
  expect(out).toEqual({ kind: "noop" });
  expect(gh.prs).toHaveLength(0);                       // never opened a PR
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:needs-human");
  expect(gh.panels[73]).toContain("still wrong");
  expect(ws.committed).toHaveLength(0);                 // no push
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("advisory-only review -> no fix, PR body lists advisory", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 74, title: "bug", body: "broken", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const review = scriptedReview([{ findings: [{ severity: "advisory", title: "rename foo", detail: "clarity" }] }]);
  const c = ctx(gh, new FakeProvider({}), ws, () => 0, review);
  const out = await issueStep(c, 74);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);
  expect(gh.prs[0].body).toContain("rename foo");       // advisory surfaced in PR body
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
