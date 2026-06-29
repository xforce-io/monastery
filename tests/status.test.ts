// tests/status.test.ts
import { expect, test } from "vitest";
import { formatStatus, toStatusEntry, protocolState, explainOutcome, humanizeElapsed } from "../src/cli/status.js";
import type { Issue } from "../src/types.js";

const issues: Issue[] = [
  { number: 1, title: "Fix login bug", body: "", labels: ["thesis:in", "type:bug", "monastery:needs-approval"], state: "open" },
  { number: 2, title: "Add dark mode", body: "", labels: ["thesis:unclear", "type:feature", "monastery:declined"], state: "open" },
  { number: 3, title: "How to deploy?", body: "", labels: [], state: "open" },
];

test("protocolState: needs-approval -> awaiting-gate, declined/closed -> terminal, else active", () => {
  expect(protocolState(issues[0])).toBe("awaiting-gate");
  expect(protocolState(issues[1])).toBe("terminal");           // declined
  expect(protocolState(issues[2])).toBe("active");
  expect(protocolState({ ...issues[2], state: "closed" })).toBe("terminal");
});

test("toStatusEntry derives the protocol state + display fields", () => {
  expect(toStatusEntry("o/r", issues[0])).toEqual({
    repo: "o/r", number: 1, title: "Fix login bug", state: "awaiting-gate", thesis: "in", type: "bug",
  });
});

test("toStatusEntry defaults to active when no control label is present", () => {
  expect(toStatusEntry("o/r", issues[2])).toEqual({
    repo: "o/r", number: 3, title: "How to deploy?", state: "active", thesis: undefined, type: undefined,
  });
});

test("formatStatus prefixes each line with owner/repo#num so multi-repo entries are unique", () => {
  const out = formatStatus([toStatusEntry("o/a", issues[0]), toStatusEntry("o/b", issues[0])]);
  const lines = out.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("o/a#1");
  expect(lines[1]).toContain("o/b#1");
  expect(lines[0]).toContain("Fix login bug");
  expect(lines[0]).toContain("awaiting-gate");
  expect(lines[0]).toContain("thesis:in");
  expect(lines[0]).toContain("type:bug");
});

test("formatStatus shows 'active' state for an unlabelled issue and omits thesis/type", () => {
  const out = formatStatus([toStatusEntry("o/r", issues[2])]);
  expect(out).toContain("o/r#3");
  expect(out).toContain("How to deploy?");
  expect(out).toContain("active");
  expect(out).not.toContain("thesis:");
  expect(out).not.toContain("type:");
});

// --- #88: human-readable explanation for a single-issue step outcome ---

test("explainOutcome: each outcome gets a human-readable line; awaiting-👍 is explicit", () => {
  expect(explainOutcome({ kind: "progressed" })).toBe("progressed");
  expect(explainOutcome({ kind: "progressed", note: "PR #9" })).toContain("PR #9");
  expect(explainOutcome({ kind: "waiting", on: "human" })).toContain("👍");
  expect(explainOutcome({ kind: "waiting", on: "ci" })).toContain("ci");
  expect(explainOutcome({ kind: "done" })).toContain("terminal");
  expect(explainOutcome({ kind: "failed", error: "label not found" })).toContain("label not found");
  expect(explainOutcome({ kind: "noop" })).toBe("nothing to do this tick");
  expect(explainOutcome({
    kind: "noop",
    entry: { number: 1, title: "x", priority: "parked", rationale: "awaiting human approval" },
  })).toContain("👍"); // parked = waiting on your endorsement
  expect(explainOutcome({
    kind: "noop",
    entry: { number: 1, title: "x", priority: "later", rationale: "no valid output" },
  })).toContain("no valid output");
});

// #75 — phase progress overlay on status
import { enrichWithProgress, type ProgressSnapshot } from "../src/cli/status.js";

const baseEntry = { repo: "o/r", number: 73, title: "t", state: "active" as const, thesis: undefined, type: undefined };

test("enrichWithProgress attaches phase/attempt/elapsed for the matching live issue", () => {
  const snap: ProgressSnapshot = { issue: 73, phase: "review", status: "start", since: 1000, pid: 999, attempt: "2/3" };
  const out = enrichWithProgress(baseEntry, snap, { now: 253000, alive: true });
  expect(out.progress).toMatchObject({ phase: "review", attempt: "2/3", elapsedMs: 252000, stale: false });
});

test("enrichWithProgress ignores a snapshot for a different issue", () => {
  const snap: ProgressSnapshot = { issue: 99, phase: "patch", status: "start", since: 0, pid: 999 };
  expect(enrichWithProgress(baseEntry, snap, { now: 1000, alive: true }).progress).toBeUndefined();
});

test("enrichWithProgress is a no-op when there is no snapshot", () => {
  expect(enrichWithProgress(baseEntry, null, { now: 1000, alive: true }).progress).toBeUndefined();
});

test("dead pid marks progress stale; a fail snapshot carries the reason (tombstone)", () => {
  const snap: ProgressSnapshot = { issue: 73, phase: "patch", status: "fail", since: 0, pid: 999, reason: "timeout" };
  const out = enrichWithProgress(baseEntry, snap, { now: 5000, alive: false });
  expect(out.progress).toMatchObject({ phase: "patch", stale: true, reason: "timeout" });
});

test("formatStatus appends live phase progress with humanized elapsed", () => {
  const entry = enrichWithProgress(baseEntry, { issue: 73, phase: "review", status: "start", since: 1000, pid: 999, attempt: "2/3" }, { now: 253000, alive: true });
  expect(formatStatus([entry])).toContain("phase=review attempt=2/3 elapsed=4m12s");
});

test("formatStatus marks a stale tombstone", () => {
  const entry = enrichWithProgress(baseEntry, { issue: 73, phase: "patch", status: "fail", since: 0, pid: 999, reason: "timeout" }, { now: 5000, alive: false });
  expect(formatStatus([entry])).toContain("phase=patch");
  expect(formatStatus([entry])).toContain("stale");
});

test("a finished run's leftover (done + dead pid) is not shown as in-progress", () => {
  const snap: ProgressSnapshot = { issue: 73, phase: "pr", status: "done", since: 0, pid: 999 };
  expect(enrichWithProgress(baseEntry, snap, { now: 5000, alive: false }).progress).toBeUndefined();
});

test("a crash mid-phase (start + dead pid) is shown stale", () => {
  const snap: ProgressSnapshot = { issue: 73, phase: "patch", status: "start", since: 0, pid: 999 };
  expect(enrichWithProgress(baseEntry, snap, { now: 5000, alive: false }).progress).toMatchObject({ phase: "patch", stale: true });
});

test("#175 humanizeElapsed renders hours for long durations", () => {
  expect(humanizeElapsed(5_000)).toBe("5s");          // unchanged: sub-minute
  expect(humanizeElapsed(252_000)).toBe("4m12s");     // unchanged: sub-hour
  expect(humanizeElapsed(169_106_485)).toBe("46h58m"); // 46h58m26s -> h+m
  expect(humanizeElapsed(3_600_000)).toBe("1h0m");
});
