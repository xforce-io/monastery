// tests/agent-runner.test.ts — the shared structured-agent runner (DRYs maintainer/reviewer parse+fallback).
import { expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { FakeProvider } from "../src/provider/fake.js";
import { runStructuredAgent, StructuredAgentError, type StructuredAgentSpec } from "../src/agents/spec.js";

const schema = z.object({ value: z.number() });
const spec: StructuredAgentSpec<{ n: number }, { value: number }> = {
  name: "demo", role: "double a number", persona: "You double numbers.", sandbox: "artifact-only",
  policy: {}, artifact: "out.json", schema,
  buildContext: (input) => `double ${input.n}; write out.json`,
};
const newDir = () => mkdtempSync(join(tmpdir(), "monastery-runner-"));
const rt = (provider: FakeProvider, artifactDir: string) => ({ provider, model: "sonnet", artifactDir });

test("reads the schema-valid artifact file and returns the parsed output", async () => {
  const dir = newDir();
  const out = await runStructuredAgent(spec, { n: 2 }, rt(new FakeProvider({ "out.json": '{"value":4}' }), dir));
  expect(out).toEqual({ value: 4 });
  rmSync(dir, { recursive: true, force: true });
});

test("hands the spec's persona and built context to the provider", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "out.json": '{"value":4}' });
  await runStructuredAgent(spec, { n: 2 }, rt(provider, dir));
  expect(provider.calls[0].persona).toBe("You double numbers.");
  expect(provider.calls[0].context).toContain("double 2");
  expect(provider.calls[0].schema).toBeDefined();
  expect(provider.calls[0].artifact).toBe("out.json");
  rmSync(dir, { recursive: true, force: true });
});

