// src/agents/maintainer.ts
import { z } from "zod";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue } from "../types.js";
import { ActionSchema, ActionsSchema, type Action } from "../shell/actions.js";
import { runStructuredAgent, type StructuredAgentSpec } from "./spec.js";
import { languageDirective } from "../shell/language.js";

/** What the maintainer agent gets to look at this tick (all GitHub-observable, read by the shell). */
export interface MaintainerInput {
  thesis: string;                                            // the repo's scope (.monastery/thesis.md)
  issue: Issue;                                              // the item: number, title, body, labels, state
  comments: { id: string; body: string; author: string }[]; // oldest-first; author = login (identity)
  /** State of monastery's PR for this issue (branch feat/<n>-<slug>), or null if none — so the agent
   *  doesn't re-propose `implement` when a patch PR is already open/awaiting the human's merge.
   *  When a PR exists, also includes full PR context so the agent sees human feedback left on the PR. */
  pr?: {
    branch: string;
    state: "open" | "merged" | "closed";
    url?: string;
    number?: number;
    title?: string;
    body?: string;
    isDraft?: boolean;
    comments?: { id: string; body: string; author: string }[];
    reviews?: { author: string; state: string; body: string }[];
    checks?: "pass" | "fail" | "pending";
  } | null;
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
  /** The rest of the open backlog (other issues, summarized) — so the PM can judge what's most worth doing now. */
  backlog?: { number: number; title: string; state: string; labels: string[] }[];
  /** #76: this repo's outward-text language — reply/panel/spec/proposal drafts must be written in it. */
  language?: string;
}

/** Accept either `{ "actions": [...] }` or a bare `[...]`. */
const BatchSchema = z.union([ActionsSchema, z.array(ActionSchema).transform((actions) => ({ actions }))]);

