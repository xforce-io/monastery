// tests/reconcile.test.ts — v2 L_repo: classify open items into active / awaiting-gate / terminal (PROTOCOL §6).
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import { reconcile, MAX_ITEMS_PER_TICK } from "../src/engine/reconcile.js";
import { executeSafe } from "../src/shell/actions.js";
import type { AgentConfig, AgentProvider, AgentResult } from "../src/provider/interface.js";

/** A maintainer stub that relabels whichever issue it is handed (num derived from the artifact dir). */
class RelabelEachProvider implements AgentProvider {
  public calls: AgentConfig[] = [];
  async run(config: AgentConfig): Promise<AgentResult> {
    this.calls.push(config);
    const num = Number(config.artifactDir.split("/").pop());
    mkdirSync(config.artifactDir, { recursive: true });
    writeFileSync(join(config.artifactDir, "actions.json"), JSON.stringify({ actions: [{ kind: "relabel", num, add: ["x"], remove: [] }] }));
    return { artifacts: [] };
  }
}

const baseCtx = (gh: FakeGitHub, provider: AgentProvider) => ({
  repo: "o/r", gh, provider, model: "sonnet", artifactRoot: mkdtempSync(join(tmpdir(), "monastery-rec-")),
  fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
  ws: new FakeWorkspace(),
  now: () => 0,
});
// a provider whose maintainer output relabels issue #n (so the active item "progresses")
const relabel = (n: number) => new FakeProvider({ "actions.json": JSON.stringify({ actions: [{ kind: "relabel", num: n, add: ["type:bug"], remove: [] }] }) });

test("active issues are stepped (agent called) and counted as advanced", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "a", body: "b", labels: [], state: "open" }] });
  const provider = relabel(1);
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(1);
  expect(provider.calls.length).toBe(1);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("caps work per tick at MAX_ITEMS_PER_TICK", async () => {
  const issues = Array.from({ length: MAX_ITEMS_PER_TICK + 5 }, (_, k) => ({
    number: k + 1, title: "t", body: "b", labels: [], state: "open" as const,
  }));
  const gh = new FakeGitHub({ thesis: "T", issues });
  // every active item proposes a relabel of itself -> all batched items advance; the cap bounds the batch
  const provider = new RelabelEachProvider();
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(MAX_ITEMS_PER_TICK);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("awaiting-gate with no signal: idle, waiting:human, long backoff, agent NOT called", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await executeSafe(gh, "o/r", { kind: "propose", num: 1, proposal: "close", draft: "because X" }); // -> needs-approval + panel
  const provider = new FakeProvider({});
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(0);
  expect(provider.calls.length).toBe(0);                     // gate item: no agent
  expect(r.waiting.find((w) => w.on === "human")?.count).toBe(1);
  expect(r.idle).toBe(true);
  expect(r.nextPollMs).toBeGreaterThanOrEqual(3600_000);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("awaiting-gate with 👍 advances via doClose (no agent), then leaves the open list", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await executeSafe(gh, "o/r", { kind: "propose", num: 1, proposal: "close", draft: "because X" });
  gh.commentReactions["panel:1"] = ["+1"];
  const provider = new FakeProvider({});
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(1);
  expect(provider.calls.length).toBe(0);
  expect(gh.closed).toContain(1);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("declined is terminal: not stepped, not counted as waiting:human, agent NOT called", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "x", body: "y", labels: ["monastery:needs-approval", "monastery:declined"], state: "open" },
  ]});
  const provider = new FakeProvider({});
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(0);
  expect(provider.calls.length).toBe(0);
  expect(r.waiting.find((w) => w.on === "human")).toBeUndefined();
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
