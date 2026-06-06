// src/agents/reviewer.ts
import { z } from "zod";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue } from "../types.js";
import { runStructuredAgent, type StructuredAgentSpec } from "./spec.js";

const FindingSchema = z.object({
  severity: z.enum(["blocking", "advisory"]),
  title: z.string(),
  detail: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
});
const ReviewSchema = z.object({ findings: z.array(FindingSchema) });
export type ReviewFinding = z.infer<typeof FindingSchema>;
export type ReviewVerdict = z.infer<typeof ReviewSchema>;

/** Injectable reviewer: judges a staged diff against the issue. Returns null on missing/invalid output. */
export type ReviewFn = (diff: string, issue: Issue) => Promise<ReviewVerdict | null>;

export interface ReviewInput { diff: string; issue: Issue }

const PERSONA = [
  "You are monastery's code reviewer.",
  "Review a proposed patch (a unified diff) against the GitHub issue it claims to resolve.",
  "You have no GitHub access; you only read the input and write one file.",
].join(" ");

function buildContext({ diff, issue }: ReviewInput): string {
  return [
    `<issue number="${issue.number}">\ntitle: ${issue.title}\n\n${issue.body}\n</issue>`,
    `<diff>\n${diff}\n</diff>`,
    `Judge the diff. BLOCKING = a correctness bug, a deviation from the issue's design/acceptance, a test that passes but asserts the wrong thing, or a security problem. ADVISORY = style, naming, or simplification nits.`,
    `Write ONLY the file review.json with this exact shape and nothing else:`,
    `{ "findings": [ { "severity": "blocking" | "advisory", "title": string, "detail": string, "file"?: string, "line"?: number } ] }`,
    `An empty findings array means the patch is good to ship.`,
  ].join("\n\n");
}

/** The patcher's self-review gate (#22): judges the staged diff before a draft PR is shipped. */
export const reviewerSpec: StructuredAgentSpec<ReviewInput, ReviewVerdict> = {
  name: "reviewer",
  role: "Judge a patcher's staged diff against the issue; flag blocking problems before a PR ships.",
  persona: PERSONA,
  sandbox: "artifact-only",
  policy: {},
  artifact: "review.json",
  schema: ReviewSchema,
  buildContext,
};

/** Thin wrapper: returns the validated verdict, or null on no schema-valid output. */
export async function reviewer(
  provider: AgentProvider,
  model: string,
  input: ReviewInput,
  artifactDir: string,
): Promise<ReviewVerdict | null> {
  return runStructuredAgent(reviewerSpec, input, { provider, model, artifactDir });
}
