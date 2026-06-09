// tests/reconcile.test.ts — v2 L_repo: classify open items into active / awaiting-gate / terminal (PROTOCOL §6).
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { reconcile, MAX_ITEMS_PER_TICK } from "../src/engine/reconcile.js";
import { branchName } from "../src/engine/patch.js";
import { executeSafe, proposeGate } from "../src/shell/actions.js";
import type { AgentConfig, AgentProvider, AgentResult } from "../src/provider/interface.js";

// #108: the maintainer's cwd is a shared read-only repo checkout, so the issue number comes from the
// prompt context (how the real agent knows which item it is), not from the artifact dir.
const numFromContext = (ctx: string) => Number(ctx.match(/<issue number="(\d+)"/)?.[1]);

/** A maintainer stub that relabels whichever issue it is handed (num derived from the prompt context). */
class RelabelEachProvider implements AgentProvider {
  public calls: AgentConfig[] = [];
  async run(config: AgentConfig): Promise<AgentResult> {
    this.calls.push(config);
    const num = numFromContext(config.context);
    mkdirSync(config.artifactDir, { recursive: true });
    writeFileSync(join(config.artifactDir, "actions.json"), JSON.stringify({ actions: [{ kind: "relabel", num, add: ["x"], remove: [] }] }));
    return { artifacts: [] };
  }
}

const baseCtx = (gh: FakeGitHub, provider: AgentProvider) => ({
  repo: "o/r", gh, provider, model: "sonnet", artifactRoot: mkdtempSync(join(tmpdir(), "monastery-rec-")),
  fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
  ws: new FakeWorkspace(),
  now: () => 0,
});
// a provider whose maintainer output relabels issue #n (so the active item "progresses")
const relabel = (n: number) => new FakeProvider({ "actions.json": JSON.stringify({ actions: [{ kind: "relabel", num: n, add: ["type:bug"], remove: [] }] }) });

test("active issues are stepped (agent called) and counted as advanced", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "a", body: "b", labels: [], state: "open" }] });
  const provider = relabel(1);
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(1);
  expect(provider.calls.length).toBe(1);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("caps work per tick at MAX_ITEMS_PER_TICK", async () => {
  const issues = Array.from({ length: MAX_ITEMS_PER_TICK + 5 }, (_, k) => ({
    number: k + 1, title: "t", body: "b", labels: [], state: "open" as const,
  }));
  const gh = new FakeGitHub({ thesis: "T", issues });
  // every active item proposes a relabel of itself -> all batched items advance; the cap bounds the batch
  const provider = new RelabelEachProvider();
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(MAX_ITEMS_PER_TICK);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("awaiting-gate with no signal: idle, waiting:human, long backoff, agent NOT called", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await executeSafe(gh, "o/r", { kind: "propose", num: 1, proposal: "close", draft: "because X" }); // -> needs-approval + panel
  const provider = new FakeProvider({});
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(0);
  expect(provider.calls.length).toBe(0);                     // gate item: no agent
  expect(r.waiting.find((w) => w.on === "human")?.count).toBe(1);
  expect(r.idle).toBe(true);
  expect(r.nextPollMs).toBeGreaterThanOrEqual(3600_000);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("awaiting-gate with 👍 advances via doClose (no agent), then leaves the open list", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await executeSafe(gh, "o/r", { kind: "propose", num: 1, proposal: "close", draft: "because X" });
  gh.commentReactions["0"] = ["+1"];
  const provider = new FakeProvider({});
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(1);
  expect(provider.calls.length).toBe(0);
  expect(gh.closed).toContain(1);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("declined is terminal: not stepped, not counted as waiting:human, agent NOT called", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "x", body: "y", labels: ["monastery:needs-approval", "monastery:declined"], state: "open" },
  ]});
  const provider = new FakeProvider({});
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(0);
  expect(provider.calls.length).toBe(0);
  expect(r.waiting.find((w) => w.on === "human")).toBeUndefined();
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

import type { BacklogSnapshot } from "../src/types.js";

// provider returning a chosen action set per issue number (derived from the prompt context, #108)
class PerIssueProvider implements AgentProvider {
  public calls: AgentConfig[] = [];
  constructor(private byNum: Record<number, object[]>) {}
  async run(config: AgentConfig): Promise<AgentResult> {
    this.calls.push(config);
    const num = numFromContext(config.context);
    mkdirSync(config.artifactDir, { recursive: true });
    writeFileSync(join(config.artifactDir, "actions.json"), JSON.stringify({ actions: this.byNum[num] ?? [] }));
    return { artifacts: [] };
  }
}

test("writes a sorted backlog snapshot through ctx.backlog", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "a", body: "b", labels: [], state: "open" },  // relabel -> later
    { number: 2, title: "c", body: "d", labels: [], state: "open" },  // panel   -> soon
  ]});
  const provider = new PerIssueProvider({
    1: [{ kind: "relabel", num: 1, add: ["type:bug"], remove: [] }],
    2: [{ kind: "panel", num: 2, body: "status" }],
  });
  const written: BacklogSnapshot[] = [];
  const c = { ...baseCtx(gh, provider), backlog: { writeBacklog: (_r: string, s: BacklogSnapshot) => { written.push(s); } } };
  await reconcile(c);
  expect(written.length).toBe(1);
  expect(written[0].entries.map((e) => e.number)).toEqual([2, 1]); // soon(#2) before later(#1)
  expect(written[0].rankedOf).toEqual({ ranked: 2, open: 2 });
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("dry-run does NOT write the backlog", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "a", body: "b", labels: [], state: "open" }] });
  const written: BacklogSnapshot[] = [];
  const c = { ...baseCtx(gh, relabel(1)), dryRun: true, backlog: { writeBacklog: (_r: string, s: BacklogSnapshot) => { written.push(s); } } };
  await reconcile(c);
  expect(written.length).toBe(0);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("#108 clones the repo read-only ONCE per tick, runs the maintainer in it, then cleans up", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "a", body: "b", labels: [], state: "open" },
    { number: 2, title: "c", body: "d", labels: [], state: "open" },
  ]});
  const provider = new RelabelEachProvider();
  const ws = new FakeWorkspace();
  const c = { ...baseCtx(gh, provider), ws };
  await reconcile(c);
  expect(ws.clonedReadOnly).toHaveLength(1);                              // ONE shared checkout for the whole batch
  const roDir = ws.clonedReadOnly[0].dir;
  expect(provider.calls.map((x) => x.artifactDir)).toEqual([roDir, roDir]); // maintainer cwd = the read-only checkout
  expect(ws.cleaned).toContain(roDir);                                    // checkout removed after the tick
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

