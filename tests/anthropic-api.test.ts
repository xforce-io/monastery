// tests/anthropic-api.test.ts — AnthropicApiProvider: structured output via Messages API tool use.
import { expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicApiProvider } from "../src/provider/anthropic-api.js";

function makeFakeClient(toolInput: unknown = { value: 42 }) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "tool_use", name: "output", input: toolInput }],
        stop_reason: "tool_use",
      }),
    },
  };
}

const schema = { type: "object", properties: { value: { type: "number" } }, required: ["value"] };
const newDir = () => mkdtempSync(join(tmpdir(), "monastery-api-"));

test("writes the tool_use input as the artifact file when toolInputSchema and artifactName are provided", async () => {
  const dir = newDir();
  const client = makeFakeClient({ value: 7 });
  const provider = new AnthropicApiProvider(client);

  await provider.run({
    persona: "You double numbers.",
    context: "double 3; write out.json",
    artifactDir: dir,
    model: "claude-sonnet-4-6",
    toolInputSchema: schema,
    artifactName: "out.json",
  });

  const written = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
  expect(written).toEqual({ value: 7 });
  rmSync(dir, { recursive: true, force: true });
});

test("sends persona as system, context as user message, and tool schema in tools array", async () => {
  const dir = newDir();
  const client = makeFakeClient();
  const provider = new AnthropicApiProvider(client);

  await provider.run({
    persona: "You are a reviewer.",
    context: "Review this diff.",
    artifactDir: dir,
    model: "claude-sonnet-4-6",
    toolInputSchema: schema,
    artifactName: "review.json",
  });

  const call = client.messages.create.mock.calls[0][0] as Record<string, unknown>;
  expect(call.system).toBe("You are a reviewer.");
  expect((call.messages as Array<{ role: string; content: string }>)[0]).toMatchObject({
    role: "user",
    content: "Review this diff.",
  });
  expect((call.tools as Array<{ name: string; input_schema: unknown }>)[0]).toMatchObject({
    name: "output",
    input_schema: schema,
  });
  rmSync(dir, { recursive: true, force: true });
});

test("forces tool use with tool_choice so the model cannot produce free text", async () => {
  const dir = newDir();
  const client = makeFakeClient();
  const provider = new AnthropicApiProvider(client);

  await provider.run({
    persona: "p",
    context: "c",
    artifactDir: dir,
    model: "claude-sonnet-4-6",
    toolInputSchema: schema,
    artifactName: "out.json",
  });

  const call = client.messages.create.mock.calls[0][0] as { tool_choice?: unknown };
  expect(call.tool_choice).toMatchObject({ type: "tool", name: "output" });
  rmSync(dir, { recursive: true, force: true });
});

test("throws when the model does not call the output tool", async () => {
  const dir = newDir();
  const client = {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "I refuse to use a tool." }],
        stop_reason: "end_turn",
      }),
    },
  };
  const provider = new AnthropicApiProvider(client);

  await expect(
    provider.run({
      persona: "p",
      context: "c",
      artifactDir: dir,
      model: "claude-sonnet-4-6",
      toolInputSchema: schema,
      artifactName: "out.json",
    }),
  ).rejects.toThrow(/tool/i);

  rmSync(dir, { recursive: true, force: true });
});

test("throws when toolInputSchema or artifactName is missing", async () => {
  const dir = newDir();
  const client = makeFakeClient();
  const provider = new AnthropicApiProvider(client);

  await expect(
    provider.run({ persona: "p", context: "c", artifactDir: dir, model: "claude-sonnet-4-6" }),
  ).rejects.toThrow(/toolInputSchema/i);
  rmSync(dir, { recursive: true, force: true });
});

test("passes signal to the client create call", async () => {
  const dir = newDir();
  const client = makeFakeClient();
  const provider = new AnthropicApiProvider(client);
  const signal = AbortSignal.timeout(60_000);

  await provider.run({
    persona: "p",
    context: "c",
    artifactDir: dir,
    model: "claude-sonnet-4-6",
    toolInputSchema: schema,
    artifactName: "out.json",
  }, signal);

  const opts = client.messages.create.mock.calls[0][1] as { signal?: AbortSignal };
  expect(opts?.signal).toBe(signal);
  rmSync(dir, { recursive: true, force: true });
});