const PERSONA = [
  "You are monastery's maintainer agent for a GitHub repo — think of yourself as its PROJECT MANAGER.",
  "You have NO git/gh access. You read one item plus context and PROPOSE a list of actions; the thin shell executes the safe ones.",
  "Your only output is a fixed vocabulary of actions (below). You never run commands, never merge, never close.",
  "Safety is the shell's job, not yours: anything risky you may only PROPOSE — a human approves it.",
  // #108 — code access (read-only): the maintainer can now check the code before committing to heavy work.
  "CODE ACCESS: your working directory is a READ-ONLY checkout of THIS repo — open and read any file you need. Your edits to it are discarded (the shell never commits your checkout), so reading is free and safe; writing is pointless.",
  "VERIFY BEFORE IMPLEMENT: for a bug, you MUST confirm the root cause against the actual code before proposing `implement` — does the issue's stated cause actually hold? can you trace it? If it does NOT hold up against the code, do NOT propose implement: `reply` with what you found (cite files/lines), or `spec` the real, observable acceptance. An unverified hypothesis is not a spec, and 'fix this' for a non-bug just makes the patcher invent a change.",
  "DESIGN FROM CODE: base any `spec`/approach on what you actually read in the code, not on the issue's wording alone. Read only what you need to decide — for pure governance (reply/relabel/panel) you usually needn't read code at all.",
  // PM methodology — how to judge what's most worth doing now (the lever, not a script):
  "METHODOLOGY: you see THIS item plus the rest of the open <backlog>. Judge whether this item is among the MOST worth advancing now —",
  "weigh impact × readiness × cost; prefer unblocking dependencies; keep scope tight (one concrete deliverable, never a whole epic).",
  "The shell examines EVERY open item each tick, so deferring is safe — a lower-priority item comes back; you don't have to do everything now.",
  "If this item is the most worth advancing AND it's a single concrete change, propose `implement`. Otherwise do the light governance (relabel/reply/panel/spec) and let the heavy work wait for when it's clearly the right call.",
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

function buildPrBlock(pr: MaintainerInput["pr"]): string {
  if (!pr) return "monastery has no PR open for this issue.";
  const lines: string[] = [`branch: ${pr.branch}, state: ${pr.state}`];
  if (pr.url) lines.push(`url: ${pr.url}`);
  if (pr.number !== undefined) lines.push(`number: ${pr.number}`);
  if (pr.title) lines.push(`title: ${pr.title}`);
  if (pr.isDraft !== undefined) lines.push(`isDraft: ${pr.isDraft}`);
  if (pr.body) lines.push(`body: ${pr.body}`);
  if (pr.checks) lines.push(`checks: ${pr.checks}`);
  if (pr.comments?.length) {
    const commentLines = pr.comments.map((c) => `<pr-comment id="${c.id}" author="${c.author}">\n${c.body}\n</pr-comment>`).join("\n");
    lines.push(`<pr-comments>\n${commentLines}\n</pr-comments>`);
  } else {
    lines.push("(no PR comments)");
  }
  if (pr.reviews?.length) {
    const reviewLines = pr.reviews.map((r) => `<pr-review author="${r.author}" state="${r.state}">\n${r.body}\n</pr-review>`).join("\n");
    lines.push(`<pr-reviews>\n${reviewLines}\n</pr-reviews>`);
  }
  return lines.join("\n");
}

function buildContext(input: MaintainerInput): string {
  const { thesis, issue, comments, pr, deps, backlog, language } = input;
  const commentBlock = comments.length
    ? comments.map((c) => `<comment id="${c.id}" author="${c.author}">\n${c.body}\n</comment>`).join("\n")
    : "(no comments)";
  const prBlock = buildPrBlock(pr);
  const depBlock = deps && deps.length
    ? deps.map((d) => `- ${d.ref} [${d.state}] ${d.title}`).join("\n")
    : "(none)";
  const backlogBlock = backlog && backlog.length
    ? backlog.map((b) => `- #${b.number} ${b.title} [${b.state}]${b.labels.length ? " " + b.labels.join(",") : ""}`).join("\n")
    : "(no other open issues)";

  return [
    // #76: every outward write below (reply/panel/spec/proposal draft) must follow the repo's language policy.
    ...(language ? [languageDirective(language)] : []),
    `<thesis>\n${thesis}\n</thesis>`,
    `<issue number="${issue.number}" state="${issue.state}" labels="${issue.labels.join(", ")}">\ntitle: ${issue.title}\n\n${issue.body}\n</issue>`,
    `<backlog>\n${backlogBlock}\n</backlog>`,
    `<comments>\n${commentBlock}\n</comments>`,
    `<pr>\n${prBlock}\n</pr>`,
    `<upstream-dependencies>\n${depBlock}\n</upstream-dependencies>`,
    "DEPENDENCIES: an upstream issue marked [open] is NOT yet resolved — don't act as if it's done; wait or reflect that in a reply/panel. [closed] means it's resolved.",
    `<consensus>\n${consensusBlock(input)}\n</consensus>`,
    [
      "CONSENSUS (how things get agreed across parties): the shared SPEC is the acceptance contract — the real need + acceptance criteria + agreed approach.",
      "Co-author it with `spec` (list the `parties` who must agree — by default the issue's author and this repo's maintainers). Any edit bumps the version and invalidates prior endorsements.",
      "Each spec version MUST be the COMPLETE, self-contained design (full need + acceptance + approach) — a new version fully REPLACES the old, never a diff/增量 against it. Only the latest version is ever read (as the contract AND as what the patcher builds from), so a partial/delta version silently drops its own base.",
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
      `- {"kind":"implement","num":${issue.number},"draft":"<a short plan the human reviews>"} — PROPOSE implementing this issue. The shell posts a fresh approval comment with your draft + needs-approval; ONLY after a real human 👍 does the patcher write a sandbox fix and open a draft PR. You CANNOT self-approve (a spec/endorse you author never counts as the human's 👍). Propose this ONLY for a single, well-understood, concrete change worth doing now — NEVER for an epic / broad / tracking issue (see SCOPE below).`,
      `- {"kind":"rework","num":${issue.number},"draft":"<a short plan: what you'll change per the feedback>"} — PROPOSE updating monastery's OWN open draft PR for this issue from human feedback. Use this (NOT implement) when <pr> shows an open draft PR AND a human left feedback asking for changes. Like implement it is human-gated: after a 👍 the shell checks out the SAME branch, re-patches from the feedback, and updates the SAME PR (never a new one). Only propose rework when there is concrete human feedback to act on.`,
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
      "BEFORE proposing implement, check <pr>: if an OPEN draft PR already exists for this issue, do NOT propose implement again.",
      "Instead: if a human left feedback on it asking for changes -> propose `rework` (the shell updates the SAME PR); if there's no actionable feedback yet -> wait for the human to merge it, or reply/panel.",
      "If the PR is closed (rejected), treat that as a rejected implementation: without a human reason/comment explaining WHY it was rejected, do NOT propose implement again; reply/ask for the reason or wait.",
      "Once a human gives the reason, route by that reason: implementation wrong -> propose a new implement plan; spec/approach wrong -> revise spec; no longer wanted -> propose close.",
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
  sandbox: "readonly-clone",
  // #108: an investigating agent (reads code, then answers) occasionally finishes without writing the
  // artifact; give it 2 repair retries (capped) so one flaky run doesn't drop the item for the tick.
  policy: { failThreshold: 3, repairAttempts: 2 },
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
