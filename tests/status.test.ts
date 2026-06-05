// tests/status.test.ts
import { expect, test } from "vitest";
import { formatStatus, toStatusEntry } from "../src/cli/status.js";
import type { Issue } from "../src/types.js";

const issues: Issue[] = [
  {
    number: 1,
    title: "Fix login bug",
    body: "",
    labels: ["monastery/state:triaged", "thesis:in", "type:bug", "monastery:needs-approval"],
    state: "open",
  },
  {
    number: 2,
    title: "Add dark mode",
    body: "",
    labels: ["monastery/state:classified", "thesis:unclear", "type:feature", "monastery:try-fix"],
    state: "open",
  },
  {
    number: 3,
    title: "How to deploy?",
    body: "",
    labels: [],
    state: "open",
  },
];

test("toStatusEntry extracts all fields incl. repo from a fully-labelled issue", () => {
  expect(toStatusEntry("o/r", issues[0])).toEqual({
    repo: "o/r",
    number: 1,
    title: "Fix login bug",
    state: "triaged",
    thesis: "in",
    type: "bug",
    actions: ["needs-approval"],
  });
});

test("toStatusEntry defaults state to 'new' when no state label is present", () => {
  expect(toStatusEntry("o/r", issues[2])).toEqual({
    repo: "o/r",
    number: 3,
    title: "How to deploy?",
    state: "new",
    thesis: undefined,
    type: undefined,
    actions: [],
  });
});

test("toStatusEntry handles try-fix and thesis:unclear", () => {
  const e = toStatusEntry("o/r", issues[1]);
  expect(e.state).toBe("classified");
  expect(e.thesis).toBe("unclear");
  expect(e.type).toBe("feature");
  expect(e.actions).toEqual(["try-fix"]);
});

test("formatStatus prefixes each line with owner/repo#num so multi-repo entries are unique", () => {
  // same issue number from two different repos must be distinguishable
  const out = formatStatus([toStatusEntry("o/a", issues[0]), toStatusEntry("o/b", issues[0])]);
  const lines = out.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("o/a#1");
  expect(lines[1]).toContain("o/b#1");
  expect(lines[0]).toContain("Fix login bug");
  expect(lines[0]).toContain("triaged");
  expect(lines[0]).toContain("thesis:in");
  expect(lines[0]).toContain("type:bug");
  expect(lines[0]).toContain("needs-approval");
});

test("formatStatus shows 'new' state for unlabelled issue", () => {
  const out = formatStatus([toStatusEntry("o/r", issues[2])]);
  expect(out).toContain("o/r#3");
  expect(out).toContain("How to deploy?");
  expect(out).toContain("new");
});

test("formatStatus omits thesis and type when absent", () => {
  const out = formatStatus([toStatusEntry("o/r", issues[2])]);
  expect(out).not.toContain("thesis:");
  expect(out).not.toContain("type:");
});
