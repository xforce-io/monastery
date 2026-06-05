// tests/thesis-gate.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider/fake.js";
import { thesisGate } from "../src/judges/thesis-gate.js";

const issue = { number: 1, title: "add chat", body: "social chat?", labels: [], state: "open" as const };
const newDir = () => mkdtempSync(join(tmpdir(), "monastery-gate-"));

test("valid verdict.json parses to the typed verdict", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"off thesis"}' });
  const v = await thesisGate(provider, "haiku", "thesis text", issue, dir);
  expect(v).toEqual({ verdict: "out", reason: "off thesis" });
  rmSync(dir, { recursive: true, force: true });
});

test("missing verdict.json => null (treated as skip+alert upstream)", async () => {
  const dir = newDir();
  const v = await thesisGate(new FakeProvider({}), "haiku", "t", issue, dir);
  expect(v).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("invalid schema => null", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"maybe"}' });
  const v = await thesisGate(provider, "haiku", "t", issue, dir);
  expect(v).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("fallback: bare JSON in stdout result when no file written", async () => {
  const dir = newDir();
  const provider = new FakeProvider({}, '{"verdict":"in","reason":"ok"}');
  const v = await thesisGate(provider, "haiku", "t", issue, dir);
  expect(v).toEqual({ verdict: "in", reason: "ok" });
  rmSync(dir, { recursive: true, force: true });
});

test("fallback: fenced ```json block in stdout result", async () => {
  const dir = newDir();
  const provider = new FakeProvider({}, 'Here is my call:\n```json\n{"verdict":"out","reason":"off"}\n```\n');
  const v = await thesisGate(provider, "haiku", "t", issue, dir);
  expect(v).toEqual({ verdict: "out", reason: "off" });
  rmSync(dir, { recursive: true, force: true });
});

test("fallback: prose-wrapped JSON in stdout result", async () => {
  const dir = newDir();
  const provider = new FakeProvider({}, 'I judge this {"verdict":"unclear","reason":"y"} given the thesis.');
  const v = await thesisGate(provider, "haiku", "t", issue, dir);
  expect(v).toEqual({ verdict: "unclear", reason: "y" });
  rmSync(dir, { recursive: true, force: true });
});

test("verdict.json file takes precedence over stdout fallback", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"from file"}' }, '{"verdict":"out","reason":"from stdout"}');
  const v = await thesisGate(provider, "haiku", "t", issue, dir);
  expect(v).toEqual({ verdict: "in", reason: "from file" });
  rmSync(dir, { recursive: true, force: true });
});

test("neither file nor parseable stdout => null", async () => {
  const dir = newDir();
  const provider = new FakeProvider({}, "I could not decide.");
  const v = await thesisGate(provider, "haiku", "t", issue, dir);
  expect(v).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});
