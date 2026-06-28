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
 * is neither is `ready`. This is the single source the status/pending/blocked views filter on.
 */
export function entryStatus(entry: BacklogEntry): EntryStatus {
  if (entry.awaitingApproval) return "pending";
  if (entry.blockedBy && entry.blockedBy.length > 0) return "blocked";
  return "ready";
}

/** #176: entries partitioned by status. The single classification the status/pending/blocked views share. */
export interface StatusGroups {
  ready: BacklogEntry[];
  pending: BacklogEntry[];
  blocked: BacklogEntry[];
}

/**
 * #176: partition a (sorted) backlog list by status, preserving input order within each group. The
 * status view reads all groups; `pending`/`blocked` are just lenses onto one group each. Pure read —
 * no LLM, the basis for the zero-cost views.
 */
export function groupByStatus(entries: BacklogEntry[]): StatusGroups {
  const groups: StatusGroups = { ready: [], pending: [], blocked: [] };
  for (const e of entries) groups[entryStatus(e)].push(e);
  return groups;
}
