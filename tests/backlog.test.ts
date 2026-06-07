// tests/backlog.test.ts
import { expect, test } from "vitest";
import { deriveEntry } from "../src/engine/backlog.js";
import type { Action } from "../src/shell/actions.js";

const issue = { number: 7, title: "do a thing" };

test("implement → now", () => {
  const e = deriveEntry(issue, [{ kind: "implement", num: 7 }], [], 0);
  expect(e.priority).toBe("now");
  expect(e.rationale).toContain("implement");
  expect(e).toMatchObject({ number: 7, title: "do a thing" });
});

test("advancing actions (panel/spec/...) → soon", () => {
  const e = deriveEntry(issue, [{ kind: "panel", num: 7, body: "x" }], [], 0);
  expect(e.priority).toBe("soon");
});

test("only light governance (reply/relabel) → later", () => {
  const a: Action[] = [{ kind: "relabel", num: 7, add: ["type:bug"], remove: [] }];
  const e = deriveEntry(issue, a, [], 0);
  expect(e.priority).toBe("later");
  expect(e.rationale).toContain("light governance");
});

test("empty actions → later, 'no action this tick'", () => {
  const e = deriveEntry(issue, [], [], 0);
  expect(e.priority).toBe("later");
  expect(e.rationale).toBe("no action this tick");
});

test("strongest signal wins: reply + implement → now", () => {
  const a: Action[] = [
    { kind: "reply", num: 7, toCommentId: "c1", body: "hi" },
    { kind: "implement", num: 7 },
  ];
  expect(deriveEntry(issue, a, [], 0).priority).toBe("now");
});

test("blockedBy and fails are attached only when non-empty/positive", () => {
  const withBoth = deriveEntry(issue, [], ["o/r#3"], 2);
  expect(withBoth.blockedBy).toEqual(["o/r#3"]);
  expect(withBoth.fails).toBe(2);
  const without = deriveEntry(issue, [], [], 0);
  expect(without.blockedBy).toBeUndefined();
  expect(without.fails).toBeUndefined();
});