// --- #86: at most one implement (runImplement / patcher) per tick, chosen by backlog priority ---

import type { BacklogSnapshot as Snap } from "../src/types.js";

/** Two issues, each with a human-approved (👍) implement gate. Both are "ready" to runImplement. */
async function twoApprovedImplements(): Promise<FakeGitHub> {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "fix a", body: "broken a", labels: [], state: "open" },
    { number: 2, title: "fix b", body: "broken b", labels: [], state: "open" },
  ]});
  await proposeGate(gh, "o/r", 1, "implement", "## Plan A"); // gate comment id "0"
  await proposeGate(gh, "o/r", 2, "implement", "## Plan B"); // gate comment id "1"
  gh.commentReactions["0"] = ["+1"];
  gh.commentReactions["1"] = ["+1"];
  return gh;
}

function implCtx(gh: FakeGitHub, written?: Snap[]) {
  return {
    ...baseCtx(gh, new FakeProvider({ "actions.json": JSON.stringify({ actions: [] }) })),
    ws: new FakeWorkspace({ diff: "patch", tests: true }),
    review: async () => ({ findings: [] }),
    ...(written ? { backlog: { writeBacklog: (_r: string, s: Snap) => { written.push(s); } } } : {}),
  };
}

test("#86 two approved implements in one tick → only ONE PR opens; the other defers (gate intact)", async () => {
  const gh = await twoApprovedImplements();
  const written: Snap[] = [];
  const c = implCtx(gh, written);
  await reconcile(c);
  expect(gh.prs).toHaveLength(1);                              // exactly one heavy runImplement this tick
  expect(gh.prs[0].body).toContain("Closes #1");              // backlog tiebreak: lower number wins
  const [i1, i2] = await gh.listOpenIssues("o/r", 0);
  expect(i1.labels).not.toContain("monastery:needs-approval"); // winner's gate consumed
  expect(i2.labels).toContain("monastery:needs-approval");     // deferred candidate's gate untouched
  // backlog reflects executed vs deferred
  const entries = written[0].entries;
  expect(entries.find((e) => e.number === 1)?.rationale).toMatch(/executed/i);
  expect(entries.find((e) => e.number === 2)?.rationale).toMatch(/defer/i);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("#86 a deferred implement runs on the NEXT tick (not lost)", async () => {
  const gh = await twoApprovedImplements();
  const c1 = implCtx(gh);
  await reconcile(c1);                                         // tick 1: #1 runs, #2 deferred
  expect(gh.prs).toHaveLength(1);
  rmSync(c1.artifactRoot, { recursive: true, force: true });
  const c2 = implCtx(gh);
  await reconcile(c2);                                         // tick 2: #2 (still approved) now runs
  expect(gh.prs).toHaveLength(2);
  expect(gh.prs.some((p) => p.body.includes("Closes #2"))).toBe(true);
  rmSync(c2.artifactRoot, { recursive: true, force: true });
});

test("#86 lightweight actions are NOT limited by the implement budget", async () => {
  // two approved implements + one active issue whose maintainer relabels it (lightweight)
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "fix a", body: "broken a", labels: [], state: "open" },
    { number: 2, title: "fix b", body: "broken b", labels: [], state: "open" },
    { number: 3, title: "light", body: "z", labels: [], state: "open" },
  ]});
  await proposeGate(gh, "o/r", 1, "implement", "## Plan A"); // comment "0"
  await proposeGate(gh, "o/r", 2, "implement", "## Plan B"); // comment "1"
  gh.commentReactions["0"] = ["+1"];
  gh.commentReactions["1"] = ["+1"];
  const provider = new PerIssueProvider({ 3: [{ kind: "relabel", num: 3, add: ["type:bug"], remove: [] }] });
  const c = { ...baseCtx(gh, provider), ws: new FakeWorkspace({ diff: "patch", tests: true }), review: async () => ({ findings: [] }) };
  await reconcile(c);
  expect(gh.prs).toHaveLength(1);                              // still only one heavy implement
  const i3 = (await gh.listOpenIssues("o/r", 0)).find((i) => i.number === 3)!;
  expect(i3.labels).toContain("type:bug");                    // lightweight relabel ran regardless
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("#79+#86 implement and rework compete for the SAME one-heavy-per-tick slot", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "impl me", body: "b", labels: [], state: "open" },
    { number: 2, title: "rework me", body: "b", labels: [], state: "open" },
  ]});
  await proposeGate(gh, "o/r", 1, "implement", "## impl");            // gate comment "0"
  const b2 = branchName(2, "rework me");
  gh.prStates[b2] = "open";
  gh.prDetailsByBranch[b2] = { number: 8, url: "u/8", title: "t", body: "b", isDraft: true };
  gh.prCommentsByPr[8] = [{ id: "f", body: "tweak it", author: "alice" }];
  await proposeGate(gh, "o/r", 2, "rework", "## rework");            // gate comment "1"
  gh.commentReactions["0"] = ["+1"];
  gh.commentReactions["1"] = ["+1"];
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const c = { ...baseCtx(gh, new FakeProvider({})), ws, review: async () => ({ findings: [] }) };
  await reconcile(c);
  // exactly ONE heavy executor ran: a new PR (implement) OR a branch checkout (rework), never both.
  expect(gh.prs.length + ws.checkedOut.length).toBe(1);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("#108 a tick with only awaiting-gate items does not clone (no agent runs)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await executeSafe(gh, "o/r", { kind: "propose", num: 1, proposal: "close", draft: "x" }); // -> needs-approval
  const ws = new FakeWorkspace();
  const c = { ...baseCtx(gh, new FakeProvider({})), ws };
  await reconcile(c);
  expect(ws.clonedReadOnly).toHaveLength(0);                             // nothing active -> no code checkout
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

// --- #121: a tick lists open issues ONCE; per-item steps reuse the threaded set ---

/** Counts listOpenIssues calls to prove the open set is threaded down, not re-fetched per item (#121). */
class CountingGitHub extends FakeGitHub {
  public listCalls = 0;
  async listOpenIssues(repo?: string, since?: number) { this.listCalls++; return super.listOpenIssues(repo, since); }
}

test("#121 a tick calls listOpenIssues exactly once — issueStep & context reuse the threaded open set", async () => {
  // Two active issues. Without threading: 1 (reconcile) + 2 (issueStep find) + 2 (context backlog) = 5 calls.
  const gh = new CountingGitHub({ thesis: "T", issues: [
    { number: 1, title: "a", body: "b", labels: [], state: "open" },
    { number: 2, title: "c", body: "d", labels: [], state: "open" },
  ]});
  const provider = new RelabelEachProvider();
  const c = baseCtx(gh, provider);
  await reconcile(c);
  expect(provider.calls.length).toBe(2);   // both active items were stepped (maintainer ran)
  expect(gh.listCalls).toBe(1);            // ...yet open was listed only once for the whole tick
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("#125 a safe-action failure is counted as failed while the tick continues", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "bad", body: "b", labels: [], state: "open" },
    { number: 2, title: "good", body: "b", labels: [], state: "open" },
  ]});
  const addLabel = gh.addLabel.bind(gh);
  gh.addLabel = (repo, num, label) => label === "missing"
    ? Promise.reject(new Error("label not found"))
    : addLabel(repo, num, label);
  const provider = new PerIssueProvider({
    1: [{ kind: "relabel", num: 1, add: ["missing"], remove: [] }],
    2: [{ kind: "relabel", num: 2, add: ["type:bug"], remove: [] }],
  });
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  const i2 = await gh.getIssue("o/r", 2);
  expect(r.failed).toBe(1);
  expect(r.advanced).toBe(1);
  expect(i2?.labels).toContain("type:bug");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
