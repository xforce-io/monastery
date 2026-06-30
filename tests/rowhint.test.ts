import { expect, test } from "vitest";
import { rowHint } from "../src/cli/backlog.js";
import type { BacklogEntry } from "../src/types.js";

const base: BacklogEntry = { number: 5, title: "t", priority: "soon", rationale: "r" };

test("#175 awaiting-gate row hints with a direct 👍 link", () => {
  const e = { ...base, number: 12, approvalKind: "implement", approvalCommentId: "999" };
  expect(rowHint("o/r", e)).toEqual({
    text: "等你 👍(implement)",
    url: "https://github.com/o/r/issues/12#issuecomment-999",
  });
});

test("#175 stale progress outranks everything and names the pid", () => {
  const e = { ...base, approvalKind: "merge", approvalCommentId: "1" };
  const progress = { phase: "patch", attempt: undefined, elapsedMs: 169_106_485, stale: true, status: "start", reason: undefined, pid: 4242 };
  expect(rowHint("o/r", e, { progress })).toEqual({ text: "进度陈旧 46h58m,先 ps 4242" });
});

test("#175 blocked row points at its blockers", () => {
  expect(rowHint("o/r", { ...base, blockedBy: ["#3", "#4"] })).toEqual({ text: "等 #3, #4" });
});

test("#175 fails at/over threshold nudges a look; under threshold is silent", () => {
  expect(rowHint("o/r", { ...base, fails: 3 })).toEqual({ text: "连败 3 次,可能要你看看" });
  expect(rowHint("o/r", { ...base, fails: 2 })).toBeNull();
  expect(rowHint("o/r", { ...base, fails: 2 }, { failThreshold: 2 })).toEqual({ text: "连败 2 次,可能要你看看" });
});

test("#175 a plain queued row has no hint", () => {
  expect(rowHint("o/r", base)).toBeNull();
});

test("#175 non-stale progress does not suppress the gate hint", () => {
  const e = { ...base, approvalKind: "close", approvalCommentId: "7" };
  const progress = { phase: "review", attempt: "1/3", elapsedMs: 1000, stale: false, status: "start", reason: undefined, pid: 9 };
  expect(rowHint("o/r", e, { progress })?.url).toBe("https://github.com/o/r/issues/5#issuecomment-7");
});
