// src/judges/reviewer.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue } from "../types.js";

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

const PERSONA = [
  "You are monastery's code reviewer.",
  "Review a proposed patch (a unified diff) against the GitHub issue it claims to resolve.",
  "You have no GitHub access; you only read the input and write one file.",
].join(" ");

export async function reviewer(
  provider: AgentProvider,
  model: string,
  input: { diff: string; issue: Issue },
  artifactDir: string,
): Promise<ReviewVerdict | null> {
  const { diff, issue } = input;
  const context = [
    `<issue number="${issue.number}">\ntitle: ${issue.title}\n\n${issue.body}\n</issue>`,
    `<diff>\n${diff}\n</diff>`,
    `Judge the diff. BLOCKING = a correctness bug, a deviation from the issue's design/acceptance, a test that passes but asserts the wrong thing, or a security problem. ADVISORY = style, naming, or simplification nits.`,
    `Write ONLY the file review.json with this exact shape and nothing else:`,
    `{ "findings": [ { "severity": "blocking" | "advisory", "title": string, "detail": string, "file"?: string, "line"?: number } ] }`,
    `An empty findings array means the patch is good to ship.`,
  ].join("\n\n");

  const res = await provider.run({ persona: PERSONA, context, artifactDir, model });

  const p = join(artifactDir, "review.json");
  if (existsSync(p)) {
    const parsed = ReviewSchema.safeParse(safeJson(readFileSync(p, "utf8")));
    if (parsed.success) return parsed.data;
  }
  if (res.resultText) {
    const fromText = extractReview(res.resultText);
    if (fromText) return fromText;
  }
  return null;
}

/** Pull a schema-valid review object out of free-form text (fenced JSON, prose-wrapped, or bare). */
function extractReview(text: string): ReviewVerdict | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  candidates.push(text);
  for (const c of candidates) {
    const parsed = ReviewSchema.safeParse(safeJson(c));
    if (parsed.success) return parsed.data;
  }
  return null;
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }
