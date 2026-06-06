// tests/agent-runner.test.ts — the shared structured-agent runner (DRYs maintainer/reviewer parse+fallback).
import { expect, test } from "vitest";
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
