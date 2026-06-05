// src/judges/triager.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue } from "../types.js";

const TriageSchema = z.object({
  type: z.enum(["bug", "feature", "question"]),
});
export type Triage = z.infer<typeof TriageSchema>;

const PERSONA = [
  "You are monastery's issue triager.",
  "Classify a GitHub issue as exactly one of: bug, feature, or question.",
  "You have no GitHub access; you only read the input and write one file.",
].join(" ");

/** Runs the triager agent; returns the validated classification, or null on missing/invalid output. */
export async function triager(
  provider: AgentProvider,
  model: string,
  issue: Issue,
  artifactDir: string,
): Promise<Triage | null> {
  const context = [
    `<issue number="${issue.number}">\ntitle: ${issue.title}\n\n${issue.body}\n</issue>`,
    `Write ONLY the file triage.json with this exact shape and nothing else:`,
    `{ "type": "bug" | "feature" | "question" }`,
    `bug = something is broken/incorrect. feature = a new capability or change request. question = a usage or clarification question.`,
  ].join("\n\n");

  const res = await provider.run({ persona: PERSONA, context, artifactDir, model });

  // 1. primary: the agent wrote triage.json
  const p = join(artifactDir, "triage.json");
  if (existsSync(p)) {
    const parsed = TriageSchema.safeParse(safeJson(readFileSync(p, "utf8")));
    if (parsed.success) return parsed.data;
  }
  // 2. fallback: the agent printed the classification to stdout instead of writing the file
  if (res.resultText) {
    const fromText = extractTriage(res.resultText);
    if (fromText) return fromText;
  }
  return null;
}

/** Pull a schema-valid triage object out of free-form text (fenced JSON, prose-wrapped, or bare). */
function extractTriage(text: string): Triage | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  candidates.push(text);
  for (const c of candidates) {
    const parsed = TriageSchema.safeParse(safeJson(c));
    if (parsed.success) return parsed.data;
  }
  return null;
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }
