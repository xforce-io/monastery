// tests/maintainer.test.ts — contract: item + context -> schema-valid Action[] (or null on failure).
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider/fake.js";
import { maintainer, type MaintainerInput } from "../src/agents/maintainer.js";
import { StructuredAgentError } from "../src/agents/spec.js";
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

test("missing file and no stdout => structured failure", async () => {
  const dir = newDir();
  await expect(maintainer(new FakeProvider({}), "sonnet", input, dir))
    .rejects.toMatchObject({ failure: { reason: "missing_artifact" } });
  rmSync(dir, { recursive: true, force: true });
});

test("an invalid action poisons the batch => structured failure (no partial execution)", async () => {
  const dir = newDir();
  await expect(maintainer(
    new FakeProvider({ "actions.json": '{"actions":[{"kind":"relabel","num":7,"add":[],"remove":[]},{"kind":"doClose","num":7}]}' }),
    "sonnet", input, dir,
  )).rejects.toBeInstanceOf(StructuredAgentError);
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

test("the maintainer is a PM: backlog is surfaced and the persona carries a prioritization methodology", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "actions.json": '{"actions":[]}' });
  await maintainer(provider, "sonnet", {
    ...input,
    backlog: [{ number: 9, title: "rival feature", state: "open", labels: ["type:feature"] }],
  }, dir);
  const ctx = provider.calls[0].context;
  expect(ctx).toContain("rival feature");                  // sees the rest of the backlog
  const persona = provider.calls[0].persona;
  expect(persona).toMatch(/project manager|PM|prioriti/i); // PM role
  expect(persona).toMatch(/worth|priorit|defer|backlog/i); // a methodology for what to advance
  rmSync(dir, { recursive: true, force: true });
});

test("the agent accepts spec and endorse actions", async () => {
  const dir = newDir();
  const out = await maintainer(
    new FakeProvider({ "actions.json": '{"actions":[{"kind":"spec","num":7,"body":"plan","parties":["a","b"]},{"kind":"endorse","num":7,"version":1}]}' }),
    "sonnet", input, dir,
  );
  expect(out).toEqual([
    { kind: "spec", num: 7, body: "plan", parties: ["a", "b"] },
    { kind: "endorse", num: 7, version: 1 },
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("consensus state (spec + endorsers + reached) and self identity are surfaced in context", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "actions.json": '{"actions":[]}' });
  await maintainer(provider, "sonnet", {
    ...input,
    self: "b-bot",
    consensus: { spec: { version: 2, parties: ["a-bot", "b-bot"], body: "agreed plan" }, endorsedCurrent: ["a-bot"], reached: false },
  }, dir);
  const ctx = provider.calls[0].context;
  expect(ctx).toContain("b-bot");          // self (so the agent knows who it is / whether it endorsed)
  expect(ctx).toContain("agreed plan");    // current spec body
  expect(ctx).toContain("a-bot");          // endorsers so far
  expect(ctx).toMatch(/version.*2|v2/);    // current version
  rmSync(dir, { recursive: true, force: true });
});

test("the agent is dissuaded from proposing implement on epic / broad / tracking issues", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "actions.json": '{"actions":[]}' });
  await maintainer(provider, "sonnet", input, dir);
  const ctx = provider.calls[0].context;
  expect(ctx).toMatch(/epic/i);                       // names the epic/broad case explicitly
  expect(ctx).toMatch(/broad|tracking|宽泛|跟踪/i);   // and the broad/tracking flavor of it
  // the guidance ties "don't implement" to the epic/broad case (one block, not two unrelated mentions)
  const epicBlock = ctx.split("\n\n").find((b) => /epic/i.test(b)) ?? "";
  expect(epicBlock).toMatch(/implement/i);
  rmSync(dir, { recursive: true, force: true });
});

test("the agent accepts an implement action", async () => {
  const dir = newDir();
  const out = await maintainer(new FakeProvider({ "actions.json": '{"actions":[{"kind":"implement","num":7}]}' }), "sonnet", input, dir);
  expect(out).toEqual([{ kind: "implement", num: 7 }]);
  rmSync(dir, { recursive: true, force: true });
});

test("upstream cross-repo dependencies are surfaced in context (state + ref)", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "actions.json": '{"actions":[]}' });
  await maintainer(provider, "sonnet", {
    ...input,
    deps: [{ ref: "owner/other#42", state: "closed", title: "upstream fix" }],
  }, dir);
  const ctx = provider.calls[0].context;
  expect(ctx).toContain("owner/other#42");
  expect(ctx).toContain("closed");
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
