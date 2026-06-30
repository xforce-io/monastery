// src/provider/claude-code.ts
import { execa } from "execa";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentProvider, AgentResult } from "./interface.js";

export interface ClaudeRunResult { exitCode: number }
/** Injected so tests can assert the argv / permission flags without spawning a real `claude`. */
export type ClaudeRunner = (
  file: string,
  args: string[],
  opts?: {
    cwd?: string;
    inputFile?: string;
    timeout?: number;
    signal?: AbortSignal;
    stdoutFile?: string;
    stderr?: "inherit" | "pipe" | "ignore";
  },
) => Promise<ClaudeRunResult>;

const defaultRunner: ClaudeRunner = async (file, args, opts) => {
  const r = await execa(file, args, {
    cwd: opts?.cwd,
    inputFile: opts?.inputFile,
    stdout: opts?.stdoutFile ? { file: opts.stdoutFile } : "pipe",
    stderr: opts?.stderr ?? "inherit",
    timeout: opts?.timeout,
    cancelSignal: opts?.signal,
    reject: false, // an exit code is not a throw; the shell judges by artifacts
  });
  return { exitCode: r.exitCode ?? 0 };
};

/**
 * If `cwd` has AGENTS.md and no CLAUDE.md, write a one-line `@AGENTS.md` CLAUDE.md so `claude -p`
 * picks up the repo's AGENTS.md (Claude Code reads CLAUDE.md, not AGENTS.md). Returns a cleanup fn
 * that removes the injected file — but only if we created it — so it never lands in a committed patch.
 */
export function surfaceClaudeConventions(cwd: string): () => void {
  const claudeMd = join(cwd, "CLAUDE.md");
  const inject = existsSync(join(cwd, "AGENTS.md")) && !existsSync(claudeMd);
  if (inject) writeFileSync(claudeMd, "@AGENTS.md\n", "utf8");
  return () => { if (inject) rmSync(claudeMd, { force: true }); };
}

/** Spawns `claude -p` in artifactDir; the agent communicates by writing files. */
export class ClaudeCodeProvider implements AgentProvider {
  constructor(private readonly runClaude: ClaudeRunner = defaultRunner) {}

  async run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult> {
    mkdirSync(config.artifactDir, { recursive: true });
    const promptFile = join(config.artifactDir, "_prompt.md");
    writeFileSync(promptFile, `${config.persona}\n\n---\n\n${config.context}`, "utf8");

    // Surface the repo's AGENTS.md to `claude -p` (which reads CLAUDE.md, not AGENTS.md).
    const cleanup = surfaceClaudeConventions(config.artifactDir);
    let resultText: string | undefined;
    const stdoutPath = join(config.artifactDir, "_claude_stdout.json");
    try {
      await this.runClaude("claude", [
        "-p", "--model", config.model, "--output-format", "json",
        // #178 A3: deny the agent git/gh at the spawn boundary so it cannot `git push` to main or
        // `gh ... reactions +1` to self-approve its own gate — even under a permissive host config (the human
        // gate can't catch a self-react, since its author == the owner account monastery runs as). Defense-in-
        // depth: `--disallowedTools` overrides any allow rule (strict tightening), but a denylist is bypassable
        // (Claude Code docs: `/usr/bin/git`, subshells); the load-bearing guarantee stays the human gate (A1/A2).
        "--disallowedTools", "Bash(git:*)", "Bash(gh:*)",
      ], {
        cwd: config.artifactDir,
        inputFile: promptFile,
        stdoutFile: stdoutPath,
        stderr: "inherit",
        timeout: config.timeoutMs ?? 30 * 60_000,
        signal,
      });

      if (existsSync(stdoutPath)) {
        try {
          const j = JSON.parse(readFileSync(stdoutPath, "utf8")) as { result?: unknown };
          if (typeof j.result === "string") resultText = j.result;
        } catch { /* leave resultText undefined */ }
      }
    } finally {
      cleanup(); // remove the injected CLAUDE.md BEFORE artifacts are scanned / the patch is staged
    }
    return { artifacts: scanArtifacts(config.artifactDir), resultText };
  }
}

function scanArtifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith("_") && !n.startsWith("."))
    .map((n) => join(dir, n))
    .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
}
