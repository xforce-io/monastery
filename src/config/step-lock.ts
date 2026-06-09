// src/config/step-lock.ts — per-repo step lock (guardrail against accidental concurrent runs).
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

export interface LockData {
  pid: number;
  // Stable owner identity. pid alone collides across hosts/containers that share
  // ~/.monastery (NFS, devcontainers, multiple CI runners on one volume); host
  // disambiguates the machine and token proves "this lock is mine" on release.
  host: string;
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
  ) {
    super(`repo ${repo} is already being stepped by pid ${pid} since ${startedAt}`);
    this.name = "RepoLockError";
  }
}

// A lock whose holder is still "alive" but whose startedAt is older than this is
// treated as stale. Guards against pid reuse (a crashed run's pid handed to an
// unrelated process) and wedged runs. Set well above any plausible step duration.
const STALE_LOCK_MS = 12 * 60 * 60 * 1000; // 12h

function repoSlug(repo: string): string { return repo.replace(/\//g, "__"); }

function isAlive(pid: number): boolean {
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
   * pid is no longer running, or when its startedAt is older than STALE_LOCK_MS
   * (covers pid reuse and wedged runs).
   * When `force` is true, any existing lock is removed regardless of holder/age —
   * the displaced lock is logged, not removed silently.
   */
  acquire(repo: string, cmd = "", force = false): () => void {
    mkdirSync(join(this.root, "repos", repoSlug(repo)), { recursive: true });
    const path = this.lockPath(repo);

    // --force-stale-lock: unconditionally remove any existing lock before acquiring.
    // The escape hatch for pid-reuse false positives; warn loudly about what we displace.
    if (force) {
      try {
        const prev = JSON.parse(readFileSync(path, "utf8")) as LockData;
        console.warn(`[monastery] --force-stale-lock: removing existing lock held by pid ${prev.pid} (startedAt ${prev.startedAt})`);
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
      // Owner-aware liveness: a cross-host lock's pid is meaningless locally, so
      // process.kill would check an unrelated pid. Only trust local pid liveness
      // when the lock is from this host (or a legacy lock with no host, for
      // backward compat). Otherwise degrade to the age threshold alone.
      const sameHost = existing.host === undefined || existing.host === hostname();
      const live = sameHost ? isAlive(existing.pid) && !expired : !expired;
      if (live) {
        throw new RepoLockError(repo, existing.pid, existing.startedAt);
      }

      // Stale lock (dead pid, or alive but older than the threshold) — remove and retry
      try { unlinkSync(path); } catch { /* ignore */ }
      return this.acquire(repo, cmd);
    }

    const data: LockData = {
      pid: process.pid,
      host: hostname(),
      token: randomUUID(),
      repo,
      startedAt: new Date().toISOString(),
      cmd,
    };
    const content = Buffer.from(JSON.stringify(data, null, 2), "utf8");
    writeSync(fd, content);
    closeSync(fd);

    // Safe release: only delete the lock if it is still ours. Re-read and compare
    // the token before unlinking — if the file is gone or a different owner now
    // holds it (we were judged stale and displaced), this is a no-op. Prevents the
    // "A judged stale → B acquires → A's finally deletes B's lock" race.
    const doRelease = () => {
      try {
        const current = JSON.parse(readFileSync(path, "utf8")) as LockData;
        if (current.token !== data.token) return; // changed hands — not ours to delete
      } catch {
        return; // gone or unreadable — nothing of ours to release
      }
      try { unlinkSync(path); } catch { /* ignore */ }
    };

    // Signal cleanup: SIGINT/SIGTERM bypass try/finally, so without a handler the
    // lock would leak until the next run's stale check. Release on signal, then
    // re-raise with the default disposition so the process still terminates.
    const onSignal = (sig: NodeJS.Signals) => {
      release();
      process.kill(process.pid, sig);
    };
    const release = () => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      doRelease();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    return release;
  }
}
