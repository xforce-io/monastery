// src/cli/status.ts
import type { Issue } from "../types.js";
import {
  macroStateOf,
  NEEDS_APPROVAL,
  APPROVED,
  HOLD,
  TRY_FIX,
  PATCH_PROPOSED,
  NEEDS_HUMAN,
} from "../github/labels.js";

const ACTION_LABELS = [NEEDS_APPROVAL, APPROVED, TRY_FIX, PATCH_PROPOSED, NEEDS_HUMAN, HOLD];

export interface StatusEntry {
  number: number;
  title: string;
  state: string;
  thesis: string | undefined;
  type: string | undefined;
  actions: string[];
}

export function toStatusEntry(issue: Issue): StatusEntry {
  const state = macroStateOf(issue.labels);
  const thesisLabel = issue.labels.find((l) => l.startsWith("thesis:"));
  const thesis = thesisLabel ? thesisLabel.slice("thesis:".length) : undefined;
  const typeLabel = issue.labels.find((l) => l.startsWith("type:"));
  const type = typeLabel ? typeLabel.slice("type:".length) : undefined;
  const actions = issue.labels
    .filter((l) => (ACTION_LABELS as string[]).includes(l))
    .map((l) => l.slice("monastery:".length));
  return { number: issue.number, title: issue.title, state, thesis, type, actions };
}

export function formatStatus(issues: Issue[]): string {
  return issues
    .map((issue) => {
      const e = toStatusEntry(issue);
      const parts: string[] = [`#${e.number}`, e.title, `state:${e.state}`];
      if (e.thesis !== undefined) parts.push(`thesis:${e.thesis}`);
      if (e.type !== undefined) parts.push(`type:${e.type}`);
      parts.push(...e.actions);
      return parts.join("  ");
    })
    .join("\n");
}
