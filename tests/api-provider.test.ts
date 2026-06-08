import { expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiProvider } from "../src/provider/api-provider.js";

const dir = () => mkdtempSync(join(tmpdir(), "monastery-api-provider-"));

test("fromEnv returns null unless endpoint and api key are both configured", () => {
  expect(ApiProvider.fromEnv({})).toBeNull();
  expect(ApiProvider.fromEnv({ MONASTERY_STRUCTURED_ENDPOINT: "https://x/v1" })).toBeNull();
  expect(ApiProvider.fromEnv({ MONASTERY_STRUCTURED_API_KEY: "k" })).toBeNull();
  expect(ApiProvider.fromEnv({
    MONASTERY_STRUCTURED_ENDPOINT: "https://x/v1",
    MONASTERY_STRUCTURED_API_KEY: "k",
  })).toBeInstanceOf(ApiProvider);
});

test("posts an OpenAI-compatible tool request and writes tool arguments to the artifact", async () => {
  const d = dir();
  const oldFetch = globalThis.fetch;
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.example/v1/chat/completions");
    expect(init.headers).toMatchObject({ authorization: "Bearer key" });
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("structured-model");
    expect(body.messages).toEqual([
      { role: "system", content: "persona" },
      { role: "user", content: "context" },
    ]);
    expect(body.tools[0]).toMatchObject({
      type: "function",
      function: {
        name: "output",
        parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
      },
    });
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "output" } });
    return new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: "output", arguments: "{\"value\":7}" } }] } }],
    }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const provider = new ApiProvider({ endpoint: "https://api.example/v1/", apiKey: "key", model: "structured-model" });
    const result = await provider.run({
      persona: "persona",
      context: "context",
      artifactDir: d,
      model: "fallback-model",
      artifact: "out.json",
      schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
    });
    expect(result.artifacts).toEqual([join(d, "out.json")]);
    expect(JSON.parse(readFileSync(join(d, "out.json"), "utf8"))).toEqual({ value: 7 });
  } finally {
    vi.stubGlobal("fetch", oldFetch);
    rmSync(d, { recursive: true, force: true });
  }
});

test("throws provider errors instead of fabricating fallback output", async () => {
  const d = dir();
  const oldFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
  try {
    const provider = new ApiProvider({ endpoint: "https://api.example/v1", apiKey: "key" });
    await expect(provider.run({
      persona: "p",
      context: "c",
      artifactDir: d,
      model: "m",
      artifact: "out.json",
      schema: { type: "object" },
    })).rejects.toThrow(/HTTP 500/);
  } finally {
    vi.stubGlobal("fetch", oldFetch);
    rmSync(d, { recursive: true, force: true });
  }
});
