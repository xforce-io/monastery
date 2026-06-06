// tests/status.test.ts
import { expect, test } from "vitest";
import { formatStatus, toStatusEntry, protocolState } from "../src/cli/status.js";
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
