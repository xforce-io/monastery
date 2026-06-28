// tests/run.test.ts
import { describe, it, expect } from "vitest";
import { isRunnable, entryStatus } from "../src/engine/run.js";
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

describe("isRunnable — #176: run only consumes human-approved, unblocked items", () => {
  it("is runnable when not awaiting approval and not blocked", () => {
    expect(isRunnable(entry())).toBe(true);
  });

  it("is NOT runnable while awaiting the human's 👍", () => {
    expect(isRunnable(entry({ awaitingApproval: true }))).toBe(false);
  });

  it("is NOT runnable while blocked by an open dependency", () => {
    expect(isRunnable(entry({ blockedBy: ["o/r#2"] }))).toBe(false);
  });
});