test("artifact-only agents use OpenAI-compatible structured API when configured", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "out.json": '{"value":0}' });
  const oldEndpoint = process.env.MONASTERY_STRUCTURED_ENDPOINT;
  const oldKey = process.env.MONASTERY_STRUCTURED_API_KEY;
  const oldModel = process.env.MONASTERY_STRUCTURED_MODEL;
  process.env.MONASTERY_STRUCTURED_ENDPOINT = "https://structured.example/v1";
  process.env.MONASTERY_STRUCTURED_API_KEY = "secret";
  process.env.MONASTERY_STRUCTURED_MODEL = "fast-json";
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("fast-json");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toContain("double 2");
    expect(body.tools[0].function.name).toBe("output");
    expect(body.tools[0].function.parameters.properties.value.type).toBe("number");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "output" } });
    return new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: "output", arguments: "{\"value\":4}" } }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const oldFetch = globalThis.fetch;
  vi.stubGlobal("fetch", fetchMock);
  try {
    const out = await runStructuredAgent(spec, { n: 2 }, rt(provider, dir));
    expect(out).toEqual({ value: 4 });
    expect(provider.calls).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(dir, "out.json"), "utf8"))).toEqual({ value: 4 });
  } finally {
    if (oldEndpoint === undefined) delete process.env.MONASTERY_STRUCTURED_ENDPOINT;
    else process.env.MONASTERY_STRUCTURED_ENDPOINT = oldEndpoint;
    if (oldKey === undefined) delete process.env.MONASTERY_STRUCTURED_API_KEY;
    else process.env.MONASTERY_STRUCTURED_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.MONASTERY_STRUCTURED_MODEL;
    else process.env.MONASTERY_STRUCTURED_MODEL = oldModel;
    vi.stubGlobal("fetch", oldFetch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact-only agents fall back to the active provider when structured API is not configured", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "out.json": '{"value":4}' });
  const oldEndpoint = process.env.MONASTERY_STRUCTURED_ENDPOINT;
  const oldKey = process.env.MONASTERY_STRUCTURED_API_KEY;
  delete process.env.MONASTERY_STRUCTURED_ENDPOINT;
  delete process.env.MONASTERY_STRUCTURED_API_KEY;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const out = await runStructuredAgent({ ...spec, name: "fallback-demo" }, { n: 2 }, rt(provider, dir));
    expect(out).toEqual({ value: 4 });
    expect(provider.calls).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("structured API not configured"))).toBe(true);
  } finally {
    warn.mockRestore();
    if (oldEndpoint === undefined) delete process.env.MONASTERY_STRUCTURED_ENDPOINT;
    else process.env.MONASTERY_STRUCTURED_ENDPOINT = oldEndpoint;
    if (oldKey === undefined) delete process.env.MONASTERY_STRUCTURED_API_KEY;
    else process.env.MONASTERY_STRUCTURED_API_KEY = oldKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace agents do not route through the structured API", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "out.json": '{"value":4}' });
  const oldEndpoint = process.env.MONASTERY_STRUCTURED_ENDPOINT;
  const oldKey = process.env.MONASTERY_STRUCTURED_API_KEY;
  process.env.MONASTERY_STRUCTURED_ENDPOINT = "https://structured.example/v1";
  process.env.MONASTERY_STRUCTURED_API_KEY = "secret";
  const fetchMock = vi.fn();
  const oldFetch = globalThis.fetch;
  vi.stubGlobal("fetch", fetchMock);
  try {
    const out = await runStructuredAgent({ ...spec, sandbox: "workspace-clone" }, { n: 2 }, rt(provider, dir));
    expect(out).toEqual({ value: 4 });
    expect(provider.calls).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    if (oldEndpoint === undefined) delete process.env.MONASTERY_STRUCTURED_ENDPOINT;
    else process.env.MONASTERY_STRUCTURED_ENDPOINT = oldEndpoint;
    if (oldKey === undefined) delete process.env.MONASTERY_STRUCTURED_API_KEY;
    else process.env.MONASTERY_STRUCTURED_API_KEY = oldKey;
    vi.stubGlobal("fetch", oldFetch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to fenced JSON in stdout when no artifact file is written", async () => {
  const dir = newDir();
  const out = await runStructuredAgent(spec, { n: 2 }, rt(new FakeProvider({}, 'here:\n```json\n{"value":4}\n```'), dir));
  expect(out).toEqual({ value: 4 });
  rmSync(dir, { recursive: true, force: true });
});

test("the artifact file takes precedence over the stdout fallback", async () => {
  const dir = newDir();
  const out = await runStructuredAgent(spec, { n: 2 }, rt(new FakeProvider({ "out.json": '{"value":1}' }, '{"value":9}'), dir));
  expect(out).toEqual({ value: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test("fails fast with diagnostics when nothing schema-valid was produced", async () => {
  const dir = newDir();
  await expect(runStructuredAgent(spec, { n: 2 }, rt(new FakeProvider({}), dir)))
    .rejects.toMatchObject({ failure: { reason: "missing_artifact", artifactPath: join(dir, "out.json") } });
  await expect(runStructuredAgent(spec, { n: 2 }, rt(new FakeProvider({ "out.json": '{"value":"NaN"}' }), dir)))
    .rejects.toMatchObject({ failure: { reason: "schema_invalid", artifactPath: join(dir, "out.json"), repairAttempts: 1 } });
  rmSync(dir, { recursive: true, force: true });
});

test("fails fast with artifact path and parse error when artifact JSON stays invalid", async () => {
  const dir = newDir();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    // A string value with an unescaped double-quote breaks JSON.parse
    await expect(runStructuredAgent(
      spec, { n: 2 },
      rt(new FakeProvider({ "out.json": '{"value":"bad "quoted" value"}' }), dir),
    )).rejects.toMatchObject({
      failure: { reason: "invalid_json", artifactPath: join(dir, "out.json"), repairAttempts: 1 },
    });
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes("out.json"))).toBe(true);
    expect(msgs.some((m) => /json|parse/i.test(m))).toBe(true);
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails fast with artifact path and schema error when JSON stays schema-invalid", async () => {
  const dir = newDir();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(runStructuredAgent(
      spec, { n: 2 },
      rt(new FakeProvider({ "out.json": '{"value":"not-a-number"}' }), dir),
    )).rejects.toMatchObject({
      failure: { reason: "schema_invalid", artifactPath: join(dir, "out.json"), repairAttempts: 1 },
    });
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes("out.json"))).toBe(true);
    expect(msgs.some((m) => /schema/i.test(m))).toBe(true);
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retries once on JSON parse failure and returns fixed output on second attempt", async () => {
  const dir = newDir();
  const provider = new FakeProvider([
    { files: { "out.json": '{"value":"bad "json" here"}' } },  // first call: invalid JSON
    { files: { "out.json": '{"value":42}' } },                  // second call: valid
  ]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const out = await runStructuredAgent(spec, { n: 2 }, rt(provider, dir));
    expect(out).toEqual({ value: 42 });
    expect(provider.calls).toHaveLength(2);
    // The repair context passed to the second call must name the error and the bad content
    expect(provider.calls[1].context).toMatch(/repair|REPAIR/i);
    expect(provider.calls[1].context).toContain("JSON");
    // A warning must have been emitted on the first (failed) attempt
    expect(warn.mock.calls.length).toBeGreaterThan(0);
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retries once on schema failure and returns fixed output on second attempt", async () => {
  const dir = newDir();
  const provider = new FakeProvider([
    { files: { "out.json": '{"value":"not-a-number"}' } },
    { files: { "out.json": '{"value":24}' } },
  ]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const out = await runStructuredAgent(spec, { n: 2 }, rt(provider, dir));
    expect(out).toEqual({ value: 24 });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].context).toMatch(/repair|REPAIR/i);
    expect(provider.calls[1].context).toContain("Schema");
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#108 retries on missing_artifact (agent answered without writing the file) and recovers", async () => {
  const dir = newDir();
  // first pass: investigated but wrote nothing; retry: writes a valid artifact.
  const provider = new FakeProvider([
    { files: {} },
    { files: { "out.json": '{"value":4}' } },
  ]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const out = await runStructuredAgent(spec, { n: 2 }, rt(provider, dir));
    expect(out).toEqual({ value: 4 });
    expect(provider.calls).toHaveLength(2);                                  // retried once
    expect(provider.calls[1].context).toMatch(/did not write the required artifact/);
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gives up after exhausting retries when JSON parse keeps failing", async () => {
  const dir = newDir();
  // Always returns the same bad JSON — the retry will also fail
  const provider = new FakeProvider({ "out.json": '{"value":"bad "json"}' });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(runStructuredAgent(spec, { n: 2 }, rt(provider, dir)))
      .rejects.toBeInstanceOf(StructuredAgentError);
    expect(provider.calls).toHaveLength(2); // initial attempt + 1 retry
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not hide an invalid artifact by falling back to stdout after repair is exhausted", async () => {
  const dir = newDir();
  // attempt 0: bad artifact JSON, no stdout
  // attempt 1 (repair): still bad artifact JSON but valid resultText — artifact failure must still fail fast
  const provider = new FakeProvider([
    { files: { "out.json": '{"value":"bad "json"}' } },
    { files: { "out.json": '{"value":"still "bad"}' }, resultText: '{"value":99}' },
  ]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(runStructuredAgent(spec, { n: 2 }, rt(provider, dir)))
      .rejects.toMatchObject({ failure: { reason: "invalid_json", repairAttempts: 1 } });
    expect(provider.calls).toHaveLength(2);
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
