// tests/reconcile.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { reconcile, MAX_ITEMS_PER_TICK } from "../src/engine/reconcile.js";

const baseCtx = (gh: FakeGitHub, provider: FakeProvider) => ({
  repo: "o/r", gh, provider, model: "haiku", artifactRoot: mkdtempSync(join(tmpdir(), "monastery-rec-")),
  fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
  ws: new FakeWorkspace(),
});

test("processes virtual-new issues and reports advanced count", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "a", body: "b", labels: [], state: "open" },
    { number: 2, title: "c", body: "d", labels: ["monastery/state:done"], state: "open" }, // not runnable
  ]});
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"ok"}' });
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(1);
  expect(provider.calls.length).toBe(1); // only the virtual-new issue
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("caps work per tick at MAX_ITEMS_PER_TICK", async () => {
  const issues = Array.from({ length: MAX_ITEMS_PER_TICK + 5 }, (_, k) => ({
    number: k + 1, title: "t", body: "b", labels: [], state: "open" as const,
  }));
  const gh = new FakeGitHub({ thesis: "T", issues });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"ok"}' });
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(MAX_ITEMS_PER_TICK);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("only waiting items => idle true, long backoff", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "x", body: "y", labels: ["monastery/state:needs-approval", "thesis:out"], state: "open" },
  ]});
  const c = baseCtx(gh, new FakeProvider({}));
  // needs-approval but NOT approved => not in worklist; nothing advances
  const r = await reconcile(c);
  expect(r.advanced).toBe(0);
  expect(r.idle).toBe(true);
  expect(r.nextPollMs).toBeGreaterThanOrEqual(3600_000);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("triaged+thesis:in is runnable (classification); unclear/classified are not", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "a", body: "b", labels: ["monastery/state:triaged", "thesis:in"], state: "open" },
    { number: 2, title: "c", body: "d", labels: ["monastery/state:triaged", "thesis:unclear"], state: "open" },
    { number: 3, title: "e", body: "f", labels: ["monastery/state:classified", "thesis:in", "type:bug"], state: "open" },
  ]});
  const provider = new FakeProvider({ "triage.json": '{"type":"feature"}' });
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(1);          // only #1
  expect(provider.calls.length).toBe(1);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("try-fix issue is runnable (patch); patch-proposed is not", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "a", body: "b", labels: ["monastery:try-fix", "type:bug"], state: "open" },
    { number: 2, title: "c", body: "d", labels: ["monastery:try-fix", "monastery:patch-proposed"], state: "open" },
  ]});
  const ws = new FakeWorkspace({ diff: "patch", tests: true });
  const c = { ...baseCtx(gh, new FakeProvider({})), ws };
  const r = await reconcile(c);
  expect(r.advanced).toBe(1);          // only #1
  expect(ws.cloned).toHaveLength(1);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("patch-proposed issue is parked (not runnable)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: ["monastery:patch-proposed"], state: "open" }] });
  const c = baseCtx(gh, new FakeProvider({}));
  const r = await reconcile(c);
  expect(r.advanced).toBe(0);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
