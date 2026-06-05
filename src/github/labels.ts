// src/github/labels.ts
import type { MacroState } from "../types.js";

export const STATE_PREFIX = "monastery/state:";
export const stateLabel = (s: MacroState | string): string => `${STATE_PREFIX}${s}`;

/** Macro state = the single monastery/state:* label; absent => "new" (virtual new). */
export function macroStateOf(labels: string[]): MacroState {
  const hit = labels.find((l) => l.startsWith(STATE_PREFIX));
  return (hit ? hit.slice(STATE_PREFIX.length) : "new") as MacroState;
}

export const THESIS = { in: "thesis:in", out: "thesis:out", unclear: "thesis:unclear" } as const;
export const NEEDS_APPROVAL = "monastery:needs-approval";
export const APPROVED = "monastery:approved";
export const DECLINED = "monastery:declined";
export const HOLD = "monastery:hold";

export interface LabelDef { name: string; color: string; description: string; }

/** The label set monastery needs on a managed repo (created by `monastery init`). */
export const LABEL_DEFS: LabelDef[] = [
  { name: THESIS.in, color: "0E8A16", description: "in scope per the repo thesis" },
  { name: THESIS.out, color: "B60205", description: "out of scope per the repo thesis" },
  { name: THESIS.unclear, color: "FBCA04", description: "thesis does not decide" },
  { name: stateLabel("triaged"), color: "C5DEF5", description: "gate done, awaiting further handling" },
  { name: stateLabel("needs-approval"), color: "C5DEF5", description: "proposal awaiting human approval" },
  { name: stateLabel("done"), color: "C5DEF5", description: "monastery finished with this item" },
  { name: NEEDS_APPROVAL, color: "D93F0B", description: "monastery proposed an outward action; awaiting approval" },
  { name: APPROVED, color: "0E8A16", description: "human approved the proposal" },
  { name: DECLINED, color: "B60205", description: "human declined the proposal" },
  { name: HOLD, color: "5319E7", description: "pause monastery on this item" },
];
