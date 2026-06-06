import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider/fake.js";
import { reviewer } from "../src/judges/reviewer.js";
import type { Issue } from "../src/types.js";

const issue: Issue = { number: 1, title: "t", body: "b", labels: [], state: "open" };
const dir = () => mkdtempSync(join(tmpdir(), "rev-"));

test("valid review.json -> parsed findings", async () => {
  const d = dir();
  const provider = new FakeProvider({
    "review.json": JSON.stringify({ findings: [{ severity: "blocking", title: "wrong", detail: "x" }] }),
  });
  const v = await reviewer(provider, "haiku", { diff: "d", issue }, d);
  expect(v).toEqual({ findings: [{ severity: "blocking", title: "wrong", detail: "x" }] });
  rmSync(d, { recursive: true, force: true });
});

test("empty findings -> clean verdict", async () => {
  const d = dir();
  const v = await reviewer(new FakeProvider({ "review.json": '{"findings":[]}' }), "haiku", { diff: "d", issue }, d);
  expect(v).toEqual({ findings: [] });
  rmSync(d, { recursive: true, force: true });
});

test("missing review.json -> null", async () => {
  const d = dir();
  const v = await reviewer(new FakeProvider({}), "haiku", { diff: "d", issue }, d);
  expect(v).toBeNull();
  rmSync(d, { recursive: true, force: true });
});

test("invalid schema -> null", async () => {
  const d = dir();
  const v = await reviewer(new FakeProvider({ "review.json": '{"findings":[{"severity":"nope"}]}' }), "haiku", { diff: "d", issue }, d);
  expect(v).toBeNull();
  rmSync(d, { recursive: true, force: true });
});
