// src/github/labels.ts
// PROTOCOL §2: the shell routes on exactly TWO control labels. Everything else is display
// (the agent maintains it for humans; the shell never routes on it). The v0 `monastery/state:*`
// rich-lifecycle labels are gone (collapsed into the maintainer agent — CONSTITUTION §8).

export const THESIS = { in: "thesis:in", out: "thesis:out", unclear: "thesis:unclear" } as const;

// --- control labels (the shell's, PROTOCOL §2) ---
export const NEEDS_APPROVAL = "monastery:needs-approval"; // a gated proposal is parked, awaiting a human signal
export const DECLINED = "monastery:declined";             // terminal: a proposal was declined
export const NEEDS_HUMAN = "monastery:needs-human";       // display: automation is blocked and needs operator help

export interface LabelDef { name: string; color: string; description: string; }

/** The label set monastery needs on a managed repo (created by `monastery init`). */
export const LABEL_DEFS: LabelDef[] = [
  // display labels the maintainer agent maintains for a human's at-a-glance read
  { name: THESIS.in, color: "0E8A16", description: "in scope per the repo thesis" },
  { name: THESIS.out, color: "B60205", description: "out of scope per the repo thesis" },
  { name: THESIS.unclear, color: "FBCA04", description: "thesis does not decide" },
  { name: "type:bug", color: "D73A4A", description: "something is broken" },
  { name: "type:feature", color: "A2EEEF", description: "a new capability or change request" },
  { name: "type:question", color: "D876E3", description: "a usage or clarification question" },
  // control labels the shell routes on
  { name: NEEDS_APPROVAL, color: "D93F0B", description: "monastery proposed an outward action; awaiting approval" },
  { name: DECLINED, color: "B60205", description: "human declined the proposal" },
  { name: NEEDS_HUMAN, color: "B60205", description: "monastery is blocked and needs a human to inspect" },
];
