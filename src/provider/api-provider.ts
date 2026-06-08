import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentProvider, AgentResult } from "./interface.js";

interface ApiProviderConfig {
  endpoint: string;
  apiKey: string;
  model?: string;
}

interface ChatCompletionResponse {
  choices?: {
    message?: {
      tool_calls?: {
        function?: { name?: string; arguments?: unknown };
      }[];
    };
  }[];
}

/** OpenAI-compatible structured-output provider: function calling + JSON Schema, no vendor SDK. */
export class ApiProvider implements AgentProvider {
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ApiProvider | null {
    const endpoint = env.MONASTERY_STRUCTURED_ENDPOINT?.trim();
    const apiKey = env.MONASTERY_STRUCTURED_API_KEY?.trim();
    if (!endpoint || !apiKey) return null;
    return new ApiProvider({ endpoint, apiKey, model: env.MONASTERY_STRUCTURED_MODEL?.trim() || undefined });
  }

  constructor(private readonly config: ApiProviderConfig) {}

  async run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult> {
    if (!config.schema) throw new Error("ApiProvider requires AgentConfig.schema");
    if (!config.artifact) throw new Error("ApiProvider requires AgentConfig.artifact");

    mkdirSync(config.artifactDir, { recursive: true });
    const body = {
      model: this.config.model ?? config.model,
      messages: [
        { role: "system", content: config.persona },
        { role: "user", content: config.context },
      ],
      tools: [{
        type: "function",
        function: {
          name: "output",
          description: `Write ${config.artifact} as schema-valid JSON.`,
          parameters: config.schema,
        },
      }],
      tool_choice: { type: "function", function: { name: "output" } },
    };

    const res = await fetch(`${this.config.endpoint.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`structured API failed: HTTP ${res.status} ${await res.text()}`);

    const json = await res.json() as ChatCompletionResponse;
    const call = json.choices?.[0]?.message?.tool_calls?.find((c) => c.function?.name === "output")
      ?? json.choices?.[0]?.message?.tool_calls?.[0];
    const args = call?.function?.arguments;
    if (args === undefined) throw new Error("structured API returned no tool call arguments");

    const artifactPath = join(config.artifactDir, config.artifact);
    writeFileSync(artifactPath, typeof args === "string" ? args : JSON.stringify(args), "utf8");
    return { artifacts: scanArtifacts(config.artifactDir) };
  }
}

function scanArtifacts(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => !n.startsWith("_") && !n.startsWith("."))
    .map((n) => join(dir, n))
    .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
}
