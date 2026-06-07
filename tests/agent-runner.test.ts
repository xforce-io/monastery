// tests/agent-runner.test.ts — the shared structured-agent runner (DRYs maintainer/reviewer parse+fallback).
import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { FakeProvider } from "../src/provider/fake.js";
import { runStructuredAgent, type StructuredAgentSpec } from "../src/agents/spec.js";

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
  rmSync(dir, { recursive: true, force: true });
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

test("returns null when nothing schema-valid was produced", async () => {
  const dir = newDir();
  expect(await runStructuredAgent(spec, { n: 2 }, rt(new FakeProvider({}), dir))).toBeNull();
  expect(await runStructuredAgent(spec, { n: 2 }, rt(new FakeProvider({ "out.json": '{"value":"NaN"}' }), dir))).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("logs artifact path and parse error when artifact JSON is invalid", async () => {
  const dir = newDir();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    // A string value with an unescaped double-quote breaks JSON.parse
    const out = await runStructuredAgent(
      spec, { n: 2 },
      rt(new FakeProvider({ "out.json": '{"value":"bad "quoted" value"}' }), dir),
    );
    expect(out).toBeNull();
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes("out.json"))).toBe(true);
    expect(msgs.some((m) => /json|parse/i.test(m))).toBe(true);
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs artifact path and schema error when JSON is valid but schema-invalid", async () => {
  const dir = newDir();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const out = await runStructuredAgent(
      spec, { n: 2 },
      rt(new FakeProvider({ "out.json": '{"value":"not-a-number"}' }), dir),
    );
    expect(out).toBeNull();
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

test("gives up after exhausting retries when JSON parse keeps failing", async () => {
  const dir = newDir();
  // Always returns the same bad JSON — the retry will also fail
  const provider = new FakeProvider({ "out.json": '{"value":"bad "json"}' });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const out = await runStructuredAgent(spec, { n: 2 }, rt(provider, dir));
    expect(out).toBeNull();
    expect(provider.calls).toHaveLength(2); // initial attempt + 1 retry
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to stdout when repair artifact is still invalid JSON but resultText is valid", async () => {
  const dir = newDir();
  // attempt 0: bad artifact JSON, no stdout
  // attempt 1 (repair): still bad artifact JSON but valid resultText — the stdout fallback must be tried
  const provider = new FakeProvider([
    { files: { "out.json": '{"value":"bad "json"}' } },
    { files: { "out.json": '{"value":"still "bad"}' }, resultText: '{"value":99}' },
  ]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const out = await runStructuredAgent(spec, { n: 2 }, rt(provider, dir));
    expect(out).toEqual({ value: 99 });
    expect(provider.calls).toHaveLength(2);
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
