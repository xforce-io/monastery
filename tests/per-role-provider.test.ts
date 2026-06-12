// tests/per-role-provider.test.ts — #133: agents.<role>.provider lets a role run on a DIFFERENT provider
// than the globally selected one (cross-model review). Provider resolution is lazy (health-checked only when
// some role actually asks for a non-primary provider) and best-effort (unhealthy target -> primary + warn).
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProviderPool, type ProviderHealth, type ProviderName, type ProviderSelection } from "../src/provider/select.js";
import { resolveRoleRuntime } from "../src/provider/runtime.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { issueStep, type StepCtx } from "../src/engine/issue-step.js";
import { runImplement } from "../src/engine/patch.js";
import type { Issue } from "../src/types.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function selection(name: ProviderName, provider: FakeProvider): ProviderSelection {
  return { name, provider, health: { ok: true } };
}

function pool(
  primaryName: ProviderName,
  primary: FakeProvider,
  alt: FakeProvider,
  opts: { altHealth?: ProviderHealth; probes?: ProviderName[] } = {},
) {
  return makeProviderPool(selection(primaryName, primary), {
    health: async (name) => {
      opts.probes?.push(name);
      return opts.altHealth ?? { ok: true };
    },
    makeProvider: () => alt,
  });
}

// --- ProviderPool: lazy, cached health probing ---

test("pool.resolve(primary) returns the primary provider without probing", async () => {
  const primary = new FakeProvider({});
  const probes: ProviderName[] = [];
  const p = pool("claude", primary, new FakeProvider({}), { probes });
  expect(await p.resolve("claude")).toBe(primary);
  expect(probes).toEqual([]);
});

test("pool.resolve(other) probes health once and caches the provider", async () => {
  const alt = new FakeProvider({});
  const probes: ProviderName[] = [];
  const p = pool("claude", new FakeProvider({}), alt, { probes });
  expect(await p.resolve("codex")).toBe(alt);
  expect(await p.resolve("codex")).toBe(alt);
  expect(probes).toEqual(["codex"]);
});

test("pool.resolve(other) returns null when unhealthy, and caches the verdict", async () => {
  const probes: ProviderName[] = [];
  const p = pool("claude", new FakeProvider({}), new FakeProvider({}), { altHealth: { ok: false, reason: "no cli" }, probes });
  expect(await p.resolve("codex")).toBeNull();
  expect(await p.resolve("codex")).toBeNull();
  expect(probes).toEqual(["codex"]);
});

// --- resolveRoleRuntime: policy.provider -> {provider, model} ---

const primaryRt = (provider: FakeProvider) => ({ provider, model: "sonnet" });

test("no policy.provider -> primary runtime, no probe", async () => {
  const primary = new FakeProvider({});
  const probes: ProviderName[] = [];
  const p = pool("claude", primary, new FakeProvider({}), { probes });
  const rt = await resolveRoleRuntime({ agent: "t-none", policy: {}, level: "strong", ...primaryRt(primary), pool: p, env: {} });
  expect(rt.provider).toBe(primary);
  expect(rt.model).toBe("sonnet");
  expect(probes).toEqual([]);
});

test("provider 'different' with global claude -> codex provider, model re-resolved at codex's level", async () => {
  const primary = new FakeProvider({});
  const alt = new FakeProvider({});
  const p = pool("claude", primary, alt);
  const rt = await resolveRoleRuntime({
    agent: "t-diff", policy: { provider: "different" }, level: "strong",
    ...primaryRt(primary), pool: p, env: { MONASTERY_CODEX_MODEL_STRONG: "gpt-test" },
  });
  expect(rt.provider).toBe(alt);
  expect(rt.model).toBe("gpt-test");
});

test("provider 'different' with global codex -> claude provider with claude's level default", async () => {
  const primary = new FakeProvider({});
  const alt = new FakeProvider({});
  const p = pool("codex", primary, alt);
  const rt = await resolveRoleRuntime({
    agent: "t-rev", policy: { provider: "different" }, level: "strong",
    provider: primary, model: "", pool: p, env: {},
  });
  expect(rt.provider).toBe(alt);
  expect(rt.model).toBe("sonnet"); // claude's strong default
});

test("explicit provider equal to the primary -> primary runtime, no probe", async () => {
  const primary = new FakeProvider({});
  const probes: ProviderName[] = [];
  const p = pool("claude", primary, new FakeProvider({}), { probes });
  const rt = await resolveRoleRuntime({ agent: "t-same", policy: { provider: "claude" }, level: "strong", ...primaryRt(primary), pool: p, env: {} });
  expect(rt.provider).toBe(primary);
  expect(probes).toEqual([]);
});

test("unhealthy target -> falls back to primary and warns once", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const primary = new FakeProvider({});
  const p = pool("claude", primary, new FakeProvider({}), { altHealth: { ok: false, reason: "down" } });
  const opts = { agent: "t-fallback", policy: { provider: "different" as const }, level: "strong" as const, ...primaryRt(primary), pool: p, env: {} };
  const rt1 = await resolveRoleRuntime(opts);
  const rt2 = await resolveRoleRuntime(opts);
  expect(rt1.provider).toBe(primary);
  expect(rt1.model).toBe("sonnet");
  expect(rt2.provider).toBe(primary);
  const fallbackWarns = warn.mock.calls.filter(([m]) => String(m).includes("t-fallback"));
  expect(fallbackWarns.length).toBe(1);
});

test("explicit model override is ignored (with a warn) when the role runs cross-provider", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const primary = new FakeProvider({});
  const alt = new FakeProvider({});
  const p = pool("claude", primary, alt);
  const rt = await resolveRoleRuntime({
    agent: "t-model", policy: { provider: "different", model: "opus" }, level: "strong",
    provider: primary, model: "opus", explicitModel: "opus", pool: p, env: {},
  });
  expect(rt.provider).toBe(alt);
  expect(rt.model).toBe(""); // codex strong default (empty = CLI default), NOT "opus"
  expect(warn.mock.calls.some(([m]) => String(m).includes("t-model") && String(m).includes("opus"))).toBe(true);
});

test("no pool in ctx -> policy.provider is inert (older callers unchanged)", async () => {
  const primary = new FakeProvider({});
  const rt = await resolveRoleRuntime({ agent: "t-nopool", policy: { provider: "different" }, level: "strong", ...primaryRt(primary), env: {} });
  expect(rt.provider).toBe(primary);
  expect(rt.model).toBe("sonnet");
});

// --- end to end: the reviewer runs on the OTHER provider while the patcher stays on the primary ---

const issue: Issue = { number: 7, title: "fix the bug", body: "it crashes", labels: [], state: "open" };

function stepCtx(gh: FakeGitHub, provider: FakeProvider, over: Partial<StepCtx> = {}): StepCtx {
  return {
    repo: "o/r", gh, provider, model: "sonnet",
    artifactRoot: mkdtempSync(join(tmpdir(), "monastery-prp-")),
    fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
    ws: new FakeWorkspace(), now: () => 0, ...over,
  };
}

test("agents.reviewer.provider='different': reviewer runs on the alt provider, patcher on the primary", async () => {
  vi.stubEnv("MONASTERY_CODEX_MODEL_STRONG", "gpt-review");
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  const primary = new FakeProvider({}); // patcher: edits land in the workspace, not files
  const alt = new FakeProvider({ "review.json": JSON.stringify({ findings: [] }) });
  const ctx = stepCtx(gh, primary, {
    ws: new FakeWorkspace({ diff: "some patch", tests: true }),
    repoPolicy: { agents: { reviewer: { provider: "different" } } },
    providerPool: pool("claude", primary, alt),
  });
  const out = await runImplement(ctx, issue);
  expect(out.kind).toBe("progressed");
  expect(primary.calls.length).toBe(1);           // patcher impl run only
  expect(alt.calls.length).toBe(1);               // the review ran on the alt provider
  expect(alt.calls[0].model).toBe("gpt-review");  // model re-resolved for codex
});

test("agents.maintainer.provider='different': the maintainer runs on the alt provider", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 5, title: "x", body: "y", labels: [], state: "open" }] });
  const primary = new FakeProvider({});
  const alt = new FakeProvider({ "actions.json": JSON.stringify({ actions: [] }) });
  const ctx = stepCtx(gh, primary, {
    repoPolicy: { agents: { maintainer: { provider: "different" } } },
    providerPool: pool("claude", primary, alt),
  });
  await issueStep(ctx, 5);
  expect(alt.calls.length).toBe(1);
  expect(primary.calls.length).toBe(0);
});

test("reviewer provider unhealthy -> review still runs, on the primary", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const gh = new FakeGitHub({ thesis: "T", issues: [issue] });
  // call 0 = patcher (no files), call 1 = reviewer fallback on the SAME primary provider
  const primary = new FakeProvider([{ files: {} }, { files: { "review.json": JSON.stringify({ findings: [] }) } }]);
  const ctx = stepCtx(gh, primary, {
    ws: new FakeWorkspace({ diff: "some patch", tests: true }),
    repoPolicy: { agents: { reviewer: { provider: "different" } } },
    providerPool: pool("claude", primary, new FakeProvider({}), { altHealth: { ok: false, reason: "down" } }),
  });
  const out = await runImplement(ctx, issue);
  expect(out.kind).toBe("progressed");
  expect(primary.calls.length).toBe(2); // both runs on the primary
});
