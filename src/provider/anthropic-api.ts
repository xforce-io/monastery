// src/provider/anthropic-api.ts — Anthropic Messages API provider for structured output via tool use.
// Judgment agents (sandbox: "artifact-only") use this instead of the CLI so the model is *forced*
// to call a tool with schema-valid JSON, eliminating invalid_json / schema_invalid failures.
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentProvider, AgentResult } from "./interface.js";

// Minimal structural type — lets tests inject a fake without importing the SDK.
interface AnthropicClientLike {
  messages: {
    create(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<{
      content: Array<{ type: string; name?: string; input?: unknown }>;
      stop_reason: string;
    }>;
  };
}

/**
 * Calls the Anthropic Messages API with tool use to produce schema-valid structured output.
 * The model is forced to call the `output` tool, so its response is always valid JSON matching
 * the caller-supplied `toolInputSchema` — no invalid_json / schema_invalid failures, no repair retries.
 *
 * Requires `config.toolInputSchema` and `config.artifactName`; throws if either is missing.
 * The tool result is written as `config.artifactDir/config.artifactName` for the runner to read.
 */
export class AnthropicApiProvider implements AgentProvider {
  private readonly client: AnthropicClientLike;

  /** For production: pass an API key. */
  static fromApiKey(apiKey: string): AnthropicApiProvider {
    return new AnthropicApiProvider(new Anthropic({ apiKey }) as unknown as AnthropicClientLike);
  }

  /** For testing: inject a fake client directly. */
  constructor(client: AnthropicClientLike) {
    this.client = client;
  }

  async run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult> {
    if (!config.toolInputSchema || !config.artifactName) {
      throw new Error(
        "AnthropicApiProvider requires toolInputSchema and artifactName in AgentConfig",
      );
    }
    mkdirSync(config.artifactDir, { recursive: true });

    const response = await this.client.messages.create(
      {
        model: config.model,
        max_tokens: 4096,
        system: config.persona,
        messages: [{ role: "user", content: config.context }],
        tools: [
          {
            name: "output",
            description: `Write the structured output as ${config.artifactName}`,
            input_schema: config.toolInputSchema,
          },
        ],
        tool_choice: { type: "tool", name: "output" },
      },
      { signal },
    );

    const toolUse = response.content.find(
      (c): c is { type: "tool_use"; name: string; input: unknown } => c.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error(
        `AnthropicApiProvider: model did not call the output tool (stop_reason=${response.stop_reason})`,
      );
    }

    const artifactPath = join(config.artifactDir, config.artifactName);
    writeFileSync(artifactPath, JSON.stringify(toolUse.input), "utf8");
    return { artifacts: [artifactPath] };
  }
}
