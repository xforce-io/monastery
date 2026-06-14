// src/cli/preflight.ts
// Startup self-check: the CLI hard-depends on `gh` (logged in) and at least one
// agent CLI (`claude` or `codex`) on PATH. Without this, a new consumer's first
// run dies with a raw execa ENOENT/spawn stack (#70 D3).
import { execa } from "execa";
import { isTransientGhError } from "../github/transient.js";

/** Outcome of probing one command. `transient` distinguishes a GitHub/network blip from a real failure (#148). */
export interface ProbeResult { ok: boolean; transient: boolean }

/** Returns whether `cmd args` succeeded, and if it failed, whether the failure looked transient. Injected in tests so they never spawn. */
export type Probe = (cmd: string, args: string[]) => Promise<ProbeResult>;

/** Which external tools this command needs. `status`/`pending`/`init` need gh only; `step` needs an agent. */
export interface Need { gh: boolean; agent: boolean }

const defaultProbe: Probe = async (cmd, args) => {
  try {
    // Capture stderr (not stdio:"ignore") so a non-zero exit can be classified as
    // transient vs. genuine — `gh auth status` hits the API and can EOF mid-check (#148).
    const r = await execa(cmd, args, { reject: false, stdout: "ignore", stderr: "pipe", timeout: 10_000 });
    if (r.exitCode === 0) return { ok: true, transient: false };
    return { ok: false, transient: isTransientGhError(r) };
  } catch (e) {
    return { ok: false, transient: isTransientGhError(e) }; // ENOENT (not on PATH) classifies as non-transient
  }
};

export interface PreflightResult { ok: boolean; errors: string[] }

/**
 * Probe the tools `need` requires and collect human-readable, actionable errors.
 * Distinguishes three gh outcomes: missing binary, a transient API blip (don't send
 * the user to fix auth that is fine — #148), and a genuine not-logged-in.
 * Never throws.
 */
export async function checkPreflight(probe: Probe, need: Need): Promise<PreflightResult> {
  const errors: string[] = [];

  if (need.gh) {
    const version = await probe("gh", ["--version"]);
    if (!version.ok) {
      errors.push("`gh` (GitHub CLI) is not on your PATH. Install it: https://cli.github.com");
    } else {
      const auth = await probe("gh", ["auth", "status"]);
      if (!auth.ok) {
        if (auth.transient) {
          errors.push("GitHub API is temporarily unavailable — could not verify `gh` auth. This is not an auth problem; please retry shortly.");
        } else {
          errors.push("`gh` is installed but not authenticated. Run: gh auth login");
        }
      }
    }
  }

  if (need.agent) {
    const claude = await probe("claude", ["--version"]);
    const codex = await probe("codex", ["--version"]);
    if (!claude.ok && !codex.ok) {
      errors.push("no agent provider CLI is on your PATH. Install `claude` (https://docs.claude.com/claude-code) or `codex`.");
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Wrap raw error lines in a branded preamble so the output reads as guidance, not a crash. */
export function formatPreflightErrors(errors: string[]): string {
  return [
    "[monastery] preflight failed — missing prerequisites:",
    ...errors.map((e) => `  • ${e}`),
  ].join("\n");
}

/** Run the real preflight (default probe) and return the result. */
export function preflight(need: Need): Promise<PreflightResult> {
  return checkPreflight(defaultProbe, need);
}
