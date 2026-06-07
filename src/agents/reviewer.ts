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

// reviewer = 架构/QA (CONSTITUTION §12): an architect & QA reviewer with judgment criteria, not a linter.
// The blocking-vs-advisory criteria below are JUDGMENT, not a fixed rulebook — give principles, not steps.
const PERSONA = [
  "You are monastery's code reviewer — wear two hats: ARCHITECT and QA.",
  "Review a proposed patch (a unified diff) against the GitHub issue it claims to resolve.",
  "You have no GitHub access; you only read the input and write one file.",
  // Judgment criteria (what a good review weighs, in priority order):
  "CRITERIA: judge the diff on (1) INTENT — does it actually do what the issue asked, and nothing the issue didn't?;",
  "(2) CORRECTNESS — does it work, including edge cases, and do its tests assert the right thing (not just pass)?;",
  "(3) SECURITY — does it introduce any unsafe behavior?; (4) SIMPLICITY — is it the smallest clear change, or over-built?",
  "Triage by these: a finding is BLOCKING when it breaks intent, correctness, or security — a real bug, a deviation from the issue's design/acceptance, a test that passes while asserting the wrong thing, or a security hole.",
  "A finding is ADVISORY when it is only about style, naming, or a simpler shape — worth saying, but not a reason to hold the patch.",
  "Do not invent work the issue didn't ask for; an empty findings list means it is good to ship.",
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

/** JSON Schema for the Anthropic API tool use — mirrors ReviewSchema so the model is forced to call
 *  the `output` tool with a findings array, eliminating free-text JSON parsing failures. */
const REVIEW_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocking", "advisory"] },
          title: { type: "string" },
          detail: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
        },
        required: ["severity", "title", "detail"],
      },
    },
  },
  required: ["findings"],
};

/** The patcher's self-review gate (#22): judges the staged diff before a draft PR is shipped. */
export const reviewerSpec: StructuredAgentSpec<ReviewInput, ReviewVerdict> = {
  name: "reviewer",
  role: "Judge a patcher's staged diff against the issue; flag blocking problems before a PR ships.",
  persona: PERSONA,
  sandbox: "artifact-only",
  policy: {},
  artifact: "review.json",
  schema: ReviewSchema,
  toolInputSchema: REVIEW_TOOL_SCHEMA,
  buildContext,
};

/** Thin wrapper: returns the validated verdict, or null on no schema-valid output. */
export async function reviewer(
  provider: AgentProvider,
  model: string,
  input: ReviewInput,
  artifactDir: string,
  apiProvider?: AgentProvider,
): Promise<ReviewVerdict | null> {
  return runStructuredAgent(reviewerSpec, input, { provider, apiProvider, model, artifactDir });
}
