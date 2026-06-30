// tests/claude-provider.test.ts — #178 A3: the agent must be denied git/gh at the spawn boundary.
import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider, type ClaudeRunner } from "../src/provider/claude-code.js";

const dir = () => mkdtempSync(join(tmpdir(), "monastery-claude-provider-"));

// #178 A3: the agent runs as `claude -p` with the host's ambient `gh`/`git` auth. `claude -p` denies Bash by
// default, but under a permissive host config (CI dogfood / --dangerously-skip-permissions / an allow rule)
// the agent could run `gh ... reactions +1` to self-approve its OWN gate, or `git push` to main — paths the
// human gate (A1/A2) cannot see (the reaction's author == the owner account monastery runs as). The provider
// must hand `claude` an explicit tool DENY for git/gh so that §3 boundary is enforced by the spawn flags, not
// left to host config (constitution §2 "constrain, not trust" / §3 "no code path to a risky action").
// Note: a denylist is defense-in-depth, not airtight (Claude Code docs: `/usr/bin/git` / subshells can bypass);
// the load-bearing guarantee stays the human gate. `--disallowedTools` overrides any allow rule, so it is a
// strict tightening regardless of the host's config.
test("#178 A3: ClaudeCodeProvider denies the agent git and gh shell tools", async () => {
  const d = dir();
  let captured: string[] = [];
  const run: ClaudeRunner = async (_file, args, opts) => {
    captured = args;
    writeFileSync(opts!.stdoutFile!, JSON.stringify({ result: "ok" }), "utf8");
    return { exitCode: 0 };
  };
  try {
    await new ClaudeCodeProvider(run).run({ persona: "p", context: "c", artifactDir: d, model: "sonnet" });
    const i = captured.indexOf("--disallowedTools");
    expect(i).toBeGreaterThanOrEqual(0); // the deny flag is present
    const denied = captured.slice(i + 1);
    expect(denied).toContain("Bash(git *)"); // git push / git remote blocked (documented deny form)
    expect(denied).toContain("Bash(gh *)"); // gh api reactions / gh pr merge blocked
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// Behavior preserved across the injectable-runner refactor: the core print-mode argv + prompt-from-file.
test("ClaudeCodeProvider runs `claude -p` with model + json output, prompt read from a file", async () => {
  const d = dir();
  let captured: string[] = [];
  let inputFile: string | undefined;
  const run: ClaudeRunner = async (_file, args, opts) => {
    captured = args;
    inputFile = opts?.inputFile;
    writeFileSync(opts!.stdoutFile!, JSON.stringify({ result: "done" }), "utf8");
    return { exitCode: 0 };
  };
  try {
    const res = await new ClaudeCodeProvider(run).run({ persona: "p", context: "c", artifactDir: d, model: "sonnet" });
    expect(captured.slice(0, 5)).toEqual(["-p", "--model", "sonnet", "--output-format", "json"]);
    expect(inputFile).toBe(join(d, "_prompt.md"));
    expect(res.resultText).toBe("done");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
