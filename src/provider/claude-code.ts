// src/provider/claude-code.ts
import { execa } from "execa";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentProvider, AgentResult } from "./interface.js";

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

    return { artifacts: scanArtifacts(config.artifactDir) };
  }
}

function scanArtifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith("_") && !n.startsWith("."))
    .map((n) => join(dir, n))
    .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
}
