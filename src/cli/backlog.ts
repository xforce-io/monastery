// src/cli/backlog.ts — render a backlog snapshot (issue #82) for humans.
import type { BacklogSnapshot, BacklogEntry } from "../types.js";
import { STATUS_GLYPH } from "../shell/messages.js";
import { humanizeElapsed, type ProgressView } from "./status.js";

export interface MissingBacklog {
  repo: string;
  error: "missing_backlog_snapshot";
  tracked: boolean;
  hint: string;
}

export interface BacklogRepoError {
  repo: string;
  error: "backlog_refresh_failed";
  message: string;
}

export function formatBacklog(
  s: BacklogSnapshot,
  opts?: { progress?: { issue: number; view: ProgressView }; failThreshold?: number },
): string {
  const header = `${s.repo} — backlog (ranked ${s.rankedOf.ranked} of ${s.rankedOf.open} open, @ ${s.generatedAt})`;
  const lines = s.entries.map((e) => {
    const parts = [`  [${e.priority}]`, `#${e.number}`, e.title, `— ${e.rationale}`];
    if (e.blockedBy?.length) parts.push(`(blocked: ${e.blockedBy.join(", ")})`);
    if (e.fails) parts.push(`(fails: ${e.fails})`);
    const view = opts?.progress?.issue === e.number ? opts.progress.view : undefined;
    const hint = rowHint(s.repo, e, { progress: view, failThreshold: opts?.failThreshold });
    if (hint) parts.push(`→ ${hint.text}${hint.url ? ` ${hint.url}` : ""}`);
    return parts.join(" ");
  });
  return [header, ...lines].join("\n");
}

export interface BacklogJsonEntry extends BacklogEntry { nextHint?: string; nextHintUrl?: string }

/** #175: the snapshot decorated with per-row next-step hints for `--json` consumers. */
export function backlogJsonView(
  s: BacklogSnapshot,
  opts?: { progress?: { issue: number; view: ProgressView }; failThreshold?: number },
): BacklogSnapshot & { entries: BacklogJsonEntry[] } {
  const entries = s.entries.map((e): BacklogJsonEntry => {
    const view = opts?.progress?.issue === e.number ? opts.progress.view : undefined;
    const hint = rowHint(s.repo, e, { progress: view, failThreshold: opts?.failThreshold });
    if (!hint) return e;
    return { ...e, nextHint: hint.text, ...(hint.url ? { nextHintUrl: hint.url } : {}) };
  });
  return { ...s, entries };
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

export function formatBacklogRepoError(e: BacklogRepoError): string {
  return `${e.repo} — backlog refresh failed: ${e.message}`;
}

export interface RowHint { text: string; url?: string }

const DEFAULT_FAIL_THRESHOLD = 3;

/** #175: the one terminal "next step" for a backlog row, by priority stale > gate > blocked > fails.
 *  Deterministic, zero-LLM, derived only from fields already on the entry (+ optional live progress for
 *  THIS entry, matched by the caller). null when the row needs nothing from the human right now. */
export function rowHint(
  repo: string,
  e: BacklogEntry,
  opts?: { progress?: ProgressView; failThreshold?: number },
): RowHint | null {
  const progress = opts?.progress;
  const failThreshold = opts?.failThreshold ?? DEFAULT_FAIL_THRESHOLD;
  if (progress?.stale) {
    return { text: `进度陈旧 ${humanizeElapsed(progress.elapsedMs)},先 ps ${progress.pid}` };
  }
  if (e.approvalCommentId) {
    return {
      text: `等你 👍(${e.approvalKind ?? "approval"})`,
      url: `https://github.com/${repo}/issues/${e.number}#issuecomment-${e.approvalCommentId}`,
    };
  }
  if (e.blockedBy?.length) {
    return { text: `等 ${e.blockedBy.join(", ")}` };
  }
  if (e.fails && e.fails >= failThreshold) {
    return { text: `连败 ${e.fails} 次,可能要你看看` };
  }
  return null;
}

export interface PendingItem { repo: string; number: number; title: string; approvalKind?: string; approvalCommentId: string }

/** Render the LIVE awaiting-approval list (from a full GitHub scan via pendingApprovals — not the batched
 *  snapshot, so it never misses items past MAX_ITEMS_PER_TICK nor goes stale), each with a direct 👍 link (#90). */
export function formatPending(items: PendingItem[]): string {
  if (!items.length) return "nothing awaiting your approval 🎉";
  const lines = items.map((e) => {
    const link = `https://github.com/${e.repo}/issues/${e.number}#issuecomment-${e.approvalCommentId}`;
    return `  ${STATUS_GLYPH["awaiting-approval"]} #${e.number} ${e.title} [${e.approvalKind ?? "approval"}] (${e.repo})\n     👍 here: ${link}`;
  });
  return [`awaiting your 👍 (${items.length}):`, ...lines].join("\n");
}
