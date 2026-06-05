import { expect, test } from "vitest";
import { GitWorkspace, type Runner } from "../src/workspace/git-workspace.js";

function recorder(stdouts: Record<string, string> = {}): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (file, args) => {
    calls.push([file, ...args]);
    const key = [file, ...args].join(" ");
    return { stdout: stdouts[key] ?? "", exitCode: 0 };
  };
  return { run, calls };
}

test("stagedDiff stages then returns the cached diff", async () => {
  const { run, calls } = recorder({ "git -C /d diff --cached": "DIFF" });
  const ws = new GitWorkspace(run);
  const diff = await ws.stagedDiff("/d");
  expect(diff).toBe("DIFF");
  expect(calls).toEqual([
    ["git", "-C", "/d", "add", "-A"],
    ["git", "-C", "/d", "diff", "--cached"],
  ]);
});

test("commitPush commits then pushes the branch", async () => {
  const { run, calls } = recorder();
  const ws = new GitWorkspace(run);
  await ws.commitPush("/d", "monastery/fix-1", "fix: x");
  expect(calls).toEqual([
    ["git", "-C", "/d", "-c", "user.name=monastery", "-c", "user.email=monastery@users.noreply.github.com", "commit", "-m", "fix: x"],
    ["git", "-C", "/d", "push", "-u", "origin", "monastery/fix-1", "--force"],
  ]);
});

test("commitPush throws when git commit fails", async () => {
  const run = async (file: string, args: string[]) => ({ stdout: "", exitCode: file === "git" && args.includes("commit") ? 1 : 0 });
  const ws = new GitWorkspace(run);
  await expect(ws.commitPush("/d", "b", "m")).rejects.toThrow(/git commit failed/);
});

test("runTests returns null when there is no package.json", async () => {
  const { run } = recorder();
  const ws = new GitWorkspace(run);
  // a path that surely has no package.json
  expect(await ws.runTests("/nonexistent-dir-xyz")).toBeNull();
});
