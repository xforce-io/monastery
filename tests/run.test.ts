// tests/run.test.ts
import { describe, it, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryStatus, groupByStatus, run } from "../src/engine/run.js";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { executeSafe, proposeGate } from "../src/shell/actions.js";
import type { AgentProvider } from "../src/provider/interface.js";
import type { BacklogEntry, Issue } from "../src/types.js";

function entry(over: Partial<BacklogEntry> = {}): BacklogEntry {
  return { number: 1, title: "t", priority: "now", rationale: "r", ...over };
}

const baseCtx = (gh: FakeGitHub, provider: AgentProvider) => ({
  repo: "o/r", gh, provider, model: "sonnet", artifactRoot: mkdtempSync(join(tmpdir(), "monastery-run-")),
  fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
  ws: new FakeWorkspace(),
  now: () => 0,
});

describe("entryStatus — #176: the status-bearing list classifies each entry", () => {
  it("is 'ready' when not awaiting approval and not blocked", () => {
    expect(entryStatus(entry())).toBe("ready");
  });

  it("is 'pending' when awaiting the human's 👍", () => {
    expect(entryStatus(entry({ awaitingApproval: true }))).toBe("pending");
  });

  it("is 'blocked' when blocked by an open dependency", () => {
    expect(entryStatus(entry({ blockedBy: ["o/r#2"] }))).toBe("blocked");
  });

  it("prefers 'pending' over 'blocked' — the human's 👍 is the actionable signal", () => {
    expect(entryStatus(entry({ awaitingApproval: true, blockedBy: ["o/r#2"] }))).toBe("pending");
  });
});

describe("groupByStatus — #176: the classification shared by status/pending/blocked views", () => {
  it("partitions entries by status, preserving input order within each group", () => {
    const entries = [
      entry({ number: 1 }),                              // ready
      entry({ number: 2, awaitingApproval: true }),      // pending
      entry({ number: 3, blockedBy: ["o/r#9"] }),        // blocked
      entry({ number: 4 }),                              // ready
      entry({ number: 5, awaitingApproval: true }),      // pending
    ];
    const g = groupByStatus(entries);
    expect(g.ready.map((e) => e.number)).toEqual([1, 4]);
    expect(g.pending.map((e) => e.number)).toEqual([2, 5]);
    expect(g.blocked.map((e) => e.number)).toEqual([3]);
  });

  it("returns empty groups for an empty list", () => {
    const g = groupByStatus([]);
    expect(g).toEqual({ ready: [], pending: [], blocked: [] });
  });
});

describe("run — #176: executes only human-approved gated items, never assesses", () => {
  test("no-op when nothing is awaiting approval (run never invokes the assessor)", async () => {
    const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "a", body: "b", labels: [], state: "open" }] });
    const provider = new FakeProvider({ "actions.json": JSON.stringify({ actions: [] }) });
    const c = baseCtx(gh, provider);
    const r = await run(c);
    expect(r.advanced).toBe(0);
    expect(r.idle).toBe(true);
    expect((provider as FakeProvider).calls.length).toBe(0);
    rmSync(c.artifactRoot, { recursive: true, force: true });
  });

  test("executes an approved (👍) close gate — advances, closes, never calls the assessor", async () => {
    const issue: Issue = { number: 20, title: "x", body: "y", labels: [], state: "open" };
    const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
    await executeSafe(gh, "o/r", { kind: "propose", num: 20, proposal: "close", draft: "closing because X" });
    gh.commentReactions["0"] = ["+1"]; // human approves the gate
    const provider = new FakeProvider({});
    const c = baseCtx(gh, provider);
    const r = await run(c);
    expect(r.advanced).toBe(1);
    expect(gh.closed).toContain(20);
    expect((provider as FakeProvider).calls.length).toBe(0);
    rmSync(c.artifactRoot, { recursive: true, force: true });
  });

  test("two approved (👍) implements in one run → exactly ONE PR opens, the other defers (one heavy slot)", async () => {
    const gh = new FakeGitHub({ thesis: "T", issues: [
      { number: 1, title: "fix a", body: "broken a", labels: [], state: "open" },
      { number: 2, title: "fix b", body: "broken b", labels: [], state: "open" },
    ]});
    await proposeGate(gh, "o/r", 1, "implement", "## Plan A");
    await proposeGate(gh, "o/r", 2, "implement", "## Plan B");
    gh.commentReactions["0"] = ["+1"];
    gh.commentReactions["1"] = ["+1"];
    const c = {
      ...baseCtx(gh, new FakeProvider({ "actions.json": JSON.stringify({ actions: [] }) })),
      ws: new FakeWorkspace({ diff: "patch", tests: true }),
      review: async () => ({ findings: [] }),
    };
    const r = await run(c);
    expect(gh.prs).toHaveLength(1);                                 // exactly one heavy runImplement
    expect(r.advanced).toBe(1);
    const [i1, i2] = await gh.listOpenIssues("o/r", 0);
    expect(i1.labels).not.toContain("monastery:needs-approval");   // winner's gate consumed
    expect(i2.labels).toContain("monastery:needs-approval");       // deferred candidate untouched
    rmSync(c.artifactRoot, { recursive: true, force: true });
  });
});
