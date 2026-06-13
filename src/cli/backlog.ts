// src/cli/backlog.ts — render a backlog snapshot (issue #82) for humans.
import type { BacklogSnapshot } from "../types.js";

export interface MissingBacklog {
  repo: string;
  error: "missing_backlog_snapshot";
  tracked: boolean;
  hint: string;
}

export function formatBacklog(s: BacklogSnapshot): string {
  const header = `${s.repo} — backlog (ranked ${s.rankedOf.ranked} of ${s.rankedOf.open} open, @ ${s.generatedAt})`;
  const lines = s.entries.map((e) => {
    const parts = [`  [${e.priority}]`, `#${e.number}`, e.title, `— ${e.rationale}`];
    if (e.blockedBy?.length) parts.push(`(blocked: ${e.blockedBy.join(", ")})`);
    if (e.fails) parts.push(`(fails: ${e.fails})`);
    return parts.join(" ");
  });
  return [header, ...lines].join("\n");
}

export function missingBacklog(repo: string, tracked: boolean): MissingBacklog {
  const hint = tracked
    ? `run monastery backlog --repo ${repo} to create the first backlog snapshot`
    : `run monastery repos add ${repo}, then monastery backlog --repo ${repo}`;
  return { repo, error: "missing_backlog_snapshot", tracked, hint };
}

export function formatMissingBacklog(m: MissingBacklog): string {
  const why = m.tracked ? "has no backlog snapshot yet" : "is not tracked or has no backlog snapshot";
  return `${m.repo} — ${why}; ${m.hint}`;
}

export interface PendingItem { repo: string; number: number; title: string; approvalKind?: string; approvalCommentId: string }

/** Render the LIVE awaiting-approval list (from a full GitHub scan via pendingApprovals — not the batched
 *  snapshot, so it never misses items past MAX_ITEMS_PER_TICK nor goes stale), each with a direct 👍 link (#90). */
export function formatPending(items: PendingItem[]): string {
  if (!items.length) return "nothing awaiting your approval 🎉";
  const lines = items.map((e) => {
    const link = `https://github.com/${e.repo}/issues/${e.number}#issuecomment-${e.approvalCommentId}`;
    return `  ⏳ #${e.number} ${e.title} [${e.approvalKind ?? "approval"}] (${e.repo})\n     👍 here: ${link}`;
  });
  return [`awaiting your 👍 (${items.length}):`, ...lines].join("\n");
}
