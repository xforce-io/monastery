// tests/step-lock.test.ts
import { expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StepLock, RepoLockError, isAlive } from "../src/config/step-lock.js";

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

test("lock file carries stable owner identity: host (hostname) and non-empty token", () => {
  const { lock, dir } = tmpLock();
  const lockPath = join(dir, "repos", "owner__repo", "step.lock");

  const release = lock.acquire("owner/repo");
  const data = JSON.parse(readFileSync(lockPath, "utf8"));
  expect(data.host).toBe(hostname());
  expect(typeof data.token).toBe("string");
  expect(data.token.length).toBeGreaterThan(0);
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

test("release is a no-op when the lock has changed hands (does not delete another holder's lock)", () => {
  const { lock, dir } = tmpLock();
  const lockPath = join(dir, "repos", "owner__repo", "step.lock");

  const release1 = lock.acquire("owner/repo");
  // Simulate the lock changing hands: a different owner (token) now holds it.
  const data = JSON.parse(readFileSync(lockPath, "utf8"));
  writeFileSync(lockPath, JSON.stringify({ ...data, token: "a-different-owners-token" }), "utf8");

  // release1 belongs to the prior owner — it must NOT delete the current holder's lock.
  release1();
  expect(existsSync(lockPath)).toBe(true);
  const after = JSON.parse(readFileSync(lockPath, "utf8"));
  expect(after.token).toBe("a-different-owners-token");

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

test("cross-host lock with a locally-dead pid but recent startedAt is treated as alive (not cleared via local pid)", () => {
  const { lock, dir } = tmpLock();
  const repoDir = join(dir, "repos", "owner__repo");
  mkdirSync(repoDir, { recursive: true });

  // Lock owned by a DIFFERENT host. Its pid is meaningless locally — process.kill
  // here would check an unrelated local pid. Recent startedAt → must be treated as
  // a live lock, NOT auto-cleared through local pid liveness.
  writeFileSync(
    join(repoDir, "step.lock"),
    JSON.stringify({
      pid: 2_000_000_000, // not running on this machine
      host: "some-other-host",
      token: "remote-token",
      repo: "owner/repo",
      startedAt: new Date().toISOString(),
      cmd: "",
    }),
    "utf8",
  );

  let caught: unknown;
  try { lock.acquire("owner/repo"); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(RepoLockError);

  rmSync(dir, { recursive: true, force: true });
});

test("cross-host lock older than the stale threshold is cleared and re-acquired", () => {
  const { lock, dir } = tmpLock();
  const repoDir = join(dir, "repos", "owner__repo");
  mkdirSync(repoDir, { recursive: true });

  writeFileSync(
    join(repoDir, "step.lock"),
    JSON.stringify({
      pid: 2_000_000_000,
      host: "some-other-host",
      token: "remote-token",
      repo: "owner/repo",
      startedAt: "2020-01-01T00:00:00Z", // far beyond STALE_LOCK_MS
      cmd: "",
    }),
    "utf8",
  );

  // Even cross-host, an ancient lock is stale and may be reclaimed.
  const release = lock.acquire("owner/repo");
  const data = JSON.parse(readFileSync(join(repoDir, "step.lock"), "utf8"));
  expect(data.host).toBe(hostname());
  release();

  rmSync(dir, { recursive: true, force: true });
});

test("#185: force does NOT displace a provably-live same-host holder (no concurrent assess/run)", () => {
  const { lock, dir } = tmpLock();
  const lockPath = join(dir, "repos", "owner__repo", "step.lock");
  const held = lock.acquire("owner/repo"); // live lock, our pid, this host
  const before = readFileSync(lockPath, "utf8");

  let caught: unknown;
  try { lock.acquire("owner/repo", "", true); } catch (e) { caught = e; }

  // force must refuse — the holder is locally proven alive; deleting it would allow concurrent execution.
  expect(caught).toBeInstanceOf(RepoLockError);
  expect(existsSync(lockPath)).toBe(true);
  expect(readFileSync(lockPath, "utf8")).toBe(before); // untouched — same holder still owns it

  held();
  rmSync(dir, { recursive: true, force: true });
});

test("#185: force STILL displaces a cross-host recent lock (the legitimate escape hatch) and warns", () => {
  const { lock, dir } = tmpLock();
  const repoDir = join(dir, "repos", "owner__repo");
  mkdirSync(repoDir, { recursive: true });
  const lockPath = join(repoDir, "step.lock");
  // A recent lock owned by another machine — liveness is locally unprovable. force = "I checked; it's gone."
  writeFileSync(lockPath, JSON.stringify({
    pid: 4242, host: "some-other-host", token: "remote", repo: "owner/repo",
    startedAt: new Date().toISOString(), cmd: "",
  }), "utf8");

  const warns: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((m?: unknown) => { warns.push(String(m)); });
  const release = lock.acquire("owner/repo", "", true); // must succeed
  spy.mockRestore();

  expect(warns.some((w) => w.includes("4242"))).toBe(true); // not silent about what it displaced
  expect(JSON.parse(readFileSync(lockPath, "utf8")).host).toBe(hostname()); // we now hold it
  release();
  rmSync(dir, { recursive: true, force: true });
});

test("acquire registers SIGINT/SIGTERM handlers; release removes them", () => {
  const { lock, dir } = tmpLock();
  const before = {
    int: process.listenerCount("SIGINT"),
    term: process.listenerCount("SIGTERM"),
  };

  const release = lock.acquire("owner/repo");
  expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
  expect(process.listenerCount("SIGTERM")).toBe(before.term + 1);

  release();
  expect(process.listenerCount("SIGINT")).toBe(before.int);
  expect(process.listenerCount("SIGTERM")).toBe(before.term);

  rmSync(dir, { recursive: true, force: true });
});

test("SIGTERM releases the held lock end-to-end (a real child process is signalled)", async () => {
  // Spawn a real process that acquires the lock and stays alive, then send it
  // SIGTERM. Without the signal handler the lock file would leak (the original
  // bug this hardening fixes); with it, the lock must be gone after the process dies.
  const dir = mkdtempSync(join(tmpdir(), "monastery-lock-sig-"));
  const lockPath = join(dir, "repos", "owner__repo", "step.lock");
  const fixture = fileURLToPath(new URL("./fixtures/step-lock-child.ts", import.meta.url));

  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", "--no-warnings", fixture, dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Wait until the child reports it has acquired the lock.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for child READY")), 15000);
    let buf = "";
    const onData = (d: unknown) => {
      buf += String(d);
      if (buf.includes("READY")) {
        clearTimeout(t);
        child.stdout!.off("data", onData);
        child.removeAllListeners("exit");
        resolve();
      }
    };
    child.stdout!.on("data", onData);
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("exit", (c, s) => { clearTimeout(t); reject(new Error(`child exited before READY code=${c} sig=${s}`)); });
  });

  expect(existsSync(lockPath)).toBe(true);

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.kill("SIGTERM");
  await exited;

  // The signal handler released the lock before the process terminated.
  expect(existsSync(lockPath)).toBe(false);

  rmSync(dir, { recursive: true, force: true });
}, 20000);

test("progressPath returns the sidecar path next to the lock", () => {
  const { lock, dir } = tmpLock();
  expect(lock.progressPath("owner/repo")).toBe(join(dir, "repos", "owner__repo", "step.progress"));
  rmSync(dir, { recursive: true, force: true });
});

test("isAlive is true for this process and false for a definitely-dead pid", () => {
  expect(isAlive(process.pid)).toBe(true);
  expect(isAlive(2147483646)).toBe(false); // pid out of range -> EINVAL -> not alive
});
