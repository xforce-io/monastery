// tests/assess.test.ts — #176: assess = the assessment half (active issues → maintainer), split from reconcile.
import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assess } from "../src/engine/assess.js";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { FakeWorkspace } from "../src/workspace/fake.js";
import type { AgentProvider } from "../src/provider/interface.js";
import type { BacklogSnapshot } from "../src/types.js";

const NEEDS_APPROVAL = "monastery:needs-approval";

const baseCtx = (gh: FakeGitHub, provider: AgentProvider) => ({
  repo: "o/r", gh, provider, model: "sonnet", artifactRoot: mkdtempSync(join(tmpdir(), "monastery-assess-")),
  fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
  ws: new FakeWorkspace(),
  now: () => 0,
});

// a maintainer stub that relabels issue #n (so the active item "progresses")
const relabel = (n: number) => new FakeProvider({ "actions.json": JSON.stringify({ actions: [{ kind: "relabel", num: n, add: ["type:bug"], remove: [] }] }) });

describe("assess — #176: assesses active issues, never touches gated ones", () => {
  test("runs the maintainer on active issues and skips gated ones", async () => {
    const gh = new FakeGitHub({ thesis: "T", issues: [
      { number: 1, title: "active", body: "b", labels: [], state: "open" },
      { number: 2, title: "gated", body: "b", labels: [NEEDS_APPROVAL], state: "open" },
    ]});
    const provider = relabel(1);
    const c = baseCtx(gh, provider);
    const r = await assess(c);
    expect((provider as FakeProvider).calls.length).toBe(1); // only the active issue is assessed
    expect(r.advanced).toBe(1);
    rmSync(c.artifactRoot, { recursive: true, force: true });
  });

  test("refreshes the backlog snapshot after assessing — writes backlog.json via the store (#12)", async () => {
    const gh = new FakeGitHub({ thesis: "T", issues: [
      { number: 1, title: "active", body: "b", labels: [], state: "open", updatedAt: 1 },
    ]});
    const provider = new FakeProvider({
      "actions.json": JSON.stringify({ actions: [{ kind: "relabel", num: 1, add: ["type:bug"], remove: [] }] }),
      "backlog.json": JSON.stringify({ entries: [{ number: 1, priority: "now", rationale: "high impact" }] }),
    });
    const writes: BacklogSnapshot[] = [];
    const backlog = { readBacklog: () => null, writeBacklog: (_repo: string, snap: BacklogSnapshot) => { writes.push(snap); } };
    const c = { ...baseCtx(gh, provider), backlog };
    await assess(c);
    expect(writes).toHaveLength(1);                       // assess produced the snapshot
    expect(writes[0].entries.map((e) => e.number)).toEqual([1]);
    rmSync(c.artifactRoot, { recursive: true, force: true });
  });
});
