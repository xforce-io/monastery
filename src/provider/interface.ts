// src/provider/interface.ts
export interface AgentConfig {
  persona: string;       // who the agent is (system-level)
  context: string;       // the task input
  artifactDir: string;   // cwd; the agent communicates by writing files here
  model: string;         // passed verbatim to the underlying agent (e.g. "haiku")
  timeoutMs?: number;
}
export interface AgentResult { artifacts: string[]; resultText?: string }

/** Runs one agent to completion. Output is the files it wrote into artifactDir. */
export interface AgentProvider {
  run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult>;
}
