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
  repairAttempts?: number; // structured artifact repair attempts; capped at 2 so ticks stay bounded
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
  /** JSON Schema for Anthropic API tool use. When set and ctx.apiProvider is provided, the agent
   *  uses the API (forced tool call) instead of the CLI, eliminating invalid_json failures. */
  toolInputSchema?: Record<string, unknown>;
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

export interface RunCtx {
  provider: AgentProvider;
  /** When set, artifact-only structured agents with a toolInputSchema use this instead of provider. */
  apiProvider?: AgentProvider;
  model: string;
  artifactDir: string;
}

export type StructuredAgentFailureReason =
  | "missing_artifact"
  | "invalid_json"
  | "schema_invalid"
  | "provider_failed";

export interface StructuredAgentFailure {
  reason: StructuredAgentFailureReason;
  agent: string;
  artifactPath: string;
  parseError?: string;
  schemaError?: string;
  providerError?: string;
  repairAttempts: number;
}

export class StructuredAgentError extends Error {
  constructor(public readonly failure: StructuredAgentFailure) {
    super(formatFailure(failure));
    this.name = "StructuredAgentError";
  }
}

/**
 * Run a structured agent: prompt -> schema-valid artifact (or stdout fallback) -> typed output.
 * Invalid JSON and schema-invalid artifacts get a bounded repair attempt, then fail fast with diagnostics.
 *
 * When ctx.apiProvider is set and spec has toolInputSchema, artifact-only specs bypass the CLI
 * and call the Anthropic API with tool use — the model is forced to produce valid JSON, so no
 * invalid_json / schema_invalid failures and no repair retries.
 */
export async function runStructuredAgent<In, Out>(
  spec: StructuredAgentSpec<In, Out>,
  input: In,
  ctx: RunCtx,
): Promise<Out | null> {
  const baseContext = spec.buildContext(input);
  const p = join(ctx.artifactDir, spec.artifact);

  // API path: forced tool use guarantees valid JSON — no repair retries needed.
  if (spec.sandbox === "artifact-only" && ctx.apiProvider && spec.toolInputSchema) {
    try {
      await ctx.apiProvider.run({
        persona: spec.persona,
        context: baseContext,
        artifactDir: ctx.artifactDir,
        model: ctx.model,
        toolInputSchema: spec.toolInputSchema,
        artifactName: spec.artifact,
      });
    } catch (e) {
      throw new StructuredAgentError({
        reason: "provider_failed",
        agent: spec.name,
        artifactPath: p,
        providerError: (e as Error).message,
        repairAttempts: 0,
      });
    }
    if (!existsSync(p)) {
      throw new StructuredAgentError({ reason: "missing_artifact", agent: spec.name, artifactPath: p, repairAttempts: 0 });
    }
    const raw = readFileSync(p, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new StructuredAgentError({
        reason: "invalid_json", agent: spec.name, artifactPath: p,
        parseError: (err as Error).message, repairAttempts: 0,
      });
    }
    const parsed = spec.schema.safeParse(json);
    if (parsed.success) return parsed.data;
    throw new StructuredAgentError({
      reason: "schema_invalid", agent: spec.name, artifactPath: p,
      schemaError: parsed.error.message, repairAttempts: 0,
    });
  }

  // CLI path: bounded repair retries for free-text JSON output.
  const maxRetries = Math.min(spec.policy.repairAttempts ?? 1, 2);
  let repairHint: string | undefined;
  let lastFailure: StructuredAgentFailure | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const context = repairHint
      ? `${baseContext}\n\n---\n\n## REPAIR NEEDED\n\n${repairHint}\n\nPlease rewrite ${spec.artifact} with correctly escaped JSON.`
      : baseContext;

    let res;
    try {
      res = await ctx.provider.run({ persona: spec.persona, context, artifactDir: ctx.artifactDir, model: ctx.model });
    } catch (e) {
      throw new StructuredAgentError({
        reason: "provider_failed",
        agent: spec.name,
        artifactPath: p,
        providerError: (e as Error).message,
        repairAttempts: attempt,
      });
    }

    // 1. primary: the agent wrote its artifact file
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf8");

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        const msg = (err as Error).message;
        lastFailure = { reason: "invalid_json", agent: spec.name, artifactPath: p, parseError: msg, repairAttempts: attempt };
        console.warn(formatFailure(lastFailure));
        if (attempt < maxRetries) {
          repairHint = [
            `The artifact ${spec.artifact} is not valid JSON.`,
            `JSON parse error: ${msg}`,
            `Bad artifact content:`,
            raw,
            `Rewrite ${spec.artifact} only. Preserve the intended semantics, but make it schema-valid JSON.`,
          ].join("\n");
          continue; // retry with repair context
        }
        throw new StructuredAgentError(lastFailure);
      }

      if (json !== undefined) {
        const parsed = spec.schema.safeParse(json);
        if (parsed.success) return parsed.data;
        const msg = parsed.error.message;
        lastFailure = { reason: "schema_invalid", agent: spec.name, artifactPath: p, schemaError: msg, repairAttempts: attempt };
        console.warn(formatFailure(lastFailure));
        if (attempt < maxRetries) {
          repairHint = [
            `The artifact ${spec.artifact} is valid JSON but does not match the required schema.`,
            `Schema error: ${msg}`,
            `Bad artifact content:`,
            raw,
            `Rewrite ${spec.artifact} only. Preserve the intended semantics, but make it schema-valid JSON.`,
          ].join("\n");
          continue;
        }
        throw new StructuredAgentError(lastFailure);
      }
    }

    // 2. fallback: only when no artifact file exists.
    if (res.resultText) {
      const fromText = extractStructured(res.resultText, spec.schema);
      if (fromText) return fromText;
    }

    lastFailure = { reason: "missing_artifact", agent: spec.name, artifactPath: p, repairAttempts: attempt };
    throw new StructuredAgentError(lastFailure);
  }

  throw new StructuredAgentError(lastFailure ?? {
    reason: "missing_artifact",
    agent: spec.name,
    artifactPath: p,
    repairAttempts: maxRetries,
  });
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

function formatFailure(f: StructuredAgentFailure): string {
  const details = [
    f.parseError ? `parseError=${f.parseError}` : "",
    f.schemaError ? `schemaError=${f.schemaError}` : "",
    f.providerError ? `providerError=${f.providerError}` : "",
  ].filter(Boolean).join(" ");
  return `[monastery] ${f.agent}: structured output failed reason=${f.reason} artifact=${f.artifactPath} repairAttempts=${f.repairAttempts}${details ? " " + details : ""}`;
}
