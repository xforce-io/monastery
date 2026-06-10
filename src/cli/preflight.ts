// src/cli/preflight.ts
// Startup self-check: the CLI hard-depends on `gh` (logged in) and at least one
// agent CLI (`claude` or `codex`) on PATH. Without this, a new consumer's first
// run dies with a raw execa ENOENT/spawn stack (#70 D3).
import { execa } from "execa";

/** Returns true if `cmd args` exits 0. Injected in tests so they never spawn. */
export type Probe = (cmd: string, args: string[]) => Promise<boolean>;

/** Which external tools this command needs. `status`/`pending`/`init` need gh only; `step` needs an agent. */
export interface Need { gh: boolean; agent: boolean }

const defaultProbe: Probe = async (cmd, args) => {
  try {
    const r = await execa(cmd, args, { reject: false, stdio: "ignore", timeout: 10_000 });
    return r.exitCode === 0;
  } catch {
    return false; // ENOENT (not on PATH) etc.
  }
};

export interface PreflightResult { ok: boolean; errors: string[] }

/**
 * Probe the tools `need` requires and collect human-readable, actionable errors
 * (missing binary vs. not-logged-in are distinct messages). Never throws.
 */
export async function checkPreflight(probe: Probe, need: Need): Promise<PreflightResult> {
  const errors: string[] = [];

  if (need.gh) {
    if (!(await probe("gh", ["--version"]))) {
      errors.push("`gh` (GitHub CLI) is not on your PATH. Install it: https://cli.github.com");
    } else if (!(await probe("gh", ["auth", "status"]))) {
      errors.push("`gh` is installed but not authenticated. Run: gh auth login");
    }
  }

  if (need.agent) {
    const claude = await probe("claude", ["--version"]);
    const codex = await probe("codex", ["--version"]);
    if (!claude && !codex) {
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
