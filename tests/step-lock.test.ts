// tests/step-lock.test.ts
import { expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepLock, RepoLockError } from "../src/config/step-lock.js";

function tmpLock() {
  const dir = mkdtempSync(join(tmpdir(), "monastery-lock-"));
  return { lock: new StepLock(dir), dir };
}

test("acquire creates lock file with pid/repo/startedAt; release removes it", () => {
  const { lock, dir } = tmpLock();
  const lockPath = join(dir, "repos", "owner__repo", "step.lock");

  const release = lock.acquire("owner/repo", "monastery step --repo owner/repo");
  expect(existsSync(lockPath)).toBe(true);
  release();
  expect(existsSync(lockPath)).toBe(false);

  rmSync(dir, { recursive: true, force: true });
});

test("lock file contains pid, repo, startedAt, cmd", () => {
  const { lock, dir } = tmpLock();
  const lockPath = join(dir, "repos", "owner__repo", "step.lock");

  const release = lock.acquire("owner/repo", "monastery step --repo owner/repo");
  const data = JSON.parse(readFileSync(lockPath, "utf8"));
  expect(data.pid).toBe(process.pid);
  expect(data.repo).toBe("owner/repo");
  expect(typeof data.startedAt).toBe("string");
  expect(data.cmd).toBe("monastery step --repo owner/repo");
  release();

  rmSync(dir, { recursive: true, force: true });
});

test("second acquire on same repo throws RepoLockError with pid and startedAt", () => {
  const { lock, dir } = tmpLock();
  const release = lock.acquire("owner/repo");

  let caught: unknown;
  try {
    lock.acquire("owner/repo");
  } catch (e) {
    caught = e;
  }

  expect(caught).toBeInstanceOf(RepoLockError);
  const err = caught as RepoLockError;
  expect(err.repo).toBe("owner/repo");
  expect(err.pid).toBe(process.pid);
  expect(typeof err.startedAt).toBe("string");

  release();
  rmSync(dir, { recursive: true, force: true });
});

test("release allows re-acquisition", () => {
  const { lock, dir } = tmpLock();
  const release1 = lock.acquire("owner/repo");
  release1();

  // Should not throw
  const release2 = lock.acquire("owner/repo");
  release2();

  rmSync(dir, { recursive: true, force: true });
});

test("different repos do not interfere with each other", () => {
  const { lock, dir } = tmpLock();
  const release1 = lock.acquire("owner/repo1");
  const release2 = lock.acquire("owner/repo2");

  release1();
  release2();
  rmSync(dir, { recursive: true, force: true });
});

test("stale lock (dead pid) is auto-cleared; acquire succeeds", () => {
  const { lock, dir } = tmpLock();
  const repoDir = join(dir, "repos", "owner__repo");
  mkdirSync(repoDir, { recursive: true });

  // Write a stale lock file with a pid that cannot possibly be running
  const deadPid = 2_000_000_000;
  writeFileSync(
    join(repoDir, "step.lock"),
    JSON.stringify({ pid: deadPid, repo: "owner/repo", startedAt: "2020-01-01T00:00:00Z", cmd: "" }),
    "utf8",
  );

  // Should not throw — stale lock is cleared automatically
  const release = lock.acquire("owner/repo");
  release();

  rmSync(dir, { recursive: true, force: true });
});

test("lock held by an alive pid but older than the stale threshold is auto-cleared", () => {
  const { lock, dir } = tmpLock();
  const repoDir = join(dir, "repos", "owner__repo");
  mkdirSync(repoDir, { recursive: true });

  // pid is alive (this very process), but startedAt is years ago — well beyond
  // any plausible step duration. Treat as a stale leftover (e.g. crashed run
  // whose pid was later reused) and clear it instead of blocking forever.
  writeFileSync(
    join(repoDir, "step.lock"),
    JSON.stringify({ pid: process.pid, repo: "owner/repo", startedAt: "2020-01-01T00:00:00Z", cmd: "" }),
    "utf8",
  );

  const release = lock.acquire("owner/repo");
  // re-acquired by us
  const data = JSON.parse(readFileSync(join(repoDir, "step.lock"), "utf8"));
  expect(data.pid).toBe(process.pid);
  expect(data.startedAt).not.toBe("2020-01-01T00:00:00Z");
  release();

  rmSync(dir, { recursive: true, force: true });
});

test("force overwrite of a live lock warns about the displaced pid", () => {
  const { lock, dir } = tmpLock();
  const held = lock.acquire("owner/repo"); // live lock, our pid

  const warns: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((m?: unknown) => { warns.push(String(m)); });
  // force should overwrite even though the holder is alive, but not silently
  const release = lock.acquire("owner/repo", "", true);
  spy.mockRestore();

  expect(warns.some((w) => w.includes(String(process.pid)))).toBe(true);

  release();
  held();
  rmSync(dir, { recursive: true, force: true });
});
