// src/cli/preflight.ts
// Startup self-check: the CLI hard-depends on `gh` (logged in) and `claude` on PATH,
// both called via execa. Without this, a new consumer's first run dies with a raw
// execa ENOENT/spawn stack (#70 D3). We probe up front and print actionable guidance.
import { execa } from "execa";

/** Returns true if `cmd args` exits 0. Injected in tests so they never spawn. */
export type Probe = (cmd: string, args: string[]) => Promise<boolean>;

/** Which external tools this command needs. `status`/`pending`/`init` need gh only; `step` needs both. */
export interface Need { gh: boolean; claude: boolean }

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

  if (need.claude) {
    if (!(await probe("claude", ["--version"]))) {
      errors.push("`claude` (Claude Code CLI) is not on your PATH. Install it: https://docs.claude.com/claude-code");
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
