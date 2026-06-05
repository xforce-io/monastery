import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider/fake.js";
import { triager } from "../src/judges/triager.js";

const issue = { number: 1, title: "crash on save", body: "it throws", labels: [], state: "open" as const };
const newDir = () => mkdtempSync(join(tmpdir(), "monastery-triage-"));

test("valid triage.json file parses to the typed classification", async () => {
  const dir = newDir();
  const t = await triager(new FakeProvider({ "triage.json": '{"type":"bug"}' }), "haiku", issue, dir);
  expect(t).toEqual({ type: "bug" });
  rmSync(dir, { recursive: true, force: true });
});

test("missing triage.json => null", async () => {
  const dir = newDir();
  const t = await triager(new FakeProvider({}), "haiku", issue, dir);
  expect(t).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("invalid type => null", async () => {
  const dir = newDir();
  const t = await triager(new FakeProvider({ "triage.json": '{"type":"chore"}' }), "haiku", issue, dir);
  expect(t).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("fallback: classification printed to stdout (fenced) when no file written", async () => {
  const dir = newDir();
  const t = await triager(new FakeProvider({}, 'My call:\n```json\n{"type":"feature"}\n```'), "haiku", issue, dir);
  expect(t).toEqual({ type: "feature" });
  rmSync(dir, { recursive: true, force: true });
});

test("file takes precedence over stdout fallback", async () => {
  const dir = newDir();
  const t = await triager(new FakeProvider({ "triage.json": '{"type":"question"}' }, '{"type":"bug"}'), "haiku", issue, dir);
  expect(t).toEqual({ type: "question" });
  rmSync(dir, { recursive: true, force: true });
});
