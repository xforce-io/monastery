// src/provider/interface.ts
export interface AgentConfig {
  persona: string;       // who the agent is (system-level)
  context: string;       // the task input
  artifactDir: string;   // cwd; the agent communicates by writing files here
  model: string;         // passed verbatim to the underlying agent (e.g. "haiku")
  timeoutMs?: number;
  // For API-based structured providers: JSON schema for tool use + artifact file name to write
  toolInputSchema?: Record<string, unknown>;
  artifactName?: string;
}
export interface AgentResult { artifacts: string[]; resultText?: string }

/** Runs one agent to completion. Output is the files it wrote into artifactDir. */
export interface AgentProvider {
  /**
   * Run the agent to completion in `config.artifactDir`.
   *
   * Contract: surface the target repo's AGENTS.md (when present in the cwd) to the underlying agent —
   * each provider its own way (claude_code maps it to CLAUDE.md; codex reads AGENTS.md natively).
   * The framework does NOT parse AGENTS.md; it is agent-facing data.
   */
  run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult>;
}
