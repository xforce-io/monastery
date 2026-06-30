// tests/maintainer-fingerprint.test.ts — #192: the per-issue input fingerprint that lets assess skip the
// maintainer LLM when nothing the agent sees has changed. PURE cost cache: it hashes the exact agent input,
// MINUS the two things that would self-invalidate it (monastery's own comments, the sibling backlog).
import { expect, test } from "vitest";
import { maintainerInputFingerprint } from "../src/engine/maintainer-fingerprint.js";
import type { MaintainerInput } from "../src/agents/maintainer.js";

function baseInput(): MaintainerInput {
  return {
    thesis: "the repo thesis",
    issue: { number: 5, title: "x", body: "b", labels: ["type:bug"], state: "open" },
    comments: [{ id: "h1", body: "human says fix it", author: "alice" }],
    pr: null,
    deps: [],
    self: "monastery-bot",
    consensus: { spec: null, endorsedCurrent: [], reached: false },
    backlog: [{ number: 9, title: "other", state: "open", labels: [] }],
    language: "zh-CN",
  };
}

test("identical maintainer input → identical fingerprint", () => {
  expect(maintainerInputFingerprint(baseInput())).toBe(maintainerInputFingerprint(baseInput()));
});

test("a new human comment changes the fingerprint (the agent should re-evaluate)", () => {
  const before = maintainerInputFingerprint(baseInput());
  const after = baseInput();
  after.comments.push({ id: "h2", body: "actually, also do this", author: "alice" });
  expect(maintainerInputFingerprint(after)).not.toBe(before);
});

test("monastery's OWN comment does NOT change the fingerprint (else assess's panel self-invalidates the cache)", () => {
  const before = maintainerInputFingerprint(baseInput());
  const after = baseInput();
  // a sticky panel / marker reply assess just posted — authored by self, changes every tick.
  after.comments.push({ id: "p1", body: "<!--monastery-panel-->\nstatus: ...", author: "monastery-bot" });
  expect(maintainerInputFingerprint(after)).toBe(before);
});

function inputWithPr(): MaintainerInput {
  const i = baseInput();
  i.pr = {
    branch: "feat/5-x", state: "open", checks: "pending",
    comments: [{ id: "pc1", body: "looks good", author: "reviewer" }],
    reviews: [{ author: "reviewer", state: "COMMENTED", body: "nit" }],
  };
  return i;
}

test("a human PR review changes the fingerprint (rework feedback must re-evaluate)", () => {
  const before = maintainerInputFingerprint(inputWithPr());
  const after = inputWithPr();
  after.pr!.reviews!.push({ author: "reviewer", state: "CHANGES_REQUESTED", body: "please fix" });
  expect(maintainerInputFingerprint(after)).not.toBe(before);
});

test("monastery's OWN PR comment does NOT change the fingerprint", () => {
  const before = maintainerInputFingerprint(inputWithPr());
  const after = inputWithPr();
  after.pr!.comments!.push({ id: "pc2", body: "<!--monastery-gatelink-->", author: "monastery-bot" });
  expect(maintainerInputFingerprint(after)).toBe(before);
});

test("a change in the sibling backlog does NOT change the fingerprint (no cross-issue invalidation)", () => {
  const before = maintainerInputFingerprint(baseInput());
  const after = baseInput();
  after.backlog!.push({ number: 99, title: "a brand new sibling", state: "open", labels: [] });
  expect(maintainerInputFingerprint(after)).toBe(before);
});

test("a dependency closing changes the fingerprint (unblock must re-evaluate)", () => {
  const before = maintainerInputFingerprint(baseInput());
  const after = baseInput();
  after.deps = [{ ref: "o/up#9", state: "closed", title: "upstream" }];
  expect(maintainerInputFingerprint(after)).not.toBe(before);
});
