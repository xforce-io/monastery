// tests/maintainer.test.ts — contract: item + context -> schema-valid Action[] (or null on failure).
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider/fake.js";
import { maintainer, type MaintainerInput } from "../src/agents/maintainer.js";
import type { Action } from "../src/shell/actions.js";

const newDir = () => mkdtempSync(join(tmpdir(), "monastery-maint-"));
const input: MaintainerInput = {
  thesis: "monastery is a thin governance shell.",
  issue: { number: 7, title: "add dark mode", body: "please", labels: ["type:feature"], state: "open" },
  comments: [{ id: "1001", body: "any update? (human, no marker)", author: "alice" }],
};

test("valid actions.json (object-wrapped) parses to a typed Action[] covering several kinds", async () => {
  const actions: Action[] = [
    { kind: "relabel", num: 7, add: ["thesis:in"], remove: [] },
    { kind: "reply", num: 7, toCommentId: "1001", body: "on it" },
    { kind: "openDraftPR", num: 7, branch: "feat/7-dark-mode", title: "dark mode", body: "draft" },
    { kind: "propose", num: 7, proposal: "close", draft: "out of scope" },
  ];
  const dir = newDir();
  const out = await maintainer(new FakeProvider({ "actions.json": JSON.stringify({ actions }) }), "sonnet", input, dir);
  expect(out).toEqual(actions);
  rmSync(dir, { recursive: true, force: true });
});

test("a bare array (no { actions } wrapper) is also accepted", async () => {
  const dir = newDir();
  const out = await maintainer(
    new FakeProvider({ "actions.json": '[{"kind":"panel","num":7,"body":"thinking..."}]' }),
    "sonnet", input, dir,
  );
  expect(out).toEqual([{ kind: "panel", num: 7, body: "thinking..." }]);
  rmSync(dir, { recursive: true, force: true });
});

test("an empty actions array is valid (explicitly: nothing to do this tick)", async () => {
  const dir = newDir();
  const out = await maintainer(new FakeProvider({ "actions.json": '{"actions":[]}' }), "sonnet", input, dir);
  expect(out).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("missing file and no stdout => null (failed to produce output)", async () => {
  const dir = newDir();
  const out = await maintainer(new FakeProvider({}), "sonnet", input, dir);
  expect(out).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("an invalid action poisons the batch => null (no partial execution)", async () => {
  const dir = newDir();
  const out = await maintainer(
    new FakeProvider({ "actions.json": '{"actions":[{"kind":"relabel","num":7,"add":[],"remove":[]},{"kind":"doClose","num":7}]}' }),
    "sonnet", input, dir,
  );
  expect(out).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("fallback: actions printed to stdout (fenced) when no file written", async () => {
  const dir = newDir();
  const out = await maintainer(
    new FakeProvider({}, 'Here:\n```json\n{"actions":[{"kind":"relabel","num":7,"add":["type:bug"],"remove":[]}]}\n```'),
    "sonnet", input, dir,
  );
  expect(out).toEqual([{ kind: "relabel", num: 7, add: ["type:bug"], remove: [] }]);
  rmSync(dir, { recursive: true, force: true });
});

test("the file takes precedence over the stdout fallback", async () => {
  const dir = newDir();
  const out = await maintainer(
    new FakeProvider({ "actions.json": '{"actions":[{"kind":"panel","num":7,"body":"from-file"}]}' }, '{"actions":[]}'),
    "sonnet", input, dir,
  );
  expect(out).toEqual([{ kind: "panel", num: 7, body: "from-file" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("the agent is handed the thesis, issue, and human comments as context", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "actions.json": '{"actions":[]}' });
  await maintainer(provider, "sonnet", input, dir);
  const ctx = provider.calls[0].context;
  expect(ctx).toContain("thin governance shell"); // thesis
  expect(ctx).toContain("add dark mode");          // issue title
  expect(ctx).toContain("1001");                   // human comment id (so it can reply to it)
  expect(ctx).toContain("alice");                  // comment author (identity: who said it)
  expect(ctx).toContain("implement");              // the implement action is in the vocabulary
  expect(provider.calls[0].persona).toContain("maintainer");
  rmSync(dir, { recursive: true, force: true });
});

test("the agent accepts an implement action", async () => {
  const dir = newDir();
  const out = await maintainer(new FakeProvider({ "actions.json": '{"actions":[{"kind":"implement","num":7}]}' }), "sonnet", input, dir);
  expect(out).toEqual([{ kind: "implement", num: 7 }]);
  rmSync(dir, { recursive: true, force: true });
});

test("when a monastery PR is already open, the agent is told NOT to re-propose implement", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "actions.json": '{"actions":[]}' });
  await maintainer(provider, "sonnet", { ...input, pr: { branch: "feat/7-dark-mode", state: "open" } }, dir);
  const ctx = provider.calls[0].context;
  expect(ctx).toContain("feat/7-dark-mode"); // the open PR's branch is surfaced
  expect(ctx).toMatch(/open/);               // its state, so the agent won't re-implement
  rmSync(dir, { recursive: true, force: true });
});
