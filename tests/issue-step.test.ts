// tests/issue-step.test.ts — v2 L_item: active -> maintainer -> executeSafe; awaiting-gate -> signal -> gated; terminal -> ignore.
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { issueStep, FAIL_THRESHOLD, type StepCtx } from "../src/engine/issue-step.js";
import { executeSafe, proposeGate, type Action } from "../src/shell/actions.js";
import { StructuredAgentError } from "../src/agents/spec.js";
import type { Issue } from "../src/types.js";

const NEEDS_APPROVAL = "monastery:needs-approval";
const DECLINED = "monastery:declined";

function ctxWith(gh: FakeGitHub, provider: FakeProvider, fails?: Partial<StepCtx["fails"]>): StepCtx {
  return {
    repo: "o/r", gh, provider, model: "sonnet",
    artifactRoot: mkdtempSync(join(tmpdir(), "monastery-step-")),
    fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {}, ...fails },
    ws: new FakeWorkspace(), now: () => 0,
  };
}
const ghWith = (issue: Issue) => new FakeGitHub({ thesis: "T", issues: [issue] });
const actionsJson = (actions: Action[]) => ({ "actions.json": JSON.stringify({ actions }) });

// --- active: call the maintainer agent, execute its safe actions ---

test("active issue: the agent's proposed safe actions are executed", async () => {
  const gh = ghWith({ number: 5, title: "x", body: "y", labels: [], state: "open" });
  const provider = new FakeProvider(actionsJson([{ kind: "relabel", num: 5, add: ["type:bug"], remove: [] }]));
  const out = await issueStep(ctxWith(gh, provider), 5);
  expect(out.kind).toBe("progressed");
  expect(provider.calls).toHaveLength(1);
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("type:bug");
});

test("active issue: a propose(close) action moves the item to awaiting-gate (approval comment + needs-approval)", async () => {
  const gh = ghWith({ number: 6, title: "x", body: "y", labels: [], state: "open" });
  const provider = new FakeProvider(actionsJson([{ kind: "propose", num: 6, proposal: "close", draft: "out of scope" }]));
  await issueStep(ctxWith(gh, provider), 6);
  expect(gh.comments[6][0]).toContain("action: close");
  expect(gh.comments[6][0]).toContain("out of scope");
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain(NEEDS_APPROVAL);
});

test("active issue: an empty action list is a no-op (nothing to do)", async () => {
  const gh = ghWith({ number: 7, title: "x", body: "y", labels: [], state: "open" });
  const out = await issueStep(ctxWith(gh, new FakeProvider(actionsJson([]))), 7);
  expect(out.kind).toBe("noop");
});

test("active issue: actions targeting a different issue are rejected wholesale (shell constrains the agent)", async () => {
  const gh = ghWith({ number: 8, title: "x", body: "y", labels: [], state: "open" });
  // agent tries to relabel #999 while handling #8 -> the whole batch is refused, nothing executes
  const provider = new FakeProvider(actionsJson([{ kind: "relabel", num: 999, add: ["type:bug"], remove: [] }]));
  const out = await issueStep(ctxWith(gh, provider), 8);
  expect(out.kind).toBe("noop");
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).not.toContain("type:bug");
});

test("active issue: structured agent failure fails fast with diagnostics; no GitHub write", async () => {
  const gh = ghWith({ number: 9, title: "x", body: "y", labels: [], state: "open" });
  let recorded = 0;
  await expect(issueStep(ctxWith(gh, new FakeProvider({}), { recordFail: () => ++recorded }), 9))
    .rejects.toBeInstanceOf(StructuredAgentError);
  expect(recorded).toBe(0);
  expect(gh.panels[9]).toBeUndefined(); // no escalation yet
});

test("active issue: persistent structured output failure is not downgraded to a panel/noop", async () => {
  const gh = ghWith({ number: 10, title: "x", body: "y", labels: [], state: "open" });
  await expect(issueStep(ctxWith(gh, new FakeProvider({}), { recordFail: () => FAIL_THRESHOLD }), 10))
    .rejects.toBeInstanceOf(StructuredAgentError);
  expect(gh.panels[10]).toBeUndefined();
});

test("active issue: per-repo failThreshold does not swallow structured output failures", async () => {
  const gh = ghWith({ number: 11, title: "x", body: "y", labels: [], state: "open" });
  // default threshold is 3, so a single failure normally stays quiet; override to 1 -> escalate at once.
  const c: StepCtx = { ...ctxWith(gh, new FakeProvider({}), { recordFail: () => 1 }),
    repoPolicy: { agents: { maintainer: { failThreshold: 1 } } } };
  await expect(issueStep(c, 11)).rejects.toBeInstanceOf(StructuredAgentError);
  expect(gh.panels[11]).toBeUndefined();
});

