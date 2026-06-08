// tests/per-role-model.test.ts — #72-A: each agent's model resolves through effectivePolicy(spec, repoPolicy).
// Until now `agents.<name>.model` was documented (docs/LOCAL-LAYOUT.md) but never consumed — the engine
// always used ctx.model. These tests pin that per-role model overrides actually reach the provider.
import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { issueStep, type StepCtx } from "../src/engine/issue-step.js";
import { runImplement } from "../src/engine/patch.js";
import type { Action } from "../src/shell/actions.js";
import type { Issue } from "../src/types.js";

const ghWith = (issue: Issue) => new FakeGitHub({ thesis: "T", issues: [issue] });
const actionsJson = (actions: Action[]) => ({ "actions.json": JSON.stringify({ actions }) });
const issue: Issue = { number: 7, title: "fix the bug", body: "it crashes", labels: [], state: "open" };

function stepCtx(gh: FakeGitHub, provider: FakeProvider, over: Partial<StepCtx> = {}): StepCtx {
  return {
    repo: "o/r", gh, provider, model: "sonnet",
    artifactRoot: mkdtempSync(join(tmpdir(), "monastery-prm-")),
    fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
    ws: new FakeWorkspace(), now: () => 0, ...over,
  };
}

// --- maintainer ---

test("maintainer uses agents.maintainer.model over ctx.model", async () => {
  const gh = ghWith({ number: 5, title: "x", body: "y", labels: [], state: "open" });
  const provider = new FakeProvider(actionsJson([]));
  await issueStep(stepCtx(gh, provider, { repoPolicy: { agents: { maintainer: { model: "opus" } } } }), 5);
  expect(provider.calls[0].model).toBe("opus");
});

test("maintainer falls back to ctx.model when no per-agent override", async () => {
  const gh = ghWith({ number: 5, title: "x", body: "y", labels: [], state: "open" });
  const provider = new FakeProvider(actionsJson([]));
  await issueStep(stepCtx(gh, provider, { repoPolicy: { agents: { reviewer: { model: "haiku" } } } }), 5);
  expect(provider.calls[0].model).toBe("sonnet");
});

// --- patcher + reviewer: the issue's headline acceptance (two roles, two distinct models) ---

function implCtx(over: Partial<StepCtx>): StepCtx {
  const gh = ghWith(issue);
  // call 0 = patcher (writes no file; diff comes from the workspace), call 1 = reviewer (writes review.json).
  const provider = new FakeProvider([{ files: {} }, { files: { "review.json": JSON.stringify({ findings: [] }) } }]);
  return stepCtx(gh, provider, { ws: new FakeWorkspace({ diff: "some patch", tests: true }), ...over });
}

test("patcher and reviewer use their own configured models in one runImplement", async () => {
  const c = implCtx({ repoPolicy: { agents: { patcher: { model: "opus" }, reviewer: { model: "haiku" } } } });
  const out = await runImplement(c, issue);
  expect(out.kind).toBe("progressed");
  const provider = c.provider as FakeProvider;
  expect(provider.calls[0].model).toBe("opus");   // patcher impl run
  expect(provider.calls[1].model).toBe("haiku");  // self-review run
});

test("patcher and reviewer fall back to ctx.model with no overrides", async () => {
  const c = implCtx({});
  await runImplement(c, issue);
  const provider = c.provider as FakeProvider;
  expect(provider.calls[0].model).toBe("sonnet");
  expect(provider.calls[1].model).toBe("sonnet");
});

// --- reviewModel / MONASTERY_REVIEW_MODEL back-compat, unified through effectivePolicy ---

test("legacy ctx.reviewModel still drives the reviewer when no per-agent reviewer.model", async () => {
  const c = implCtx({ reviewModel: "haiku" });
  await runImplement(c, issue);
  const provider = c.provider as FakeProvider;
  expect(provider.calls[0].model).toBe("sonnet"); // patcher untouched by reviewModel
  expect(provider.calls[1].model).toBe("haiku");  // legacy review model honored
});

test("agents.reviewer.model wins over the legacy ctx.reviewModel", async () => {
  const c = implCtx({ reviewModel: "haiku", repoPolicy: { agents: { reviewer: { model: "opus" } } } });
  await runImplement(c, issue);
  expect((c.provider as FakeProvider).calls[1].model).toBe("opus");
});
