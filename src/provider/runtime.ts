// src/provider/runtime.ts — #133: resolve which provider+model a ROLE actually runs on.
// `agents.<role>.provider` may point a role at a non-primary provider ("different" = the opposite of the
// global selection, for cross-model review). Best-effort by design: an unhealthy target falls back to the
// primary runtime instead of blocking the tick. Models are provider-specific, so a cross-provider role's
// model is re-resolved at its level — an explicit model override is ignored (with a warn) in that case.
import type { AgentPolicy } from "../agents/spec.js";
import type { AgentProvider } from "./interface.js";
import { resolveModelLevel, type ModelLevel } from "./models.js";
import type { ProviderName, ProviderPool } from "./select.js";

export interface RoleRuntime { provider: AgentProvider; model: string }

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (!warned.has(key)) { warned.add(key); console.warn(msg); }
}

export function otherProvider(name: ProviderName): ProviderName {
  return name === "claude" ? "codex" : "claude";
}

export async function resolveRoleRuntime(opts: {
  agent: string;
  policy: AgentPolicy;
  level: ModelLevel;
  /** The runtime the role would use today: the global provider + the call site's model chain. */
  provider: AgentProvider;
  model: string;
  /** An explicit model override (agents.<role>.model / legacy env) — ignored with a warn cross-provider. */
  explicitModel?: string;
  pool?: ProviderPool;
  env?: Record<string, string | undefined>;
}): Promise<RoleRuntime> {
  const primary: RoleRuntime = { provider: opts.provider, model: opts.model };
  const want = opts.policy.provider;
  if (!want || !opts.pool) return primary;

  const target = want === "different" ? otherProvider(opts.pool.primary.name) : want;
  if (target === opts.pool.primary.name) return primary;

  const alt = await opts.pool.resolve(target);
  if (!alt) {
    warnOnce(`${opts.agent}:provider-fallback`,
      `[monastery] ${opts.agent}: provider ${target} is unavailable; falling back to ${opts.pool.primary.name}`);
    return primary;
  }
  if (opts.explicitModel) {
    warnOnce(`${opts.agent}:cross-provider-model`,
      `[monastery] ${opts.agent}: model override "${opts.explicitModel}" is provider-specific; ignored because ${opts.agent} runs on ${target} — using its ${opts.level} level model`);
  }
  return { provider: alt, model: resolveModelLevel(target, opts.level, opts.env) };
}
