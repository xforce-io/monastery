// src/provider/select.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { AgentProvider } from "./interface.js";
import { ClaudeCodeProvider } from "./claude-code.js";
import { CodexProvider } from "./codex.js";
import { resolveModelLevel } from "./models.js";

export type ProviderName = "claude" | "codex";
export type ProviderMode = ProviderName | "auto";

export interface ProviderHealth { ok: boolean; reason?: string }
export type ProviderHealthProbe = (name: ProviderName) => Promise<ProviderHealth>;

export interface ProviderSelection {
  name: ProviderName;
  provider: AgentProvider;
  health: ProviderHealth;
  fallbackFrom?: ProviderName;
}

export interface SelectAgentProviderOptions {
  mode: ProviderMode;
  health?: ProviderHealthProbe;
  makeProvider?: (name: ProviderName) => AgentProvider;
}

export async function selectAgentProvider(opts: SelectAgentProviderOptions): Promise<ProviderSelection> {
  const health = opts.health ?? realProviderHealth;
  const makeProvider = opts.makeProvider ?? defaultProvider;
  const candidates: ProviderName[] = opts.mode === "auto" ? ["claude", "codex"] : [opts.mode];
  const failures: Partial<Record<ProviderName, string>> = {};

  for (const name of candidates) {
    const h = await health(name);
    if (h.ok) return { name, provider: makeProvider(name), health: h, fallbackFrom: opts.mode === "auto" && name !== candidates[0] ? candidates[0] : undefined };
    failures[name] = h.reason ?? "unhealthy";
  }

  throw new Error([
    `no healthy agent provider found. Tried ${candidates.join(", ")}.`,
    ...candidates.map((name) => `${name}: ${failures[name] ?? "unhealthy"}`),
  ].join("\n"));
}

/** #133: lazy access to NON-primary providers, for roles configured with `agents.<role>.provider`.
 *  A non-primary provider is health-checked on first use only (probe + smoke cost nothing until some
 *  role actually asks for it); the verdict — provider or null when unhealthy — is cached for the run. */
export interface ProviderPool {
  primary: ProviderSelection;
  resolve(name: ProviderName): Promise<AgentProvider | null>;
}

export function makeProviderPool(
  primary: ProviderSelection,
  opts: { health?: ProviderHealthProbe; makeProvider?: (name: ProviderName) => AgentProvider } = {},
): ProviderPool {
  const health = opts.health ?? realProviderHealth;
  const makeProvider = opts.makeProvider ?? defaultProvider;
  const cache = new Map<ProviderName, Promise<AgentProvider | null>>();
  return {
    primary,
    resolve(name: ProviderName): Promise<AgentProvider | null> {
      if (name === primary.name) return Promise.resolve(primary.provider);
      let p = cache.get(name);
      if (!p) {
        p = health(name).then((h) => (h.ok ? makeProvider(name) : null));
        cache.set(name, p);
      }
      return p;
    },
  };
}

export async function realProviderHealth(name: ProviderName): Promise<ProviderHealth> {
  const version = await probeVersion(name === "claude" ? "claude" : "codex");
  if (!version.ok) return version;
  return smokeProvider(name);
}

async function probeVersion(cmd: string): Promise<ProviderHealth> {
  try {
    const r = await execa(cmd, ["--version"], { reject: false, stdio: "ignore", timeout: 10_000 });
    return r.exitCode === 0 ? { ok: true } : { ok: false, reason: `\`${cmd}\` --version failed` };
  } catch {
    return { ok: false, reason: `\`${cmd}\` is not on your PATH` };
  }
}

async function smokeProvider(name: ProviderName): Promise<ProviderHealth> {
  const dir = mkdtempSync(join(tmpdir(), `monastery-${name}-health-`));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "Health check only. Write the requested artifact and do not modify other files.\n", "utf8");
    const provider = defaultProvider(name);
    await provider.run({
      persona: "You are a health-check agent. Write exactly the requested artifact.",
      context: "Write health.json containing {\"ok\":true}.",
      artifactDir: dir,
      model: resolveModelLevel(name, "fast"),
      timeoutMs: 30_000,
    });
    const artifact = join(dir, "health.json");
    if (!existsSync(artifact)) return { ok: false, reason: "smoke test did not write health.json" };
    const parsed = z.object({ ok: z.literal(true) }).safeParse(JSON.parse(readFileSync(artifact, "utf8")));
    return parsed.success ? { ok: true } : { ok: false, reason: "smoke test wrote invalid health.json" };
  } catch (e) {
    return { ok: false, reason: `smoke test failed: ${(e as Error).message}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function defaultProvider(name: ProviderName): AgentProvider {
  return name === "claude" ? new ClaudeCodeProvider() : new CodexProvider();
}
