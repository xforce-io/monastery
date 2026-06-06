// src/agents/patcher.ts — the patcher's unified definition (its run loop lives in src/engine/patch.ts).
// A workspace-mutating agent: it edits files in a sandbox clone; the shell reads the diff, self-reviews,
// and opens a HUMAN-GATED draft PR. The agent never touches git/gh (CONSTITUTION §3).
import type { WorkspaceAgentSpec } from "./spec.js";

const PERSONA = [
  "You are monastery's patcher.",
  "Fix the described GitHub issue by editing files in this repository, then run the test suite.",
  "Do NOT touch git or gh — leave your changes in the working tree.",
  "Make the smallest correct change.",
].join(" ");

const FIX_PERSONA = [
  "You are monastery's patcher, addressing review feedback.",
  "A reviewer flagged BLOCKING issues in your last change. Fix every one by editing files in this repository, then stop.",
  "Do NOT touch git or gh — leave your changes in the working tree.",
  "Make the smallest correct change that resolves every blocking item.",
].join(" ");

export const patcherSpec: WorkspaceAgentSpec = {
  name: "patcher",
  role: "Write a fix for an issue in a sandbox clone; the shell self-reviews and opens a draft PR.",
  persona: PERSONA,
  fixPersona: FIX_PERSONA,
  sandbox: "workspace-clone",
  // failThreshold: consecutive no-change attempts before escalating; maxIters: self-review rounds.
  policy: { failThreshold: 3, maxIters: 3 },
};
