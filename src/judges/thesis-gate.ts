// src/judges/thesis-gate.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue } from "../types.js";

const VerdictSchema = z.object({
  verdict: z.enum(["in", "out", "unclear"]),
  reason: z.string().min(1),
});
export type ThesisVerdict = z.infer<typeof VerdictSchema>;

const PERSONA = [
  "You are monastery's thesis gate.",
  "Decide whether a GitHub issue is in-scope for this repo, judged ONLY against its thesis.",
  "You have no GitHub access; you only read the input and write one file.",
].join(" ");

/** Runs the gate agent and returns the validated verdict, or null on missing/invalid output. */
export async function thesisGate(
  provider: AgentProvider,
  model: string,
  thesis: string,
  issue: Issue,
  artifactDir: string,
): Promise<ThesisVerdict | null> {
  const context = [
    `<thesis>\n${thesis}\n</thesis>`,
    `<issue number="${issue.number}">\ntitle: ${issue.title}\n\n${issue.body}\n</issue>`,
    `Write ONLY the file verdict.json with this exact shape and nothing else:`,
    `{ "verdict": "in" | "out" | "unclear", "reason": "<=2 sentences citing the thesis" }`,
    `"in" = clearly within the thesis. "out" = conflicts with / outside it. "unclear" = the thesis does not decide.`,
  ].join("\n\n");

  const res = await provider.run({ persona: PERSONA, context, artifactDir, model });

  // 1. primary: the agent wrote verdict.json
  const p = join(artifactDir, "verdict.json");
  if (existsSync(p)) {
    const parsed = VerdictSchema.safeParse(safeJson(readFileSync(p, "utf8")));
    if (parsed.success) return parsed.data;
  }
  // 2. fallback: the agent printed the verdict to stdout instead of writing the file
  if (res.resultText) {
    const fromText = extractVerdict(res.resultText);
    if (fromText) return fromText;
  }
  return null;
}

/** Pull a schema-valid verdict object out of free-form text (fenced JSON, prose-wrapped, or bare). */
function extractVerdict(text: string): ThesisVerdict | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  candidates.push(text);
  for (const c of candidates) {
    const parsed = VerdictSchema.safeParse(safeJson(c));
    if (parsed.success) return parsed.data;
  }
  return null;
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }
