// tests/patch-language.test.ts — #76 end-to-end: the outward-text language policy reaches the patcher and
// reviewer through runImplement, and an off-language author summary leaves a non-blocking warn trail.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { runImplement } from "../src/engine/patch.js";
import type { StepCtx } from "../src/engine/issue-step.js";

const issue = { number: 7, title: "fix the bug", body: "it crashes", labels: [], state: "open" as const };

function ctx(gh: FakeGitHub, ws: FakeWorkspace, provider: FakeProvider, language?: string): StepCtx {
  return {
    repo: "o/r", gh, provider, model: "sonnet",
    artifactRoot: mkdtempSync(join(tmpdir(), "monastery-lang-")),
    fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
    ws, now: () => 0, language,
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

test("the patcher and reviewer both receive the language directive when a policy is set", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  // No ctx.review -> the real defaultReview path runs the reviewer through this same provider.
  const provider = new FakeProvider({ "review.json": '{"findings":[]}' }, "本次改动修复了崩溃问题，并补充了对应测试。");
  const out = await runImplement(ctx(gh, ws, provider, "zh-CN"), issue);
  expect(out.kind).toBe("progressed");
  // patcher = the first call; its persona must carry the policy directive.
  expect(provider.calls[0].persona).toContain("<language-policy");
  expect(provider.calls[0].persona).toContain("zh-CN");
  // reviewer = a later call (artifact-only, falls back to this provider in tests); context carries it too.
  const reviewerCall = provider.calls.find((c) => c.context.includes("<language-policy"));
  expect(reviewerCall).toBeDefined();
  expect(reviewerCall!.context).toContain("zh-CN");
});

test("no language policy set -> no directive injected (back-compat)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const provider = new FakeProvider({ "review.json": '{"findings":[]}' }, "fixed it");
  await runImplement(ctx(gh, ws, provider), issue);
  for (const c of provider.calls) {
    expect(c.persona).not.toContain("<language-policy");
    expect(c.context).not.toContain("<language-policy");
  }
});

test("off-language author summary (zh-CN target, English summary) leaves a non-blocking warn — PR still opens", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const englishSummary =
    "This change reworks the crash handling path and adds a regression test that reproduces the original " +
    "failure before the fix, so the suite now guards against it returning in a future refactor of the module.";
  const provider = new FakeProvider({ "review.json": '{"findings":[]}' }, englishSummary);
  const out = await runImplement(ctx(gh, ws, provider, "zh-CN"), issue);
  // Non-blocking: the PR is still opened (draft PR is the human safety net, not a hard gate).
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);
  // But the drift is recorded for the human via a warn.
  const warned = warnSpy.mock.calls.some((c) => String(c[0]).match(/language|off-language|漂移/i));
  expect(warned).toBe(true);
});

test("on-language author summary (zh-CN target, Chinese summary) does NOT warn", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const ws = new FakeWorkspace({ diff: "some patch", tests: true });
  const provider = new FakeProvider(
    { "review.json": '{"findings":[]}' },
    "本次改动重写了崩溃处理路径，并新增一个回归测试，在修复前先复现原始失败，使测试套件能持续防止它再次出现。",
  );
  await runImplement(ctx(gh, ws, provider, "zh-CN"), issue);
  const warned = warnSpy.mock.calls.some((c) => String(c[0]).match(/off-language|语言漂移/i));
  expect(warned).toBe(false);
});
