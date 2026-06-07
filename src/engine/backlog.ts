// src/engine/backlog.ts — project the maintainer's chosen actions into a backlog entry.
// Pure + deterministic: no LLM, no IO. See docs/design/82-backlog-snapshot.md.
import type { Action } from "../shell/actions.js";
import type { BacklogEntry, Priority } from "../types.js";

/** Actions that mean "this issue is being advanced this tick" (short of handing it to the patcher). */
const ADVANCING: ReadonlySet<string> = new Set(["spec", "endorse", "propose", "panel", "openDraftPR"]);

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
