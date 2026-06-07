// tests/issue-step.test.ts — v2 L_item: active -> maintainer -> executeSafe; awaiting-gate -> signal -> gated; terminal -> ignore.
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { issueStep, pendingApprovals, FAIL_THRESHOLD, type StepCtx } from "../src/engine/issue-step.js";
import { executeSafe, proposeGate, type Action } from "../src/shell/actions.js";
import { SPEC_MARKER } from "../src/shell/consensus.js";
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

test("#90: awaiting-gate issue is a HIGH-priority awaiting-approval entry, tagged with kind + comment id", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await executeSafe(gh, "o/r", { kind: "propose", num: 1, proposal: "close", draft: "because X" });
  const out = await issueStep(ctxWith(gh, new FakeProvider({})), 1);
  expect(out.entry).toMatchObject({ number: 1, priority: "now", awaitingApproval: true, approvalKind: "close" });
  expect(out.entry?.approvalCommentId).toBeDefined();           // for the direct 👍 link
  expect(out.entry?.rationale).toContain("👍");                  // not sunk to "parked"
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

// --- #90 review fix: pendingApprovals scans ALL open awaiting issues, live (not the batched snapshot) ---

test("#90: pendingApprovals lists open needs-approval issues with a gate, tagged with kind + comment id", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "await me", body: "y", labels: [], state: "open" },
    { number: 3, title: "no gate", body: "y", labels: ["monastery:needs-approval"], state: "open" }, // label, no panel
  ]});
  await proposeGate(gh, "o/r", 1, "implement", "## Plan");
  const items = await pendingApprovals(gh, "o/r");
  expect(items.map((i) => i.number)).toEqual([1]);              // #1 has a gate; #3 (no panel) excluded
  expect(items[0]).toMatchObject({ number: 1, title: "await me", approvalKind: "implement" });
  expect(items[0].approvalCommentId).toBeDefined();
});

test("#90: pendingApprovals excludes an issue whose gate is already 👍'd", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await proposeGate(gh, "o/r", 1, "implement", "## Plan");
  gh.commentReactions["0"] = ["+1"]; // the gate comment (fake: first own comment id "0") is approved
  expect(await pendingApprovals(gh, "o/r")).toEqual([]);
});

// --- #97: a parked gate responds to a NEW human comment — back to active (execution still reaction-gated) ---

test("#97: a new unanswered human comment under the gate sends it back to active (no agent call here)", async () => {
  const gh = ghWith({ number: 100, title: "x", body: "y", labels: [], state: "open" });
  await proposeGate(gh, "o/r", 100, "implement", "## Plan"); // gate = own comment id "0"
  gh.authoredComments[100] = [{ body: "wait, why ApiProvider here?", author: "xforce-io", updatedAt: 100 }]; // human, newer, unanswered
  const c = ctxWith(gh, new FakeProvider({}));
  const out = await issueStep(c, 100);
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).not.toContain(NEEDS_APPROVAL); // demoted → active next tick
  expect(i.labels).not.toContain(DECLINED);       // NOT terminal
  expect(gh.panels[100]).toContain("protocol: note");
  expect((c.provider as FakeProvider).calls).toHaveLength(0); // awaiting-gate never calls the agent itself
});

test("#97: a human comment OLDER than the gate does NOT invalidate it (termination guard)", async () => {
  const gh = ghWith({ number: 101, title: "x", body: "y", labels: [], state: "open" });
  gh.authoredComments[101] = [{ body: "earlier discussion", author: "xforce-io", updatedAt: 0 }]; // predates the gate
  await proposeGate(gh, "o/r", 101, "implement", "## Plan"); // gate posted after → newer than the comment
  const out = await issueStep(ctxWith(gh, new FakeProvider({})), 101);
  expect(out.kind).toBe("waiting");
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain(NEEDS_APPROVAL);
});

test("#97: a human comment the agent already replied to does NOT re-invalidate the gate", async () => {
  const gh = ghWith({ number: 102, title: "x", body: "y", labels: [], state: "open" });
  await proposeGate(gh, "o/r", 102, "implement", "## Plan");
  gh.authoredComments[102] = [{ body: "question?", author: "xforce-io", updatedAt: 100 }]; // id ext0, newer
  await gh.postComment("o/r", 102, "answer\n\n<!--monastery-reply to=ext0-->"); // already answered
  const out = await issueStep(ctxWith(gh, new FakeProvider({})), 102);
  expect(out.kind).toBe("waiting");
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain(NEEDS_APPROVAL);
});

