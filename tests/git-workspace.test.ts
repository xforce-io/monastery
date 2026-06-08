import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
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

// #87 sandbox isolation: the clone() sandbox must live under os.tmpdir(), never the
// main working tree (process.cwd()). Guards the "约束而非信任" filesystem invariant —
// a regression here is how a patcher run could pollute the repo it runs from.
test("#87 clone() sandbox lives in tmpdir, never process.cwd()", async () => {
  const { run } = recorder();
  const ws = new GitWorkspace(run);
  const dir = await ws.clone("o/r", "feat/1-x");
  try {
    expect(dir).not.toBe(process.cwd());
    expect(dirname(dir)).toBe(tmpdir());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #108 cloneReadOnly: a shallow checkout (no branch) for code-reading agents (the maintainer).
test("#108 cloneReadOnly is a shallow checkout in tmpdir with no branch", async () => {
  const { run, calls } = recorder();
  const ws = new GitWorkspace(run);
  const dir = await ws.cloneReadOnly("o/r");
  try {
    expect(dir).not.toBe(process.cwd());
    expect(dirname(dir)).toBe(tmpdir());
    // shallow clone, and NO `checkout -b` — read-only, never branches/commits
    expect(calls).toEqual([["gh", "repo", "clone", "o/r", dir, "--", "--depth", "1"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#108 cloneReadOnly throws when gh clone fails", async () => {
  const run: Runner = async (file) => ({ stdout: "not found", exitCode: file === "gh" ? 1 : 0 });
  const ws = new GitWorkspace(run);
  await expect(ws.cloneReadOnly("o/r")).rejects.toThrow(/read-only.*failed/);
});

// #79 checkout: clone + check out an EXISTING remote branch (no `-b`) — for reworking an open draft PR.
test("#79 checkout() clones then checks out an existing branch, never -b", async () => {
  const { run, calls } = recorder();
  const ws = new GitWorkspace(run);
  const dir = await ws.checkout("o/r", "feat/7-fix");
  try {
    expect(dir).not.toBe(process.cwd());
    expect(dirname(dir)).toBe(tmpdir());
    expect(calls).toEqual([
      ["gh", "repo", "clone", "o/r", dir],
      ["git", "-C", dir, "checkout", "feat/7-fix"], // EXISTING branch — no `-b`
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#79 checkout() throws when the branch checkout fails (branch gone)", async () => {
  const run: Runner = async (file, args) => ({ stdout: "error: pathspec", exitCode: file === "git" && args.includes("checkout") ? 1 : 0 });
  const ws = new GitWorkspace(run);
  await expect(ws.checkout("o/r", "feat/7-fix")).rejects.toThrow(/checkout.*failed/i);
});
