// src/cli/status.ts
import { readFileSync } from "node:fs";
import type { Issue, ProtocolState, Outcome } from "../types.js";
import { NEEDS_APPROVAL, DECLINED } from "../github/labels.js";

/** Coarse protocol state from the control labels alone (PROTOCOL §1). */
export function protocolState(issue: Issue): ProtocolState {
  if (issue.state === "closed" || issue.labels.includes(DECLINED)) return "terminal";
  if (issue.labels.includes(NEEDS_APPROVAL)) return "awaiting-gate";
  return "active";
}

/** The per-repo phase-progress snapshot written by PhaseLogger (issue #75, outlet B). */
export interface ProgressSnapshot {
  issue: number;
  phase: string;
  status: string;
  since: number;
  pid: number;
  attempt?: string;
  reason?: string;
}

/** Read the per-repo progress sidecar (issue #75, outlet B). null when absent/unreadable/corrupt. */
export function readProgress(path: string): ProgressSnapshot | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProgressSnapshot;
  } catch {
    return null;
  }
}

/** Progress overlaid onto a StatusEntry for the issue currently being stepped. */
export interface ProgressView {
  phase: string;
  attempt: string | undefined;
  elapsedMs: number;
  stale: boolean;
  status: string;
  reason: string | undefined;
}

export interface StatusEntry {
  repo: string;
  number: number;
  title: string;
  state: ProtocolState;
  thesis: string | undefined;
  type: string | undefined;
  /** #75: live phase progress for the issue being stepped right now (the snapshot's matching issue). */
  progress?: ProgressView;
}

/** Humanize a duration: under a minute -> "Ns", otherwise "Mm Ss" (no zero-pad, e.g. 4m12s). */
export function humanizeElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/**
 * #75: overlay a per-repo progress snapshot onto a status entry. No-op unless the snapshot is for THIS
 * issue. A dead holder pid (alive=false) marks the view stale — a fail snapshot is then a tombstone that
 * still carries why it died. The caller supplies `alive` (StepLock.isAlive on snap.pid) and `now`.
 */
export function enrichWithProgress(
  entry: StatusEntry,
  snap: ProgressSnapshot | null,
  opts: { now: number; alive: boolean },
): StatusEntry {
  if (!snap || snap.issue !== entry.number) return entry;
  // A dead holder whose last event was a clean `done` is a finished run's leftover, not in-progress work —
  // don't surface it (avoids reporting "still running" forever; no sidecar deletion needed). A dead holder
  // mid-phase (start) or a fail tombstone IS surfaced, marked stale, so a crash/timeout stays visible.
  if (!opts.alive && snap.status === "done") return entry;
  return {
    ...entry,
    progress: {
      phase: snap.phase,
      attempt: snap.attempt,
      elapsedMs: opts.now - snap.since,
      stale: !opts.alive,
      status: snap.status,
      reason: snap.reason,
    },
  };
}

export function toStatusEntry(repo: string, issue: Issue): StatusEntry {
  const thesisLabel = issue.labels.find((l) => l.startsWith("thesis:"));
  const thesis = thesisLabel ? thesisLabel.slice("thesis:".length) : undefined;
  const typeLabel = issue.labels.find((l) => l.startsWith("type:"));
  const type = typeLabel ? typeLabel.slice("type:".length) : undefined;
  return { repo, number: issue.number, title: issue.title, state: protocolState(issue), thesis, type };
}

export function formatStatus(entries: StatusEntry[]): string {
  return entries
    .map((e) => {
      const parts: string[] = [`${e.repo}#${e.number}`, e.title, `state:${e.state}`];
      if (e.thesis !== undefined) parts.push(`thesis:${e.thesis}`);
      if (e.type !== undefined) parts.push(`type:${e.type}`);
      if (e.progress) {
        const pg = e.progress;
        const bits = [`phase=${pg.phase}`];
        if (pg.attempt) bits.push(`attempt=${pg.attempt}`);
        bits.push(`elapsed=${humanizeElapsed(pg.elapsedMs)}`);
        if (pg.stale) bits.push(pg.reason ? `stale(${pg.reason})` : "stale");
        parts.push(bits.join(" "));
      }
      return parts.join("  ");
    })
    .join("\n");
}

/** One-line human-readable explanation of a single-issue step Outcome (#88). */
export function explainOutcome(out: Outcome): string {
  switch (out.kind) {
    case "progressed": return out.note ? `progressed (${out.note})` : "progressed";
    case "waiting":    return out.on === "human" ? "awaiting your 👍 on the approval comment" : `waiting on ${out.on}`;
    case "done":       return "done (terminal)";
    case "noop":
      if (out.entry?.priority === "parked") return "awaiting your 👍 on the approval comment";
      if (out.entry?.rationale) return out.entry.rationale;
      return "nothing to do this tick";
  }
}
