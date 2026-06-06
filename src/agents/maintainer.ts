// src/agents/maintainer.ts
import { z } from "zod";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue } from "../types.js";
import { ActionSchema, ActionsSchema, type Action } from "../shell/actions.js";
import { runStructuredAgent, type StructuredAgentSpec } from "./spec.js";

/** What the maintainer agent gets to look at this tick (all GitHub-observable, read by the shell). */
export interface MaintainerInput {
  thesis: string;                                            // the repo's scope (.monastery/thesis.md)
  issue: Issue;                                              // the item: number, title, body, labels, state
  comments: { id: string; body: string; author: string }[]; // oldest-first; author = login (identity)
  /** State of monastery's PR for this issue (branch feat/<n>-<slug>), or null if none — so the agent
   *  doesn't re-propose `implement` when a patch PR is already open/awaiting the human's merge. */
  pr?: { branch: string; state: "open" | "merged" | "closed" } | null;
  /** Cross-repo upstream issues this one declares (`Depends-on:`), with their current state (read-only). */
  deps?: { ref: string; state: "open" | "closed"; title: string }[];
  /** This monastery instance's own login — so the agent knows who it is and whether IT has endorsed. */
  self?: string;
  /** Multi-party consensus state (#48): the current shared spec, who endorsed it, and whether it's unanimous. */
  consensus?: {
    spec: { version: number; parties: string[]; body: string } | null;
    endorsedCurrent: string[];
    reached: boolean;
  };
}

/** Accept either `{ "actions": [...] }` or a bare `[...]`. */
const BatchSchema = z.union([ActionsSchema, z.array(ActionSchema).transform((actions) => ({ actions }))]);

const PERSONA = [
  "You are monastery's maintainer agent for a GitHub repo.",
  "You have NO git/gh access. You read one item plus context and PROPOSE a list of actions; the thin shell executes the safe ones.",
  "Your only output is a fixed vocabulary of actions (below). You never run commands, never merge, never close.",
  "Safety is the shell's job, not yours: anything risky you may only PROPOSE — a human approves it.",
].join(" ");

function consensusBlock(input: MaintainerInput): string {
  const c = input.consensus;
  if (!c || !c.spec) return `you are ${input.self ?? "(unknown)"}. No shared spec yet — author one with the \`spec\` action when the need is clear.`;
  const lines = [
    `you are ${input.self ?? "(unknown)"}.`,
    `current spec v${c.spec.version}, parties: ${c.spec.parties.join(", ")}.`,
    `endorsed v${c.spec.version}: ${c.endorsedCurrent.join(", ") || "(none)"}.`,
    `consensus reached: ${c.reached}.`,
    `--- spec body ---\n${c.spec.body}`,
  ];
  return lines.join("\n");
}

function buildContext(input: MaintainerInput): string {
  const { thesis, issue, comments, pr, deps } = input;
  const commentBlock = comments.length
    ? comments.map((c) => `<comment id="${c.id}" author="${c.author}">\n${c.body}\n</comment>`).join("\n")
    : "(no comments)";
  const prBlock = pr
    ? `monastery's PR for this issue: branch ${pr.branch}, state ${pr.state}.`
    : "monastery has no PR open for this issue.";
  const depBlock = deps && deps.length
    ? deps.map((d) => `- ${d.ref} [${d.state}] ${d.title}`).join("\n")
    : "(none)";

  return [
    `<thesis>\n${thesis}\n</thesis>`,
    `<issue number="${issue.number}" state="${issue.state}" labels="${issue.labels.join(", ")}">\ntitle: ${issue.title}\n\n${issue.body}\n</issue>`,
    `<comments>\n${commentBlock}\n</comments>`,
    `<pr>\n${prBlock}\n</pr>`,
    `<upstream-dependencies>\n${depBlock}\n</upstream-dependencies>`,
    "DEPENDENCIES: an upstream issue marked [open] is NOT yet resolved — don't act as if it's done; wait or reflect that in a reply/panel. [closed] means it's resolved.",
    `<consensus>\n${consensusBlock(input)}\n</consensus>`,
    [
      "CONSENSUS (how things get agreed across parties): the shared SPEC is the acceptance contract — the real need + acceptance criteria + agreed approach.",
      "Co-author it with `spec` (list the `parties` who must agree — by default the issue's author and this repo's maintainers). Any edit bumps the version and invalidates prior endorsements.",
      "When the CURRENT spec satisfies your party's need, `endorse` its version. When consensus is reached (every party endorsed the current version), the party that should do the work may `propose implement`.",
      "Don't keep talking once consensus holds — converge, don't compromise.",
    ].join(" "),
    [
      "IDENTITY: each comment shows its `author` (GitHub login) — use it to address people by who they are.",
      "MARKERS: monastery's own comments/panels carry an HTML marker (`<!--monastery-...-->`); human comments have NONE.",
      "Only `reply` to human (unmarked) comments. Never reply to your own marked comments — that is talking to yourself.",
    ].join(" "),
    [
      "LABELS: the shell owns control labels (`monastery:needs-approval`, `monastery:declined`) — never touch them.",
      "You MAY maintain display labels (e.g. `type:bug`, `thesis:in`) via `relabel` so a human sees the state at a glance.",
    ].join(" "),
    [
      "ACTION VOCABULARY — propose any number, in order:",
      `- {"kind":"reply","num":${issue.number},"toCommentId":"<id>","body":"<text>"} — reply to a human comment.`,
      `- {"kind":"relabel","num":${issue.number},"add":["<label>"],"remove":["<label>"]} — maintain display labels.`,
      `- {"kind":"panel","num":${issue.number},"body":"<markdown>"} — upsert the single sticky status panel.`,
      `- {"kind":"openDraftPR","num":${issue.number},"branch":"feat/${issue.number}-<slug>","title":"<t>","body":"<b>"} — open an EMPTY draft PR from an existing branch.`,
      `- {"kind":"propose","num":${issue.number},"proposal":"close"|"merge","draft":"<markdown the human will see>"} — ask a human to approve a risky, irreversible action.`,
      `- {"kind":"implement","num":${issue.number}} — hand the issue to monastery's patcher: it writes a fix in a sandbox and opens a draft PR for a human to merge. Propose this ONLY for a single, well-understood, concrete change worth doing now — NEVER for an epic / broad / tracking issue (see SCOPE below).`,
      `- {"kind":"spec","num":${issue.number},"body":"<the acceptance contract>","parties":["<login>", ...]} — author/revise the shared spec.`,
      `- {"kind":"endorse","num":${issue.number},"version":<N>} — record that your party agrees to spec version N.`,
    ].join("\n"),
    [
      "SCOPE (when implement is the WRONG move): do NOT propose implement for an epic / broad / pure-tracking issue —",
      "one that bundles many changes, sets a direction/north-star, or tracks work rather than naming a single concrete deliverable.",
      "Handing such an issue to the patcher produces a meaningless PR. Instead: break it down, discuss it, or `spec` ONE specific sub-request,",
      "and only implement once a single, well-scoped, deliverable change is clearly identified.",
    ].join(" "),
    [
      "BEFORE proposing implement, check <pr>: if a PR is already open for this issue, do NOT propose implement again —",
      "wait for the human to merge it, or reply/panel. If the PR is closed (rejected), reconsider (e.g. propose close or a different approach).",
    ].join(" "),
    [
      `Write ONLY the file actions.json with this exact shape and nothing else:`,
      `{ "actions": [ <action>, ... ] }`,
      `Use an empty list ({ "actions": [] }) when there is nothing to do this tick. Do not invent action kinds or fields.`,
    ].join("\n"),
  ].join("\n\n");
}

/**
 * The keystone reasoning of v2: read an item + context, propose actions (CONSTITUTION §8 — replaces the
 * thesis-gate + triager judges with one agent). The spec IS the maintainable definition; behavior runs
 * through the shared runner.
 */
export const maintainerSpec: StructuredAgentSpec<MaintainerInput, { actions: Action[] }> = {
  name: "maintainer",
  role: "Read one open item + its context and propose the governance actions to take this tick.",
  persona: PERSONA,
  sandbox: "artifact-only",
  policy: { failThreshold: 3 },
  artifact: "actions.json",
  schema: BatchSchema,
  buildContext,
};

/** Thin wrapper: returns the validated `Action[]` (possibly empty), or null on no schema-valid output. */
export async function maintainer(
  provider: AgentProvider,
  model: string,
  input: MaintainerInput,
  artifactDir: string,
): Promise<Action[] | null> {
  const out = await runStructuredAgent(maintainerSpec, input, { provider, model, artifactDir });
  return out ? out.actions : null;
}
