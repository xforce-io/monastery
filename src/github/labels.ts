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
