// src/provider/interface.ts
export type JSONSchema =
  | boolean
  | {
      type?: string | string[];
      properties?: Record<string, JSONSchema>;
      items?: JSONSchema;
      required?: string[];
      enum?: unknown[];
      const?: unknown;
      anyOf?: JSONSchema[];
      oneOf?: JSONSchema[];
      additionalProperties?: boolean | JSONSchema;
      description?: string;
    };

export interface AgentConfig {
  persona: string;       // who the agent is (system-level)
  context: string;       // the task input
  artifactDir: string;   // cwd; the agent communicates by writing files here
  model: string;         // passed verbatim to the underlying agent (e.g. "haiku")
  /** Optional structured-output contract. CLI providers may ignore it; API providers use it for tool schema. */
  schema?: JSONSchema;
  /** The artifact filename that should receive the structured output, when `schema` is present. */
  artifact?: string;
  timeoutMs?: number;
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
