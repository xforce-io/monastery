// tests/run.test.ts
import { describe, it, expect } from "vitest";
import { entryStatus, groupByStatus } from "../src/engine/run.js";
import type { BacklogEntry } from "../src/types.js";

function entry(over: Partial<BacklogEntry> = {}): BacklogEntry {
  return { number: 1, title: "t", priority: "now", rationale: "r", ...over };
}

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
