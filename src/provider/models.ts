// src/provider/models.ts
import type { ProviderName } from "./select.js";

export type ModelLevel = "fast" | "standard" | "strong";
export interface ModelLevels { fast: string; standard: string; strong: string }

const LEVELS: ModelLevel[] = ["fast", "standard", "strong"];

const PROVIDER_DEFAULTS: Record<ProviderName, ModelLevels> = {
  claude: { fast: "haiku", standard: "sonnet", strong: "sonnet" },
  // Empty means "do not pass -m"; let the user's Codex CLI config choose its default model.
  codex: { fast: "", standard: "", strong: "" },
};

export function resolveModelLevel(
  provider: ProviderName,
  level: ModelLevel,
  env: Record<string, string | undefined> = process.env,
): string {
  const suffix = level.toUpperCase();
  const providerKey = `MONASTERY_${provider.toUpperCase()}_MODEL_${suffix}`;
  const genericKey = `MONASTERY_MODEL_${suffix}`;
  return clean(env[providerKey])
    ?? clean(env[genericKey])
    ?? clean(env.MONASTERY_MODEL)
    ?? PROVIDER_DEFAULTS[provider][level]
    ?? "sonnet";
}

export function resolveModelLevels(
  provider: ProviderName,
  env: Record<string, string | undefined> = process.env,
): ModelLevels {
  return Object.fromEntries(LEVELS.map((level) => [level, resolveModelLevel(provider, level, env)])) as unknown as ModelLevels;
}

export function resolveProviderMode(env: Record<string, string | undefined> = process.env): "auto" | ProviderName {
  const raw = clean(env.MONASTERY_PROVIDER) ?? "auto";
  if (raw === "auto" || raw === "claude" || raw === "codex") return raw;
  throw new Error(`invalid MONASTERY_PROVIDER=${raw}; expected auto, claude, or codex`);
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}
