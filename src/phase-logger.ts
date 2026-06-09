// src/phase-logger.ts — phase-level observability for `step` (issue #75).
//   One capture, two outlets from the SAME phase event (never recomputed):
//     A) log    — append-only event stream: human lines (stderr) + NDJSON (stdout, when json).
//     B) snapshot — overwrite-in-place small file: "where am I right now", read O(1) by `status`.
//   The snapshot is the materialized cache of the log's current state (snapshot ⊂ log).
import { renameSync, writeFileSync } from "node:fs";

export type PhaseStatus = "start" | "done" | "fail";

export type Meta = Record<string, string | number>;

export interface PhaseLoggerOpts {
  repo: string;
  issue: number;
  json: boolean;
  /** Wall clock, injected for testability. */
  now: () => number;
  /** Human line sink (stderr). Injected in tests; defaults to process.stderr. */
  err?: (line: string) => void;
  /** NDJSON event sink (stdout). Injected in tests; defaults to process.stdout. Only used when json. */
  out?: (line: string) => void;
  /** Sidecar snapshot path (outlet B). When unset (single-issue CLI / tests), no snapshot is written. */
  progressPath?: string;
}

export interface PhaseHandle {
  done(meta?: Meta): void;
  fail(reason: string, meta?: Meta): void;
}

function renderMeta(meta?: Meta): string {
  if (!meta) return "";
  const parts = Object.entries(meta).map(([k, v]) => `${k}=${v}`);
  return parts.length ? " " + parts.join(" ") : "";
}

/** Atomic overwrite: write a temp sibling then rename, so a concurrent reader never sees a half-written file. */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** Structural source for a PhaseLogger — StepCtx satisfies it, without phase-logger importing issue-step. */
export interface PhaseSource {
  repo: string;
  now: () => number;
  json?: boolean;
  progressPath?: string;
  logSink?: { err?: (line: string) => void; out?: (line: string) => void };
}

/** Build a PhaseLogger for one issue from a step source (repo/json/now/progress + injectable sinks). */
export function makePhaseLogger(src: PhaseSource, issue: number): PhaseLogger {
  return new PhaseLogger({
    repo: src.repo, issue, json: src.json ?? false, now: src.now,
    progressPath: src.progressPath, err: src.logSink?.err, out: src.logSink?.out,
  });
}

export class PhaseLogger {
  constructor(private opts: PhaseLoggerOpts) {}

  private err(line: string): void {
    (this.opts.err ?? ((l: string) => process.stderr.write(l + "\n")))(line);
  }

  private out(line: string): void {
    (this.opts.out ?? ((l: string) => process.stdout.write(l + "\n")))(line);
  }

  /** Emit one phase boundary to both outlets from the same event. */
  private emit(phase: string, status: PhaseStatus, start: number, meta?: Meta): void {
    const { repo, issue, json, progressPath } = this.opts;
    const ts = status === "start" ? start : this.opts.now();
    const durationMs = status === "start" ? undefined : ts - start;
    const elapsed = durationMs === undefined ? null : `${(durationMs / 1000).toFixed(1)}s`;

    // Outlet A — human line (stderr), always.
    const head = `[monastery] ${repo}#${issue} ${phase}:${status}`;
    this.err(elapsed === null ? `${head}${renderMeta(meta)}` : `${head} ${elapsed}${renderMeta(meta)}`);

    // Outlet A — NDJSON event (stdout), only when json.
    if (json) {
      const evt: Record<string, unknown> = { ts, repo, issue, phase, status };
      if (durationMs !== undefined) evt.durationMs = durationMs;
      this.out(JSON.stringify({ ...evt, ...(meta ?? {}) }));
    }

    // Outlet B — snapshot (overwrite), when a sidecar path is configured. Best-effort: a snapshot write
    // failure is swallowed — observability must never crash the step it observes.
    if (progressPath) {
      try {
        atomicWrite(progressPath, JSON.stringify({ issue, phase, status, since: start, pid: process.pid, ...(meta ?? {}) }));
      } catch { /* best effort */ }
    }
  }

  phase(name: string, meta?: Meta): PhaseHandle {
    const start = this.opts.now();
    this.emit(name, "start", start, meta);
    return {
      done: (m?: Meta) => this.emit(name, "done", start, m),
      fail: (reason: string, m?: Meta) => this.emit(name, "fail", start, { reason, ...(m ?? {}) }),
    };
  }
}
