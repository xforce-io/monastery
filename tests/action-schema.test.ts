// tests/action-schema.test.ts — the zod schema is the single source of truth for the Action vocabulary.
import { expect, test } from "vitest";
import { ActionSchema, ActionsSchema, executeSafe } from "../src/shell/actions.js";
import { FakeGitHub } from "../src/github/fake.js";

test("ActionSchema accepts each proposable action kind", () => {
  const valid = [
    { kind: "reply", num: 1, toCommentId: "9", body: "hi" },
    { kind: "relabel", num: 1, add: ["type:bug"], remove: [] },
    { kind: "panel", num: 1, body: "status" },
    { kind: "openDraftPR", num: 1, branch: "feat/1-x", title: "t", body: "b" },
    { kind: "propose", num: 1, proposal: "close", draft: "because X" },
    { kind: "propose", num: 1, proposal: "merge", draft: "looks good" },
    { kind: "implement", num: 1 },
  ];
  for (const a of valid) expect(ActionSchema.safeParse(a).success).toBe(true);
});

test("executeSafe refuses 'implement' — it is a shell executor (runImplement), not a cheap safe write", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await expect(executeSafe(gh, "o/r", { kind: "implement", num: 1 })).rejects.toThrow(/implement/);
});

test("ActionSchema rejects unknown kind and gated executors", () => {
  expect(ActionSchema.safeParse({ kind: "doClose", num: 1 }).success).toBe(false);
  expect(ActionSchema.safeParse({ kind: "merge", num: 1 }).success).toBe(false);
  expect(ActionSchema.safeParse({ kind: "nope" }).success).toBe(false);
});

test("ActionSchema rejects a malformed action (missing/empty fields, bad proposal)", () => {
  expect(ActionSchema.safeParse({ kind: "reply", num: 1, toCommentId: "9" }).success).toBe(false); // no body
  expect(ActionSchema.safeParse({ kind: "reply", num: 1, toCommentId: "9", body: "" }).success).toBe(false); // empty body
  expect(ActionSchema.safeParse({ kind: "propose", num: 1, proposal: "delete", draft: "x" }).success).toBe(false);
  expect(ActionSchema.safeParse({ kind: "panel", num: "1", body: "x" }).success).toBe(false); // num not a number
});

test("ActionsSchema validates a batch under { actions: [...] }", () => {
  const ok = ActionsSchema.safeParse({ actions: [{ kind: "relabel", num: 2, add: ["thesis:in"], remove: [] }] });
  expect(ok.success).toBe(true);
  expect(ActionsSchema.safeParse({ actions: [] }).success).toBe(true); // empty batch = nothing to do
  expect(ActionsSchema.safeParse({ actions: [{ kind: "nope" }] }).success).toBe(false);
});