// --- awaiting-gate: check the human signal; NEVER call the agent ---

async function awaitingGate(num: number, proposal: "close" | "merge", draft: string): Promise<FakeGitHub> {
  const gh = ghWith({ number: num, title: "x", body: "y", labels: [], state: "open" });
  await executeSafe(gh, "o/r", { kind: "propose", num, proposal, draft }); // sets approval comment + needs-approval
  return gh;
}

test("awaiting-gate + 👍 on a close proposal: shell executes doClose, never calls the agent", async () => {
  const gh = await awaitingGate(20, "close", "closing because X");
  gh.commentReactions["0"] = ["+1"];
  const provider = new FakeProvider(actionsJson([{ kind: "relabel", num: 20, add: ["z"], remove: [] }]));
  const out = await issueStep(ctxWith(gh, provider), 20);
  expect(out.kind).toBe("done");
  expect(provider.calls).toHaveLength(0);     // gate path must not call the agent
  expect(gh.closed).toContain(20);
  expect(gh.comments[20]).toContain("closing because X"); // doClose posts the draft as the reason
});

test("awaiting-gate + 👎: declined is stamped, needs-approval cleared, no agent call", async () => {
  const gh = await awaitingGate(21, "close", "closing because X");
  gh.commentReactions["0"] = ["-1"];
  const provider = new FakeProvider({});
  const out = await issueStep(ctxWith(gh, provider), 21);
  expect(out.kind).toBe("done");
  expect(provider.calls).toHaveLength(0);
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain(DECLINED);
  expect(i.labels).not.toContain(NEEDS_APPROVAL);
});

test("awaiting-gate + no reaction yet: waits on the human, no agent call, no close", async () => {
  const gh = await awaitingGate(22, "close", "closing because X");
  const provider = new FakeProvider({});
  const out = await issueStep(ctxWith(gh, provider), 22);
  expect(out.kind).toBe("waiting");
  expect((out as { on: string }).on).toBe("human");
  expect(provider.calls).toHaveLength(0);
  expect(gh.closed).not.toContain(22);
});

// --- active: implement is human-gated (#88) — opening the gate vs. running the patcher after 👍 is
//     covered by the "#88:" tests above. Here we only assert dry-run never touches the patcher. ---

test("dry-run: an implement action is previewed, NOT executed (the patcher never runs / pushes)", async () => {
  const gh = ghWith({ number: 70, title: "fix it", body: "broken", labels: [], state: "open" });
  const provider = new FakeProvider(actionsJson([{ kind: "implement", num: 70 }]));
  const c: StepCtx = { ...ctxWith(gh, provider), ws: new FakeWorkspace({ diff: "patch", tests: true }), dryRun: true };
  await issueStep(c, 70);
  expect((c.ws as FakeWorkspace).cloned).toHaveLength(0); // sandbox never cloned -> patcher skipped
  expect(gh.prs).toHaveLength(0);                          // no PR pushed/opened
});

test("active issue: the maintainer is told the state of monastery's open PR (so it won't re-implement)", async () => {
  const gh = ghWith({ number: 41, title: "x", body: "y", labels: [], state: "open" });
  await gh.openDraftPR("o/r", "feat/41-x", "t", "b"); // an open PR for this issue's branch
  const provider = new FakeProvider(actionsJson([]));
  await issueStep(ctxWith(gh, provider), 41);
  expect(provider.calls[0].context).toContain("feat/41-x");
  expect(provider.calls[0].context).toMatch(/state: open/);
});

// --- active: a single failing action must not crash the tick (CONSTITUTION §10: failure = noise) ---

test("active issue: one action that throws is isolated — later actions still run, no crash", async () => {
  const gh = ghWith({ number: 80, title: "x", body: "y", labels: [], state: "open" });
  // addLabel rejects for an undefined label (mirrors `gh --add-label` on a missing repo label)
  const orig = gh.addLabel.bind(gh);
  gh.addLabel = (r, n, label) => (label === "type:enhancement" ? Promise.reject(new Error("label not found")) : orig(r, n, label));
  const provider = new FakeProvider(actionsJson([
    { kind: "relabel", num: 80, add: ["type:enhancement"], remove: [] }, // this one fails
    { kind: "panel", num: 80, body: "status still posted" },             // this one must still run
  ]));
  const out = await issueStep(ctxWith(gh, provider), 80); // must NOT throw
  expect(out.kind).toBe("progressed");
  expect(gh.panels[80]).toContain("status still posted"); // later action executed despite the earlier failure
});

