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

test("toStatusEntry extracts all fields from a fully-labelled issue", () => {
  expect(toStatusEntry(issues[0])).toEqual({
    number: 1,
    title: "Fix login bug",
    state: "triaged",
    thesis: "in",
    type: "bug",
    actions: ["needs-approval"],
  });
});

test("toStatusEntry defaults state to 'new' when no state label is present", () => {
  expect(toStatusEntry(issues[2])).toEqual({
    number: 3,
    title: "How to deploy?",
    state: "new",
    thesis: undefined,
    type: undefined,
    actions: [],
  });
});

test("toStatusEntry handles try-fix and thesis:unclear", () => {
  const e = toStatusEntry(issues[1]);
  expect(e.state).toBe("classified");
  expect(e.thesis).toBe("unclear");
  expect(e.type).toBe("feature");
  expect(e.actions).toEqual(["try-fix"]);
});

test("formatStatus returns one line per issue with human-readable fields", () => {
  const out = formatStatus(issues);
  const lines = out.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("#1");
  expect(lines[0]).toContain("Fix login bug");
  expect(lines[0]).toContain("triaged");
  expect(lines[0]).toContain("thesis:in");
  expect(lines[0]).toContain("type:bug");
  expect(lines[0]).toContain("needs-approval");
});

test("formatStatus shows 'new' state for unlabelled issue", () => {
  const out = formatStatus([issues[2]]);
  expect(out).toContain("#3");
  expect(out).toContain("How to deploy?");
  expect(out).toContain("new");
});

test("formatStatus omits thesis and type when absent", () => {
  const out = formatStatus([issues[2]]);
  expect(out).not.toContain("thesis:");
  expect(out).not.toContain("type:");
});
