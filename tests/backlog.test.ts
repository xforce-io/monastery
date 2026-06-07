// tests/backlog.test.ts
import { expect, test } from "vitest";
import { deriveEntry } from "../src/engine/backlog.js";
import { sortEntries } from "../src/engine/backlog.js";
import type { Action } from "../src/shell/actions.js";
import type { BacklogEntry } from "../src/types.js";

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

const e = (number: number, priority: BacklogEntry["priority"], extra: Partial<BacklogEntry> = {}): BacklogEntry =>
  ({ number, title: `#${number}`, priority, rationale: "", ...extra });

test("sorts by bucket order now > soon > later > parked", () => {
  const out = sortEntries([e(1, "parked"), e(2, "later"), e(3, "now"), e(4, "soon")]);
  expect(out.map((x) => x.number)).toEqual([3, 4, 2, 1]);
});

test("within a bucket: not-blocked before blocked", () => {
  const out = sortEntries([e(1, "later", { blockedBy: ["o/r#9"] }), e(2, "later")]);
  expect(out.map((x) => x.number)).toEqual([2, 1]);
});

test("within a bucket: fewer fails before more, then lower number", () => {
  const out = sortEntries([e(5, "soon", { fails: 2 }), e(6, "soon"), e(3, "soon")]);
  expect(out.map((x) => x.number)).toEqual([3, 6, 5]);
});

test("does not mutate the input array", () => {
  const input = [e(2, "later"), e(1, "now")];
  sortEntries(input);
  expect(input.map((x) => x.number)).toEqual([2, 1]);
});
