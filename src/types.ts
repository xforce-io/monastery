// src/types.ts

// Outcome of any step level (issue step / reconcile item).
export type WaitReason = "human" | "peer" | "ci";
export type Outcome =
  | { kind: "progressed"; note?: string }
  | { kind: "waiting"; on: WaitReason }
  | { kind: "done" }
  | { kind: "noop" };

// Per-repo reconcile tick result (L0).
export interface ReconcileResult {
  repo: string;
  advanced: number;
  waiting: { on: WaitReason; count: number }[];
  idle: boolean;
  nextPollMs: number;
}

// Coarse protocol state (PROTOCOL §1): all GitHub-observable. The shell stores no rich state.
export type ProtocolState = "active" | "awaiting-gate" | "terminal";

// An issue as the shell sees it (subset of GitHub's issue).
export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}

// Backlog snapshot (issue #82): maintainer-written, human-read, disposable. Derived
// deterministically from the maintainer's actions — see docs/design/82-backlog-snapshot.md.
export type Priority = "now" | "soon" | "later" | "parked";

export interface BacklogEntry {
  number: number;
  title: string;
  priority: Priority;
  rationale: string;
  blockedBy?: string[]; // open Depends-on refs
  fails?: number;       // consecutive maintainer-fail count
}

export interface BacklogSnapshot {
  generatedAt: string;
  repo: string;
  rankedOf: { ranked: number; open: number };
  entries: BacklogEntry[]; // already sorted
}
