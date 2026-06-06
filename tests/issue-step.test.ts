// tests/issue-step.test.ts — v2 L_item: active -> maintainer -> executeSafe; awaiting-gate -> signal -> gated; terminal -> ignore.
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { issueStep, FAIL_THRESHOLD, type StepCtx } from "../src/engine/issue-step.js";
import { executeSafe, type Action } from "../src/shell/actions.js";
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

test("active issue: a propose(close) action moves the item to awaiting-gate (panel + needs-approval)", async () => {
  const gh = ghWith({ number: 6, title: "x", body: "y", labels: [], state: "open" });
  const provider = new FakeProvider(actionsJson([{ kind: "propose", num: 6, proposal: "close", draft: "out of scope" }]));
  await issueStep(ctxWith(gh, provider), 6);
  expect(gh.panels[6]).toContain("action: close");
  expect(gh.panels[6]).toContain("out of scope");
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

test("active issue: agent failure (no output) is a transient skip below threshold; no GitHub write", async () => {
  const gh = ghWith({ number: 9, title: "x", body: "y", labels: [], state: "open" });
  let recorded = 0;
  const out = await issueStep(ctxWith(gh, new FakeProvider({}), { recordFail: () => ++recorded }), 9);
  expect(out.kind).toBe("noop");
  expect(recorded).toBe(1);
  expect(gh.panels[9]).toBeUndefined(); // no escalation yet
});

test("active issue: persistent agent failure escalates to a human-visible panel", async () => {
  const gh = ghWith({ number: 10, title: "x", body: "y", labels: [], state: "open" });
  const out = await issueStep(ctxWith(gh, new FakeProvider({}), { recordFail: () => FAIL_THRESHOLD }), 10);
  expect(out.kind).toBe("noop");
  expect(gh.panels[10]).toMatch(/human/i);
});

// --- awaiting-gate: check the human signal; NEVER call the agent ---

async function awaitingGate(num: number, proposal: "close" | "merge", draft: string): Promise<FakeGitHub> {
  const gh = ghWith({ number: num, title: "x", body: "y", labels: [], state: "open" });
  await executeSafe(gh, "o/r", { kind: "propose", num, proposal, draft }); // sets panel + needs-approval
  return gh;
}

test("awaiting-gate + 👍 on a close proposal: shell executes doClose, never calls the agent", async () => {
  const gh = await awaitingGate(20, "close", "closing because X");
  gh.commentReactions["panel:20"] = ["+1"];
  const provider = new FakeProvider(actionsJson([{ kind: "relabel", num: 20, add: ["z"], remove: [] }]));
  const out = await issueStep(ctxWith(gh, provider), 20);
  expect(out.kind).toBe("done");
  expect(provider.calls).toHaveLength(0);     // gate path must not call the agent
  expect(gh.closed).toContain(20);
  expect(gh.comments[20]?.[0]).toBe("closing because X"); // doClose posts the draft as the reason
});

test("awaiting-gate + 👎: declined is stamped, needs-approval cleared, no agent call", async () => {
  const gh = await awaitingGate(21, "close", "closing because X");
  gh.commentReactions["panel:21"] = ["-1"];
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
  expect(out).toEqual({ kind: "waiting", on: "human" });
  expect(provider.calls).toHaveLength(0);
  expect(gh.closed).not.toContain(22);
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
