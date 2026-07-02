// src/types.ts

// Outcome of any step level (issue step / reconcile item).
export type WaitReason = "human" | "peer" | "ci";
export type Outcome = (
  | { kind: "progressed"; note?: string }
  | { kind: "partial"; warning: string; applied: number; failed: number }
  | { kind: "waiting"; on: WaitReason }
  | { kind: "done" }
  | { kind: "failed"; error: string }
  | { kind: "noop" }
) & {
  entry?: BacklogEntry;
  // #86: set by awaitingGate under ctx.deferImplement — an approved implement gate that the tick scheduler
  // should run at most one of. reconcile collects these and runs only the backlog-top one this tick.
  readyImplement?: boolean;
  // #192: this tick's content fingerprint of the exact maintainer input. Transient transport: assess collects
  // it and persists it onto the backlog snapshot entry, so a later pass can skip an unchanged issue's LLM.
  fingerprint?: string;
};

// Per-repo reconcile tick result (L0).
export interface ReconcileResult {
  repo: string;
  advanced: number;
  failed: number;
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
  /** GitHub issue updated_at as epoch ms. Used for read-only backlog snapshot freshness. */
  updatedAt?: number;
}

// Backlog snapshot (issue #82/#140): local, human-read, disposable. Refreshed by the read-only
// backlog triage path, not by step/reconcile/issueStep governance actions.
export type Priority = "now" | "soon" | "later" | "parked";

export interface BacklogEntry {
  number: number;
  title: string;
  priority: Priority;
  rationale: string;
  blockedBy?: string[]; // open Depends-on refs
  fails?: number;       // consecutive maintainer-fail count
  // #90: an item blocked on the human's 👍. Kept at high priority (not sunk to parked) and tagged so
  // `monastery pending` can list it with a direct link to the exact comment to react on.
  awaitingApproval?: boolean;
  approvalKind?: string;        // "implement" | "rework" | "close" | "merge" | "decline"
  approvalCommentId?: string;   // the approval comment id — for the direct 👍 link
  // #192: the maintainer-input fingerprint as of the last assessment of this issue. PURE cost cache — a
  // missing/stale value only forces a full re-assess, never affects correctness or any terminal state.
  inputFingerprint?: string;
}

export interface BacklogSnapshot {
  generatedAt: string;
  repo: string;
  fingerprint?: string;
  rankedOf: { ranked: number; open: number };
  entries: BacklogEntry[]; // already sorted
}
