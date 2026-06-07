// tests/step-lock.test.ts
import { expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
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

// ── Phase-2 failing tests (issue #81) ────────────────────────────────────────

test("lock file contains hostname and token fields", () => {
  const { lock, dir } = tmpLock();
  const lockPath = join(dir, "repos", "owner__repo", "step.lock");

  const release = lock.acquire("owner/repo", "monastery step");
  const data = JSON.parse(readFileSync(lockPath, "utf8"));
  expect(data.hostname).toBe(osHostname());
  expect(typeof data.token).toBe("string");
  expect(data.token.length).toBeGreaterThan(0);
  release();

  rmSync(dir, { recursive: true, force: true });
});

test("cross-host lock with recent startedAt is not cleared by local dead-pid check", () => {
  // Bug: without hostname check, isAlive(impossiblePid) returns false →
  // lock wrongly treated as stale and cleared. With fix, cross-host lock
  // falls back to time-only check → recent lock throws RepoLockError.
  const { lock, dir } = tmpLock();
  const repoDir = join(dir, "repos", "owner__repo");
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(
    join(repoDir, "step.lock"),
    JSON.stringify({
      pid: 2_000_000_000,       // locally dead pid
      hostname: "other-machine",
      token: "deadbeef12345678",
      repo: "owner/repo",
      startedAt: new Date().toISOString(), // recent — within STALE_LOCK_MS
      cmd: "",
    }),
    "utf8",
  );

  expect(() => lock.acquire("owner/repo")).toThrow(RepoLockError);

  rmSync(dir, { recursive: true, force: true });
});

test("cross-host expired lock is treated as stale and cleared", () => {
  const { lock, dir } = tmpLock();
  const repoDir = join(dir, "repos", "owner__repo");
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(
    join(repoDir, "step.lock"),
    JSON.stringify({
      pid: 2_000_000_000,
      hostname: "other-machine",
      token: "deadbeef12345678",
      repo: "owner/repo",
      startedAt: "2020-01-01T00:00:00Z", // way past 12h threshold
      cmd: "",
    }),
    "utf8",
  );

  // Should succeed — expired cross-host lock is cleared
  const release = lock.acquire("owner/repo");
  release();

  rmSync(dir, { recursive: true, force: true });
});

test("release is a no-op when the lock token has changed (taken over by another holder)", () => {
  // Bug: current release() does unconditional unlink, deleting the new holder's lock.
  const { lock, dir } = tmpLock();
  const lockPath = join(dir, "repos", "owner__repo", "step.lock");

  const releaseA = lock.acquire("owner/repo");
  expect(existsSync(lockPath)).toBe(true);

  // Simulate: A evicted as stale, B acquires — overwrite with a different token
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      hostname: osHostname(),
      token: "bbbb2222cccc3333",
      repo: "owner/repo",
      startedAt: new Date().toISOString(),
      cmd: "",
    }),
    "utf8",
  );

  // A's release must NOT delete B's lock
  releaseA();
  expect(existsSync(lockPath)).toBe(true);
  const current = JSON.parse(readFileSync(lockPath, "utf8"));
  expect(current.token).toBe("bbbb2222cccc3333");

  // cleanup
  unlinkSync(lockPath);
  rmSync(dir, { recursive: true, force: true });
});

test("release removes SIGINT and SIGTERM handlers (no lingering handlers)", () => {
  const { lock, dir } = tmpLock();
  const sigintBefore = process.listenerCount("SIGINT");
  const sigtermBefore = process.listenerCount("SIGTERM");

  const release = lock.acquire("owner/repo");
  expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);

  release();
  expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);

  rmSync(dir, { recursive: true, force: true });
});

test("SIGINT handler releases the lock before re-raising", () => {
  const { lock, dir } = tmpLock();
  const lockPath = join(dir, "repos", "owner__repo", "step.lock");

  lock.acquire("owner/repo");
  expect(existsSync(lockPath)).toBe(true);

  // Prevent the re-raise from actually killing the test process
  const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as unknown as void);
  process.emit("SIGINT");
  killSpy.mockRestore();

  expect(existsSync(lockPath)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("SIGTERM handler releases the lock before re-raising", () => {
  const { lock, dir } = tmpLock();
  const lockPath = join(dir, "repos", "owner__repo", "step.lock");

  lock.acquire("owner/repo");
  expect(existsSync(lockPath)).toBe(true);

  const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as unknown as void);
  process.emit("SIGTERM");
  killSpy.mockRestore();

  expect(existsSync(lockPath)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
