import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { FakeWorkspace } from "../src/workspace/fake.js";

test("FakeWorkspace: clone makes a real dir; commitPush + cleanup record; cleanup removes the dir", async () => {
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const dir = await ws.clone("o/r", "monastery/fix-1");
  expect(existsSync(dir)).toBe(true);
  expect(ws.cloned[0]).toMatchObject({ repo: "o/r", branch: "monastery/fix-1" });
  expect(await ws.stagedDiff(dir)).toBe("patch");
  expect(await ws.runTests(dir)).toBe(true);
  await ws.commitPush(dir, "monastery/fix-1", "fix: x");
  expect(ws.committed[0]).toEqual({ branch: "monastery/fix-1", message: "fix: x" });
  await ws.cleanup(dir);
  expect(ws.cleaned).toContain(dir);
  expect(existsSync(dir)).toBe(false);
});

test("FakeWorkspace defaults: empty diff, null tests", async () => {
  const ws = new FakeWorkspace();
  expect(await ws.stagedDiff("d")).toBe("");
  expect(await ws.runTests("d")).toBeNull();
});

// #163: the bug lived in WHICH base stagedDiff diffs against, so the fake must make that base observable.
test("#163 FakeWorkspace records the base passed to stagedDiff", async () => {
  const ws = new FakeWorkspace({ diff: "patch" });
  await ws.stagedDiff("d");                 // implement path — no base
  await ws.stagedDiff("d", "origin/main");  // rework path — base ref
  expect(ws.diffBases).toEqual([undefined, "origin/main"]);
});

// #163: a base-aware diff lets a test reproduce the deadlock — the cumulative diff is only visible WITH a base.
test("#163 FakeWorkspace: a function diff is driven by the base argument", async () => {
  const ws = new FakeWorkspace({ diff: (base) => (base ? "CUMULATIVE" : "INCREMENT") });
  expect(await ws.stagedDiff("d")).toBe("INCREMENT");
  expect(await ws.stagedDiff("d", "origin/main")).toBe("CUMULATIVE");
});
