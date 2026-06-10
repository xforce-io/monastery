// src/provider/codex.ts
import { execa } from "execa";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentProvider, AgentResult } from "./interface.js";

export interface CodexRunResult { exitCode: number }
export type CodexRunner = (
  file: string,
  args: string[],
  opts?: {
    cwd?: string;
    input?: string;
    timeout?: number;
    signal?: AbortSignal;
    stdoutFile?: string;
    stderr?: "inherit" | "pipe" | "ignore";
  },
) => Promise<CodexRunResult>;

const defaultRunner: CodexRunner = async (file, args, opts) => {
  const r = await execa(file, args, {
    cwd: opts?.cwd,
    input: opts?.input,
    stdout: opts?.stdoutFile ? { file: opts.stdoutFile } : "pipe",
    stderr: opts?.stderr ?? "inherit",
    timeout: opts?.timeout,
    cancelSignal: opts?.signal,
    reject: false,
  });
  return { exitCode: r.exitCode ?? 0 };
};

/** Spawns `codex exec` in artifactDir; the agent communicates by writing files. */
export class CodexProvider implements AgentProvider {
  constructor(private readonly runCodex: CodexRunner = defaultRunner) {}

  async run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult> {
    mkdirSync(config.artifactDir, { recursive: true });
    const prompt = `${config.persona}\n\n---\n\n${config.context}`;
    const lastMessage = join(config.artifactDir, "_codex_last_message.txt");
    const args = [
      "exec",
      "-C", config.artifactDir,
      "--sandbox", "workspace-write",
      "--skip-git-repo-check",
      "--ephemeral",
      "--output-last-message", lastMessage,
      "--json",
      "-",
    ];
    if (config.model.trim()) args.splice(3, 0, "-m", config.model);
    await this.runCodex("codex", args, {
      cwd: config.artifactDir,
      input: prompt,
      timeout: config.timeoutMs ?? 30 * 60_000,
      signal,
      stdoutFile: join(config.artifactDir, "_codex_stdout.jsonl"),
      stderr: "inherit",
    });

    let resultText: string | undefined;
    if (existsSync(lastMessage)) {
      const raw = readFileSync(lastMessage, "utf8").trim();
      if (raw) resultText = raw;
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