test("#97: a monastery (marked) comment newer than the gate does NOT invalidate it (only human comments count)", async () => {
  const gh = ghWith({ number: 103, title: "x", body: "y", labels: [], state: "open" });
  await proposeGate(gh, "o/r", 103, "implement", "## Plan");
  await gh.postComment("o/r", 103, "<!--monastery-state\nprotocol: note\n-->\nmonastery's own note"); // marked, newer
  const out = await issueStep(ctxWith(gh, new FakeProvider({})), 103);
  expect(out.kind).toBe("waiting");
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain(NEEDS_APPROVAL);
});

test("#97: an approved gate (👍) is NOT intercepted by a later human comment — it still executes", async () => {
  const gh = ghWith({ number: 104, title: "fix", body: "y", labels: [], state: "open" });
  await proposeGate(gh, "o/r", 104, "implement", "## Plan");
  gh.commentReactions["0"] = ["+1"];
  gh.authoredComments[104] = [{ body: "late question", author: "xforce-io", updatedAt: 100 }]; // newer, unanswered
  const c: StepCtx = { ...ctxWith(gh, new FakeProvider({})), ws: new FakeWorkspace({ diff: "patch", tests: true }), review: async () => ({ findings: [] }) };
  const out = await issueStep(c, 104);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1); // 👍 honored; the later comment did not block execution
});

// --- #97 validation: replay issue #91's REAL state — the human's last comment must re-open the gate ---
// Mirrors github.com/xforce-io/monastery/issues/91 at validation time: an endorsed spec v1, an implement
// gate stamped at v1 (so #95 staleness is NEUTRAL — isolating #97), then the maintainer's real last human
// comment landing AFTER the gate. The whole point of #97: that comment alone re-opens the design.
const ISSUE_91_LAST_HUMAN_COMMENT = "ApiProvider 配置在哪里进行，如果没有配置，fallback 逻辑是什么";

function mirror91(withLastHumanComment: boolean): FakeGitHub {
  const gh = ghWith({ number: 91, title: "Judgment agents structured output", body: "…", labels: [], state: "open" });
  // spec v1 (monastery-marked, older). proposeGate below will stamp the gate at this version.
  gh.authoredComments[91] = [
    { body: `${SPEC_MARKER(1, ["xforce-io"])}\nSpec v1 — Structured Output via API`, author: "xforce-io", updatedAt: 1 },
  ];
  return gh;
}

test("#97 validation (issue #91): the maintainer's real last human comment re-opens the parked gate", async () => {
  const gh = mirror91(true);
  await proposeGate(gh, "o/r", 91, "implement", "## 实现计划 — ApiProvider"); // gate stamped at spec v1 → #95 neutral
  // the real last human comment on #91, landing after the gate, unanswered:
  gh.authoredComments[91].push({ body: ISSUE_91_LAST_HUMAN_COMMENT, author: "xforce-io", updatedAt: 100 });
  const c = ctxWith(gh, new FakeProvider({}));
  const out = await issueStep(c, 91);
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).not.toContain(NEEDS_APPROVAL);            // gate re-opened → active next tick
  expect(i.labels).not.toContain(DECLINED);                  // not killed
  expect(gh.panels[91]).toContain("protocol: note");         // panel rewritten to a note
  expect(gh.prs).toHaveLength(0);                            // execution NOT triggered (still reaction-gated)
  expect((c.provider as FakeProvider).calls).toHaveLength(0); // gate branch itself never runs the agent
});

test("#97 validation (issue #91): WITHOUT that last human comment, the same gate stays parked (it's the comment that did it)", async () => {
  const gh = mirror91(false);
  await proposeGate(gh, "o/r", 91, "implement", "## 实现计划 — ApiProvider"); // same gate, no new human comment
  const out = await issueStep(ctxWith(gh, new FakeProvider({})), 91);
  expect(out.kind).toBe("waiting");                          // nothing new → still waiting on the human
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain(NEEDS_APPROVAL);
});

// --- #95: approval-gate staleness — a newer spec / a 👀 reaction invalidates a parked implement gate ---

