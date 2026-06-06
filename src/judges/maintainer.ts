// src/judges/maintainer.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue } from "../types.js";
import { ActionSchema, ActionsSchema, type Action } from "../shell/actions.js";

/** What the maintainer agent gets to look at this tick (all GitHub-observable, read by the shell). */
export interface MaintainerInput {
  thesis: string;                              // the repo's scope (.monastery/thesis.md)
  issue: Issue;                                // the item: number, title, body, labels, state
  comments: { id: string; body: string }[];   // all comments oldest-first; human ones carry NO marker
  /** State of monastery's PR for this issue (branch feat/<n>-<slug>), or null if none — so the agent
   *  doesn't re-propose `implement` when a patch PR is already open/awaiting the human's merge. */
  pr?: { branch: string; state: "open" | "merged" | "closed" } | null;
}

/** Accept either `{ "actions": [...] }` or a bare `[...]`. */
const BatchSchema = z.union([ActionsSchema, z.array(ActionSchema).transform((actions) => ({ actions }))]);

const PERSONA = [
  "You are monastery's maintainer agent for a GitHub repo.",
  "You have NO git/gh access. You read one item plus context and PROPOSE a list of actions; the thin shell executes the safe ones.",
  "Your only output is a fixed vocabulary of actions (below). You never run commands, never merge, never close.",
  "Safety is the shell's job, not yours: anything risky you may only PROPOSE — a human approves it.",
].join(" ");

/**
 * The keystone reasoning of v2: given an item + context, return the SAFE actions to propose.
 * Replaces the thesis-gate + triager judges with one agent (CONSTITUTION §8). Returns the validated
 * `Action[]` (possibly empty = nothing to do), or null when the agent produced no schema-valid output
 * (the engine treats null as a transient failure to retry/escalate — same contract as the old judges).
 */
export async function maintainer(
  provider: AgentProvider,
  model: string,
  input: MaintainerInput,
  artifactDir: string,
): Promise<Action[] | null> {
  const { thesis, issue, comments, pr } = input;
  const commentBlock = comments.length
    ? comments.map((c) => `<comment id="${c.id}">\n${c.body}\n</comment>`).join("\n")
    : "(no comments)";
  const prBlock = pr
    ? `monastery's PR for this issue: branch ${pr.branch}, state ${pr.state}.`
    : "monastery has no PR open for this issue.";

  const context = [
    `<thesis>\n${thesis}\n</thesis>`,
    `<issue number="${issue.number}" state="${issue.state}" labels="${issue.labels.join(", ")}">\ntitle: ${issue.title}\n\n${issue.body}\n</issue>`,
    `<comments>\n${commentBlock}\n</comments>`,
    `<pr>\n${prBlock}\n</pr>`,
    [
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
      `- {"kind":"implement","num":${issue.number}} — hand the issue to monastery's patcher: it writes a fix in a sandbox and opens a draft PR for a human to merge. Propose this only when the issue is well-understood and worth fixing now.`,
    ].join("\n"),
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

  const res = await provider.run({ persona: PERSONA, context, artifactDir, model });

  // 1. primary: the agent wrote actions.json
  const p = join(artifactDir, "actions.json");
  if (existsSync(p)) {
    const fromFile = parseActions(readFileSync(p, "utf8"));
    if (fromFile) return fromFile;
  }
  // 2. fallback: the agent printed the batch to stdout instead of writing the file
  if (res.resultText) {
    const fromText = extractActions(res.resultText);
    if (fromText) return fromText;
  }
  return null;
}

/** Parse one JSON string into a validated Action[] (object-wrapped or bare array), or null. */
function parseActions(raw: string): Action[] | null {
  const parsed = BatchSchema.safeParse(safeJson(raw));
  return parsed.success ? parsed.data.actions : null;
}

/** Pull a schema-valid batch out of free-form text (fenced JSON, prose-wrapped object/array, or bare). */
function extractActions(text: string): Action[] | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) candidates.push(arr[0]);
  candidates.push(text);
  for (const c of candidates) {
    const got = parseActions(c);
    if (got) return got;
  }
  return null;
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }
