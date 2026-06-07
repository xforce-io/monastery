// src/config/step-lock.ts — per-repo step lock (guardrail against accidental concurrent runs).
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface LockData {
  pid: number;
  hostname: string;
  token: string;
  repo: string;
  startedAt: string;
  cmd: string;
}

export class RepoLockError extends Error {
  constructor(
    public readonly repo: string,
    public readonly pid: number,
    public readonly startedAt: string,
    public readonly hostname?: string,
  ) {
    super(`repo ${repo} is already being stepped by pid ${pid}@${hostname ?? "unknown"} since ${startedAt}`);
    this.name = "RepoLockError";
  }
}

// A lock whose holder is still "alive" but whose startedAt is older than this is
// treated as stale. Guards against pid reuse (a crashed run's pid handed to an
// unrelated process) and wedged runs. Set well above any plausible step duration.
const STALE_LOCK_MS = 12 * 60 * 60 * 1000; // 12h

function repoSlug(repo: string): string { return repo.replace(/\//g, "__"); }

// Cross-host: can't use local process.kill — assume alive; time threshold decides staleness.
function isAlive(pid: number, lockHostname: string): boolean {
  if (lockHostname !== osHostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    // ESRCH = no such process; EINVAL = pid out of range — both mean definitely not alive.
    // EPERM = process exists but we can't signal it → treat as alive.
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

/**
 * File-based per-repo step lock.
 * Lock path: <root>/repos/<owner>__<repo>/step.lock
 * Acquisition is atomic via O_EXCL. Stale locks (dead pid) are auto-cleared.
 */
export class StepLock {
  constructor(private root: string) {}

  private lockPath(repo: string): string {
    return join(this.root, "repos", repoSlug(repo), "step.lock");
  }

  /**
   * Acquire the lock for `repo`. Returns a release function that removes the lock file.
   * Throws RepoLockError if a live process holds a recent lock.
   * Stale locks are removed and the lock is re-acquired. A lock is stale when its
   * pid is no longer running on the same host, or when its startedAt is older than
   * STALE_LOCK_MS (covers pid reuse and wedged runs; cross-host locks fall back to
   * time-only stale detection).
   * When `force` is true, any existing lock is removed regardless of holder/age —
   * the displaced lock is logged, not removed silently.
   * SIGINT/SIGTERM handlers are installed and removed on release to ensure the lock
   * is cleaned up even on process termination.
   */
  acquire(repo: string, cmd = "", force = false): () => void {
    mkdirSync(join(this.root, "repos", repoSlug(repo)), { recursive: true });
    const path = this.lockPath(repo);

    // --force-stale-lock: unconditionally remove any existing lock before acquiring.
    // The escape hatch for pid-reuse false positives; warn loudly about what we displace.
    if (force) {
      try {
        const prev = JSON.parse(readFileSync(path, "utf8")) as LockData;
        console.warn(`[monastery] --force-stale-lock: removing existing lock held by pid ${prev.pid}@${prev.hostname ?? "unknown"} (startedAt ${prev.startedAt})`);
      } catch { /* no existing/unreadable lock — nothing to displace */ }
      try { unlinkSync(path); } catch { /* ignore */ }
    }

    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw e;

      // File already exists — read it and decide
      let existing: LockData;
      try {
        existing = JSON.parse(readFileSync(path, "utf8")) as LockData;
      } catch {
        // Corrupt lock — remove and retry
        try { unlinkSync(path); } catch { /* ignore */ }
        return this.acquire(repo, cmd);
      }

      const ageMs = Date.now() - Date.parse(existing.startedAt);
      const expired = Number.isFinite(ageMs) && ageMs > STALE_LOCK_MS;
      if (isAlive(existing.pid, existing.hostname ?? "") && !expired) {
        throw new RepoLockError(repo, existing.pid, existing.startedAt, existing.hostname);
      }

      // Stale lock (dead pid on same host, or cross-host with expired age) — remove and retry
      try { unlinkSync(path); } catch { /* ignore */ }
      return this.acquire(repo, cmd);
    }

    const token = randomBytes(8).toString("hex");
    const data: LockData = {
      pid: process.pid,
      hostname: osHostname(),
      token,
      repo,
      startedAt: new Date().toISOString(),
      cmd,
    };
    const content = Buffer.from(JSON.stringify(data, null, 2), "utf8");
    writeSync(fd, content);
    closeSync(fd);

    let released = false;
    const doRelease = () => {
      if (released) return;
      released = true;
      // Token-verified release: only delete if we still own the lock.
      // Prevents A from deleting B's lock when A is evicted as stale while still running.
      try {
        const current = JSON.parse(readFileSync(path, "utf8")) as LockData;
        if (current.token !== token) return;
      } catch {
        return; // unreadable — assume gone
      }
      try { unlinkSync(path); } catch { /* ignore */ }
    };

    const sigintHandler = () => {
      doRelease();
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigtermHandler);
      process.kill(process.pid, "SIGINT");
    };
    const sigtermHandler = () => {
      doRelease();
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigtermHandler);
      process.kill(process.pid, "SIGTERM");
    };

    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigtermHandler);

    return () => {
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigtermHandler);
      doRelease();
    };
  }
}
