// src/cli/status.ts
import type { Issue, ProtocolState, Outcome } from "../types.js";
import { NEEDS_APPROVAL, DECLINED } from "../github/labels.js";

/** Coarse protocol state from the control labels alone (PROTOCOL §1). */
export function protocolState(issue: Issue): ProtocolState {
  if (issue.state === "closed" || issue.labels.includes(DECLINED)) return "terminal";
  if (issue.labels.includes(NEEDS_APPROVAL)) return "awaiting-gate";
  return "active";
}

export interface StatusEntry {
  repo: string;
  number: number;
  title: string;
  state: ProtocolState;
  thesis: string | undefined;
  type: string | undefined;
}

export function toStatusEntry(repo: string, issue: Issue): StatusEntry {
  const thesisLabel = issue.labels.find((l) => l.startsWith("thesis:"));
  const thesis = thesisLabel ? thesisLabel.slice("thesis:".length) : undefined;
  const typeLabel = issue.labels.find((l) => l.startsWith("type:"));
  const type = typeLabel ? typeLabel.slice("type:".length) : undefined;
  return { repo, number: issue.number, title: issue.title, state: protocolState(issue), thesis, type };
}

export function formatStatus(entries: StatusEntry[]): string {
  return entries
    .map((e) => {
      const parts: string[] = [`${e.repo}#${e.number}`, e.title, `state:${e.state}`];
      if (e.thesis !== undefined) parts.push(`thesis:${e.thesis}`);
      if (e.type !== undefined) parts.push(`type:${e.type}`);
      return parts.join("  ");
    })
    .join("\n");
}

/** One-line human-readable explanation of a single-issue step Outcome (#88). */
export function explainOutcome(out: Outcome): string {
  switch (out.kind) {
    case "progressed": return out.note ? `progressed (${out.note})` : "progressed";
    case "waiting":    return out.on === "human" ? "awaiting your 👍 on the approval comment" : `waiting on ${out.on}`;
    case "done":       return "done (terminal)";
    case "noop":
      if (out.entry?.priority === "parked") return "awaiting your 👍 on the approval comment";
      if (out.entry?.rationale) return out.entry.rationale;
      return "nothing to do this tick";
  }
}
