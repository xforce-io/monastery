// src/provider/claude-code.ts
import { execa } from "execa";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentProvider, AgentResult } from "./interface.js";

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
  async run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult> {
    mkdirSync(config.artifactDir, { recursive: true });
    const promptFile = join(config.artifactDir, "_prompt.md");
    writeFileSync(promptFile, `${config.persona}\n\n---\n\n${config.context}`, "utf8");

    await execa("claude", ["-p", "--model", config.model, "--output-format", "json"], {
      cwd: config.artifactDir,
      inputFile: promptFile,
      stdout: { file: join(config.artifactDir, "_claude_stdout.json") },
      stderr: "inherit",
      timeout: config.timeoutMs ?? 30 * 60_000,
      cancelSignal: signal,
      reject: false, // an exit code is not a throw; the shell judges by artifacts
    });

    let resultText: string | undefined;
    const stdoutPath = join(config.artifactDir, "_claude_stdout.json");
    if (existsSync(stdoutPath)) {
      try {
        const j = JSON.parse(readFileSync(stdoutPath, "utf8")) as { result?: unknown };
        if (typeof j.result === "string") resultText = j.result;
      } catch { /* leave resultText undefined */ }
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
