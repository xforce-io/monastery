// src/engine/run.ts
import type { BacklogEntry } from "../types.js";

/**
 * #176: where a backlog entry sits in the assess→run flow. `terminal` (declined/done) never appears
 * in the open backlog, so an open-list entry is one of these three.
 */
export type EntryStatus = "ready" | "pending" | "blocked";

/**
 * #176: classify a backlog entry for the status-bearing list. `pending` (awaiting the human's 👍)
 * takes precedence over `blocked` — the human's approval is the actionable next signal. An entry that
 * is neither is `ready` for `run` to consume. This is the single source the status/pending/blocked
 * views filter on and that `isRunnable` derives from.
 */
export function entryStatus(entry: BacklogEntry): EntryStatus {
  if (entry.awaitingApproval) return "pending";
  if (entry.blockedBy && entry.blockedBy.length > 0) return "blocked";
  return "ready";
}

/**
 * #176: a backlog entry is runnable by `run` only when it is `ready` — approved (no longer awaiting
 * the human's 👍) and not blocked by an open dependency. `run` consumes only runnable entries —
 * everything else stays put for the human (pending) or for its blockers to clear (blocked).
 */
export function isRunnable(entry: BacklogEntry): boolean {
  return entryStatus(entry) === "ready";
}
