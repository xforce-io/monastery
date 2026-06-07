// src/cli/backlog.ts — render a backlog snapshot (issue #82) for humans.
import type { BacklogSnapshot } from "../types.js";

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

/** Render only the items awaiting the human's 👍, each with a direct link to the comment to react on (#90). */
export function formatPending(s: BacklogSnapshot): string {
  const pending = s.entries.filter((e) => e.awaitingApproval);
  if (!pending.length) return `${s.repo} — nothing awaiting your approval 🎉`;
  const lines = pending.map((e) => {
    const link = e.approvalCommentId
      ? `https://github.com/${s.repo}/issues/${e.number}#issuecomment-${e.approvalCommentId}`
      : `https://github.com/${s.repo}/issues/${e.number}`;
    return `  ⏳ #${e.number} ${e.title} [${e.approvalKind ?? "approval"}]\n     👍 here: ${link}`;
  });
  return [`${s.repo} — awaiting your 👍 (${pending.length}):`, ...lines].join("\n");
}
