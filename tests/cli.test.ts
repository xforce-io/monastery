// tests/cli.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, stepRepos } from "../src/cli/index.js";
import { StepLock } from "../src/config/step-lock.js";

test("parses `step --repo o/r --dry-run --json`", () => {
  expect(parseArgs(["step", "--repo", "o/r", "--dry-run", "--json"]))
    .toEqual({ cmd: "step", repo: "o/r", dryRun: true, json: true, forceStaleLock: false });
});

test("parses `repos add o/r`", () => {
  expect(parseArgs(["repos", "add", "o/r"])).toEqual({ cmd: "repos", sub: "add", repo: "o/r" });
});

test("parses `repos add o/r opus` (optional per-repo model)", () => {
  expect(parseArgs(["repos", "add", "o/r", "opus"]))
    .toEqual({ cmd: "repos", sub: "add", repo: "o/r", model: "opus" });
});

test("parses bare `step`", () => {
  expect(parseArgs(["step"])).toEqual({ cmd: "step", dryRun: false, json: false, forceStaleLock: false });
});

test("parses `step --repo o/r --issue 5` (single-issue target)", () => {
  expect(parseArgs(["step", "--repo", "o/r", "--issue", "5"]))
    .toEqual({ cmd: "step", repo: "o/r", issue: "5", dryRun: false, json: false, forceStaleLock: false });
});

test("parses `init o/r`", () => {
  expect(parseArgs(["init", "o/r"])).toEqual({ cmd: "init", repo: "o/r" });
});

test("parses bare `status`", () => {
  expect(parseArgs(["status"])).toEqual({ cmd: "status", json: false });
});

test("parses `status --repo o/r --json`", () => {
  expect(parseArgs(["status", "--repo", "o/r", "--json"])).toEqual({ cmd: "status", repo: "o/r", json: true });
});

test("parses `step --repo o/r --force-stale-lock`", () => {
  expect(parseArgs(["step", "--repo", "o/r", "--force-stale-lock"]))
    .toEqual({ cmd: "step", repo: "o/r", dryRun: false, json: false, forceStaleLock: true });
});

test("stepRepos skips a locked repo, runs the rest, and reports exit code 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-steprepos-"));
  const lock = new StepLock(dir);
  // Hold the lock on o/a with a live pid so acquire() fails fast for it.
  const held = lock.acquire("o/a");

  const ran: string[] = [];
  const errs: string[] = [];
  const exitCode = await stepRepos({
    repos: ["o/a", "o/b"],
    lock,
    rawCmd: "step",
    json: true,
    runOne: async (repo) => { ran.push(repo); },
    err: (m) => errs.push(m),
  });

  // o/a is locked → skipped; o/b still runs.
  expect(ran).toEqual(["o/b"]);
  // structured repo_locked error emitted for the locked repo.
  expect(errs.some((e) => e.includes("repo_locked") && e.includes("o/a"))).toBe(true);
  // a lock conflict surfaces as a non-zero exit code.
  expect(exitCode).toBe(1);

  held();
  rmSync(dir, { recursive: true, force: true });
});

test("stepRepos releases the lock after a repo finishes so it can re-run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-steprepos-"));
  const lock = new StepLock(dir);

  const ran: string[] = [];
  const code1 = await stepRepos({ repos: ["o/a"], lock, rawCmd: "step", runOne: async (r) => { ran.push(r); } });
  // lock must be free now — a second run acquires cleanly.
  const code2 = await stepRepos({ repos: ["o/a"], lock, rawCmd: "step", runOne: async (r) => { ran.push(r); } });

  expect(ran).toEqual(["o/a", "o/a"]);
  expect(code1).toBe(0);
  expect(code2).toBe(0);

  rmSync(dir, { recursive: true, force: true });
});
