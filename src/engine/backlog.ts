// src/engine/backlog.ts — project the maintainer's chosen actions into a backlog entry.
// Pure + deterministic: no LLM, no IO. See docs/design/82-backlog-snapshot.md.
import type { Action } from "../shell/actions.js";
import type { BacklogEntry, Priority } from "../types.js";

/** Actions that mean "this issue is being advanced this tick" (short of handing it to the patcher). */
const ADVANCING: ReadonlySet<string> = new Set(["spec", "endorse", "propose", "panel", "openDraftPR"]);

const BUCKET: Record<Priority, number> = { now: 0, soon: 1, later: 2, parked: 3 };

/** Derive a backlog entry from the maintainer's proposed actions (strongest signal wins). */
export function deriveEntry(
  issue: { number: number; title: string },
  actions: Action[],
  blockedBy: string[],
  fails: number,
): BacklogEntry {
  const kinds = actions.map((a) => a.kind);
  let priority: Priority;
  let rationale: string;
  if (kinds.includes("implement")) {
    priority = "now";
    rationale = "proposed implement → patcher";
  } else if (kinds.some((k) => ADVANCING.has(k))) {
    priority = "soon";
    rationale = `advancing: ${kinds.join(", ")}`;
  } else if (kinds.length) {
    priority = "later";
    rationale = `light governance: ${kinds.join(", ")}`;
  } else {
    priority = "later";
    rationale = "no action this tick";
  }
  const entry: BacklogEntry = { number: issue.number, title: issue.title, priority, rationale };
  if (blockedBy.length) entry.blockedBy = blockedBy;
  if (fails > 0) entry.fails = fails;
  return entry;
}

/** Stable deterministic order: bucket, then not-blocked, then fewer fails, then lower number. */
export function sortEntries(entries: BacklogEntry[]): BacklogEntry[] {
  return [...entries].sort((a, b) =>
    BUCKET[a.priority] - BUCKET[b.priority]
    || (a.blockedBy?.length ?? 0) - (b.blockedBy?.length ?? 0)
    || (a.fails ?? 0) - (b.fails ?? 0)
    || a.number - b.number,
  );
}
