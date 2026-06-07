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
