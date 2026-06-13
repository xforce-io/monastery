// src/agents/backlog.ts — read-only repo-level backlog triage (#140).
import { z } from "zod";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue, Priority } from "../types.js";
import { runStructuredAgent, type StructuredAgentSpec } from "./spec.js";
import { languageDirective } from "../shell/language.js";

export interface BacklogTriageInput {
  repo: string;
  thesis: string;
  issues: Issue[];
  language?: string;
}

export interface BacklogTriageOutput {
  entries: {
    number: number;
    priority: Priority;
    rationale: string;
    blockedBy?: string[];
  }[];
}

const PrioritySchema = z.enum(["now", "soon", "later", "parked"]);
const EntrySchema = z.object({
  number: z.number().int().positive(),
  priority: PrioritySchema,
  rationale: z.string().min(1),
  blockedBy: z.array(z.string()).optional(),
});

const OutputSchema = z.object({
  entries: z.array(EntrySchema),
});

const PERSONA = [
  "You are monastery's backlog triage agent for a GitHub repo.",
  "Your job is READ-ONLY prioritization: rank open issues for a human backlog view.",
  "You have no GitHub or git write authority. Do not propose or return governance actions.",
  "Never return relabel, spec, propose, implement, rework, reply, close, or patcher instructions.",
  "Labels are input facts, not your output. Do not ask the shell to change labels.",
  "Rank issues by impact, urgency, blocking value, readiness, scope clarity, and whether they are already parked on a human.",
  "Use priority buckets: now = most worth attention, soon = valuable but not first, later = low/unclear/deferred, parked = waiting on human/approval/external state.",
  "Output every issue exactly once unless it is clearly terminal/declined in the input.",
].join(" ");

function buildContext(input: BacklogTriageInput): string {
  const issues = input.issues
    .map((i) => [
      `<issue number="${i.number}" state="${i.state}" labels="${i.labels.join(", ")}" updatedAt="${i.updatedAt ?? 0}">`,
      `title: ${i.title}`,
      "",
      truncate(i.body, 4000),
      "</issue>",
    ].join("\n"))
    .join("\n\n");

  return [
    ...(input.language ? [languageDirective(input.language)] : []),
    `<repo>${input.repo}</repo>`,
    `<thesis>\n${input.thesis}\n</thesis>`,
    `<issues>\n${issues || "(none)"}\n</issues>`,
    [
      "TASK:",
      "Return a complete backlog ranking for the provided open issues.",
      "Use only these priority values: now, soon, later, parked.",
      "Explain priority using issue facts: impact, blockers, scope, readiness, dependencies, approval state, or human feedback.",
      "Do NOT mention implement/rework/patcher/executed/deferred as the reason for priority.",
      "Do NOT output any action vocabulary. This is not step/issueStep.",
      "Write ONLY backlog.json with this shape:",
      `{ "entries": [{ "number": 123, "priority": "now", "rationale": "why this belongs here", "blockedBy": ["owner/repo#1"] }] }`,
      "Omit blockedBy when there are no open blockers.",
    ].join("\n"),
  ].join("\n\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated]`;
}

export const backlogTriageSpec: StructuredAgentSpec<BacklogTriageInput, BacklogTriageOutput> = {
  name: "backlog",
  role: "Read all open issues and produce a read-only backlog ranking.",
  persona: PERSONA,
  sandbox: "artifact-only",
  policy: { repairAttempts: 1 },
  artifact: "backlog.json",
  schema: OutputSchema,
  buildContext,
};

export async function backlogTriage(
  provider: AgentProvider,
  model: string,
  input: BacklogTriageInput,
  artifactDir: string,
): Promise<BacklogTriageOutput | null> {
  return runStructuredAgent(backlogTriageSpec, input, { provider, model, artifactDir });
}