// --- active: consensus (P1) — current spec + endorsements + consensus state reach the agent ---

test("active issue: a spec + all parties' endorsements surface as 'consensus reached' to the maintainer", async () => {
  const gh = ghWith({ number: 60, title: "x", body: "y", labels: [], state: "open" });
  gh.authoredComments[60] = [
    { body: "<!--monastery-spec version=1 parties=a-bot,monastery-->\nthe agreed plan", author: "a-bot" },
    { body: "ok\n<!--monastery-endorse version=1-->", author: "a-bot" },
    { body: "ok\n<!--monastery-endorse version=1-->", author: "monastery" }, // selfLogin endorses
  ];
  const provider = new FakeProvider(actionsJson([]));
  await issueStep(ctxWith(gh, provider), 60);
  const ctx = provider.calls[0].context;
  expect(ctx).toContain("the agreed plan");
  expect(ctx).toMatch(/consensus[^\\n]*reached|reached.*true|达成/i);
});

// --- active: cross-repo read (P0) — the issue's upstream deps are fetched and handed to the agent ---

test("active issue: a `Depends-on:` ref is resolved and the dep's state reaches the maintainer", async () => {
  const gh = ghWith({ number: 50, title: "x", body: "needs upstream\nDepends-on: owner/other#42", labels: [], state: "open" });
  gh.externalIssues["owner/other#42"] = { number: 42, title: "upstream fix", body: "", labels: [], state: "closed" };
  const provider = new FakeProvider(actionsJson([]));
  await issueStep(ctxWith(gh, provider), 50);
  const ctx = provider.calls[0].context;
  expect(ctx).toContain("owner/other#42");
  expect(ctx).toContain("closed");          // A's agent can see the upstream is resolved
});

// --- terminal: ignore ---

test("declined issue is terminal: noop, agent never called", async () => {
  const gh = ghWith({ number: 30, title: "x", body: "y", labels: [NEEDS_APPROVAL, DECLINED], state: "open" });
  const provider = new FakeProvider(actionsJson([{ kind: "relabel", num: 30, add: ["z"], remove: [] }]));
  const out = await issueStep(ctxWith(gh, provider), 30);
  expect(out.kind).toBe("noop");
  expect(provider.calls).toHaveLength(0);
});

test("a closed / unknown issue is a noop", async () => {
  const gh = ghWith({ number: 31, title: "x", body: "y", labels: [], state: "open" });
  const out = await issueStep(ctxWith(gh, new FakeProvider({})), 404);
  expect(out.kind).toBe("noop");
});

// --- issue #82: issueStep attaches a derived backlog entry to its Outcome ---

test("active issue: outcome carries a derived entry (relabel → later)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  const provider = new FakeProvider(actionsJson([{ kind: "relabel", num: 1, add: ["type:bug"], remove: [] }]));
  const out = await issueStep(ctxWith(gh, provider), 1);
  expect(out.entry).toMatchObject({ number: 1, title: "x", priority: "later" });
});

test("active issue with no valid output: entry is later 'no valid output'", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  // actions targeting a different issue number triggers the "no valid output" branch
  const provider = new FakeProvider(actionsJson([{ kind: "relabel", num: 999, add: ["type:bug"], remove: [] }]));
  const out = await issueStep(ctxWith(gh, provider), 1);
  expect(out.entry).toMatchObject({ number: 1, priority: "later", rationale: "no valid output" });
});

test("awaiting-gate issue: entry is parked", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await executeSafe(gh, "o/r", { kind: "propose", num: 1, proposal: "close", draft: "because X" });
  const out = await issueStep(ctxWith(gh, new FakeProvider({})), 1);
  expect(out.entry).toMatchObject({ number: 1, priority: "parked", rationale: "awaiting human approval" });
});

test("awaiting-gate approved merge: still waits for the human to click Merge, entry stays parked", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await executeSafe(gh, "o/r", { kind: "propose", num: 1, proposal: "merge", draft: "ship it" });
  gh.commentReactions["0"] = ["+1"]; // approved, but a merge is finalized by the human on the PR
  const out = await issueStep(ctxWith(gh, new FakeProvider({})), 1);
  expect(out.kind).toBe("waiting");
  expect(out.entry).toMatchObject({ number: 1, priority: "parked" });
});

// --- #88: implement is human-gated — it opens an approval comment, the patcher runs only after 👍 ---

test("#88: implement opens an approval gate (approval comment + needs-approval), does NOT run the patcher", async () => {
  const gh = ghWith({ number: 50, title: "fix it", body: "broken", labels: [], state: "open" });
  const provider = new FakeProvider(actionsJson([{ kind: "implement", num: 50, draft: "## Plan: refactor X" }]));
  const out = await issueStep(ctxWith(gh, provider), 50);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(0);                        // patcher did NOT run — no code written
  expect(gh.comments[50][0]).toContain("action: implement");  // approval gate opened instead
  expect(gh.comments[50][0]).toContain("## Plan: refactor X");
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain(NEEDS_APPROVAL);
});

test("#88: the patcher runs only after a human 👍 on the implement approval comment", async () => {
  const gh = ghWith({ number: 51, title: "fix it", body: "broken", labels: [], state: "open" });
  await proposeGate(gh, "o/r", 51, "implement", "## Plan"); // gate already open (needs-approval + panel)
  gh.commentReactions["0"] = ["+1"];                // human endorsed
  const c: StepCtx = { ...ctxWith(gh, new FakeProvider({})), ws: new FakeWorkspace({ diff: "patch", tests: true }), review: async () => ({ findings: [] }) };
  const out = await issueStep(c, 51);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);                  // NOW the patcher ran -> draft PR
  expect(gh.prs[0].body).toContain("Closes #51");
});

test("#88: no 👍 on the implement panel → still waiting on the human, patcher does not run", async () => {
  const gh = ghWith({ number: 52, title: "fix it", body: "broken", labels: [], state: "open" });
  await proposeGate(gh, "o/r", 52, "implement", "## Plan");
  const out = await issueStep(ctxWith(gh, new FakeProvider({})), 52);
  expect(out.kind).toBe("waiting");
  expect(gh.prs).toHaveLength(0);                  // no endorsement -> no code
});

// --- #88 review fix: approved implement must consume the gate (clear needs-approval, rewrite panel) ---

test("#88: approved implement consumes the gate — clears needs-approval, rewrites panel, no re-run", async () => {
  const gh = ghWith({ number: 60, title: "fix it", body: "broken", labels: [], state: "open" });
  await proposeGate(gh, "o/r", 60, "implement", "## Plan");
  gh.commentReactions["0"] = ["+1"];
  const c: StepCtx = { ...ctxWith(gh, new FakeProvider({})), ws: new FakeWorkspace({ diff: "patch", tests: true }), review: async () => ({ findings: [] }) };
  const out1 = await issueStep(c, 60);
  expect(out1.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);                       // patcher ran, draft PR opened
  const [i1] = await gh.listOpenIssues("o/r", 0);
  expect(i1.labels).not.toContain(NEEDS_APPROVAL);      // gate consumed
  expect(gh.panels[60]).toContain("protocol: note");    // panel is now a plain note, not an approval gate
  expect(gh.panels[60]).not.toContain("action: implement");
  // next tick: issue is active again (no needs-approval); empty actions → no duplicate runImplement
  const c2 = { ...ctxWith(gh, new FakeProvider(actionsJson([]))), ws: new FakeWorkspace() };
  await issueStep(c2, 60);
  expect(gh.prs).toHaveLength(1);                        // still one PR — no re-run loop
});

// --- #88 review fix: stale-reaction guard — a 👍 from before the gate must not approve it ---

test("#88: a 👍 left on an older gate comment does NOT approve the latest implement gate", async () => {
  const gh = ghWith({ number: 80, title: "fix it", body: "broken", labels: [], state: "open" });
  await proposeGate(gh, "o/r", 80, "close", "old close gate");
  gh.commentReactions["0"] = ["+1"];                        // 👍 on the old gate comment
  await proposeGate(gh, "o/r", 80, "implement", "## Plan"); // latest gate is a fresh comment (id "1")
  const c: StepCtx = { ...ctxWith(gh, new FakeProvider({})), ws: new FakeWorkspace({ diff: "patch", tests: true }), review: async () => ({ findings: [] }) };
  const out = await issueStep(c, 80);
  expect(out.kind).toBe("waiting");        // old 👍 ignored — still awaiting a fresh endorsement
  expect(gh.prs).toHaveLength(0);          // patcher did NOT run
});

test("#88: a 👍 made AFTER the gate was opened approves it (fresh reaction)", async () => {
  const gh = ghWith({ number: 81, title: "fix it", body: "broken", labels: [], state: "open" });
  await proposeGate(gh, "o/r", 81, "implement", "## Plan"); // gate first
  gh.commentReactions["0"] = ["+1"];                // reaction on the latest gate comment
  const c: StepCtx = { ...ctxWith(gh, new FakeProvider({})), ws: new FakeWorkspace({ diff: "patch", tests: true }), review: async () => ({ findings: [] }) };
  const out = await issueStep(c, 81);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);
});