test("#95: proposeGate stamps the current spec version into the implement gate marker", async () => {
  const gh = ghWith({ number: 93, title: "fix", body: "y", labels: [], state: "open" });
  gh.authoredComments[93] = [{ body: `${SPEC_MARKER(3, ["x"])}\nthe plan`, author: "x" }];
  await proposeGate(gh, "o/r", 93, "implement", "## Plan");
  expect(gh.comments[93][0]).toMatch(/^spec:\s*3$/m);
});

test("#95: a spec newer than the implement gate invalidates it — strips needs-approval, won't run the patcher, no agent call", async () => {
  const gh = ghWith({ number: 90, title: "fix", body: "y", labels: [], state: "open" });
  gh.authoredComments[90] = [{ body: `${SPEC_MARKER(1, ["xforce-io"])}\nv1 plan`, author: "xforce-io" }];
  await proposeGate(gh, "o/r", 90, "implement", "## Plan v1"); // gate stamped at spec 1
  gh.authoredComments[90].push({ body: `${SPEC_MARKER(2, ["xforce-io"])}\nv2 plan`, author: "xforce-io" }); // newer spec lands under the gate
  gh.commentReactions["0"] = ["+1"]; // even with a 👍, the stale gate must NOT approve
  const c: StepCtx = { ...ctxWith(gh, new FakeProvider({})), ws: new FakeWorkspace({ diff: "patch", tests: true }), review: async () => ({ findings: [] }) };
  const out = await issueStep(c, 90);
  expect(gh.prs).toHaveLength(0);                       // stale → patcher did NOT run
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).not.toContain(NEEDS_APPROVAL);       // gate invalidated → active again next tick
  expect(i.labels).not.toContain(DECLINED);             // not terminal
  expect(gh.panels[90]).toContain("protocol: note");    // panel rewritten to a plain note
  expect((c.provider as FakeProvider).calls).toHaveLength(0); // awaiting-gate never calls the agent
});

test("#95: an implement gate AT the current spec version is not stale — a fresh 👍 still runs the patcher", async () => {
  const gh = ghWith({ number: 91, title: "fix", body: "y", labels: [], state: "open" });
  gh.authoredComments[91] = [{ body: `${SPEC_MARKER(2, ["xforce-io"])}\nv2 plan`, author: "xforce-io" }];
  await proposeGate(gh, "o/r", 91, "implement", "## Plan"); // stamped at spec 2 (the current version)
  gh.commentReactions["0"] = ["+1"];
  const c: StepCtx = { ...ctxWith(gh, new FakeProvider({})), ws: new FakeWorkspace({ diff: "patch", tests: true }), review: async () => ({ findings: [] }) };
  const out = await issueStep(c, 91);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);                        // not stale → patcher ran
});

test("#95: a plain prose comment under the gate does NOT invalidate it — only a newer spec / 👀 does (守 #92)", async () => {
  const gh = ghWith({ number: 94, title: "fix", body: "y", labels: [], state: "open" });
  gh.authoredComments[94] = [{ body: `${SPEC_MARKER(1, ["xforce-io"])}\nv1 plan`, author: "xforce-io" }];
  await proposeGate(gh, "o/r", 94, "implement", "## Plan"); // stamped at spec 1
  gh.authoredComments[94].push({ body: "I disagree, please use pi-ai instead", author: "xforce-io" }); // prose, no new spec
  const out = await issueStep(ctxWith(gh, new FakeProvider({})), 94);
  expect(out.kind).toBe("waiting");                  // gate intact — prose alone is not a control signal
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain(NEEDS_APPROVAL);
});

test("#95: a 👀 on the gate sends it back to active (non-terminal) — strips needs-approval, not declined, no agent call", async () => {
  const gh = ghWith({ number: 92, title: "fix", body: "y", labels: [], state: "open" });
  await proposeGate(gh, "o/r", 92, "implement", "## Plan");
  gh.commentReactions["0"] = ["eyes"]; // human asks to reconsider
  const c = ctxWith(gh, new FakeProvider({}));
  const out = await issueStep(c, 92);
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).not.toContain(NEEDS_APPROVAL); // back to active
  expect(i.labels).not.toContain(DECLINED);       // NOT terminal (unlike 👎)
  expect(gh.prs).toHaveLength(0);                  // patcher never ran
  expect(gh.panels[92]).toContain("protocol: note");
  expect((c.provider as FakeProvider).calls).toHaveLength(0);
});
