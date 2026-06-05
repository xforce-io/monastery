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
