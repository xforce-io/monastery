// src/agents/spec.ts — the unified agent definition + the shared runner.
// An agent's definition (persona / input / output / sandbox / policy) is where v2's "useful" lives and
// is maintained (CONSTITUTION §8). The runner is thin shared mechanism the shell owns (§9).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import type { AgentProvider } from "../provider/interface.js";

/** A zod schema whose validated OUTPUT is `Out` (its input may differ, e.g. a transforming union). */
export type OutSchema<Out> = ZodType<Out, ZodTypeDef, unknown>;

/** What an agent is allowed to touch. "carries no git/gh" is an invariant of every sandbox. */
export type Sandbox = "artifact-only" | "workspace-clone";

/** Per-agent operational defaults (the SLA-ish knobs). Per-repo overrides live in RepoPolicy (PR2). */
export interface AgentPolicy {
  model?: string;
  timeoutMs?: number;
  failThreshold?: number; // consecutive no-valid-output ticks before escalating to a human
  maxIters?: number;      // bounded self-correction loops (e.g. the patcher's review rounds)
}

/** Identity shared by every agent, structured or workspace-mutating. */
export interface AgentSpec {
  name: string;     // "maintainer"
  role: string;     // one-line responsibility
  persona: string;  // the system prompt — the capability lever
  sandbox: Sandbox;
  policy: AgentPolicy;
}

/** A structured agent: turns typed input into a prompt and must emit a schema-valid artifact file. */
export interface StructuredAgentSpec<In, Out> extends AgentSpec {
  buildContext: (input: In) => string;
  artifact: string;       // the file the agent writes, e.g. "actions.json"
  schema: OutSchema<Out>; // its output contract (validated output is Out)
}

/** A workspace-mutating agent (the patcher): edits files in a clone; the shell reads the diff. */
export interface WorkspaceAgentSpec extends AgentSpec {
  sandbox: "workspace-clone";
  /** Secondary persona for a follow-up pass (the patcher addressing review feedback). */
  fixPersona?: string;
}

/** Per-repo overrides of agent policy, keyed by agent name. Lives in config.json's RepoPolicy. */
export interface PolicyOverrides { agents?: Record<string, Partial<AgentPolicy>> }

/** Merge a per-field override onto a base policy: an override field wins; unset fields keep the base. */
export function resolvePolicy(base: AgentPolicy, override?: Partial<AgentPolicy>): AgentPolicy {
  return { ...base, ...stripUndefined(override) };
}

/** The effective policy for an agent in a repo = its spec defaults with the repo's per-agent override applied. */
export function effectivePolicy(spec: AgentSpec, repo?: PolicyOverrides): AgentPolicy {
  return resolvePolicy(spec.policy, repo?.agents?.[spec.name]);
}

function stripUndefined(o?: Partial<AgentPolicy>): Partial<AgentPolicy> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export interface RunCtx { provider: AgentProvider; model: string; artifactDir: string }

/**
 * Run a structured agent: prompt -> schema-valid artifact (or stdout fallback) -> typed output, or null.
 * On JSON parse failure, feeds the error + bad artifact back to the provider for one repair attempt.
 * Logs (but does not retry) schema validation failures.
 */
export async function runStructuredAgent<In, Out>(
  spec: StructuredAgentSpec<In, Out>,
  input: In,
  ctx: RunCtx,
): Promise<Out | null> {
  const baseContext = spec.buildContext(input);
  const maxRetries = 1; // one repair attempt on JSON parse failure
  let repairHint: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const context = repairHint
      ? `${baseContext}\n\n---\n\n## REPAIR NEEDED\n\n${repairHint}\n\nPlease rewrite ${spec.artifact} with correctly escaped JSON.`
      : baseContext;

    const res = await ctx.provider.run({ persona: spec.persona, context, artifactDir: ctx.artifactDir, model: ctx.model });

    // 1. primary: the agent wrote its artifact file
    const p = join(ctx.artifactDir, spec.artifact);
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf8");

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        const msg = (err as Error).message;
        console.warn(`[monastery] ${spec.name}: invalid JSON in ${p}: ${msg}`);
        if (attempt < maxRetries) {
          repairHint = `JSON parse error: ${msg}\nBad artifact content:\n${raw.slice(0, 500)}`;
          continue; // retry with repair context
        }
        // exhausted retries — fall through to stdout fallback below
      }

      if (json !== undefined) {
        const parsed = spec.schema.safeParse(json);
        if (parsed.success) return parsed.data;
        console.warn(`[monastery] ${spec.name}: schema error in ${p}: ${parsed.error.message}`);
      }
    }

    // 2. fallback: the agent printed the payload to stdout instead of writing the file
    if (res.resultText) {
      const fromText = extractStructured(res.resultText, spec.schema);
      if (fromText) return fromText;
    }

    break; // schema failure or missing artifact + no valid stdout: don't retry
  }

  return null;
}

/** Pull a schema-valid value out of free-form text (fenced JSON, prose-wrapped object/array, or bare). */
function extractStructured<Out>(text: string, schema: OutSchema<Out>): Out | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) candidates.push(arr[0]);
  candidates.push(text);
  for (const c of candidates) {
    const parsed = schema.safeParse(safeJson(c));
    if (parsed.success) return parsed.data;
  }
  return null;
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }
