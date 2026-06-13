// tests/backlog.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backlogFingerprint, deriveEntry, isBacklogFresh, refreshBacklog } from "../src/engine/backlog.js";
import { sortEntries } from "../src/engine/backlog.js";
import type { Action } from "../src/shell/actions.js";
import type { BacklogEntry, BacklogSnapshot } from "../src/types.js";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";

const issue = { number: 7, title: "do a thing" };

test("implement → now", () => {
  const e = deriveEntry(issue, [{ kind: "implement", num: 7 }], [], 0);
  expect(e.priority).toBe("now");
  expect(e.rationale).toContain("implement");
  expect(e).toMatchObject({ number: 7, title: "do a thing" });
});

test("advancing actions (panel/spec/...) → soon", () => {
  const e = deriveEntry(issue, [{ kind: "panel", num: 7, body: "x" }], [], 0);
  expect(e.priority).toBe("soon");
});

test("only light governance (reply/relabel) → later", () => {
  const a: Action[] = [{ kind: "relabel", num: 7, add: ["type:bug"], remove: [] }];
  const e = deriveEntry(issue, a, [], 0);
  expect(e.priority).toBe("later");
  expect(e.rationale).toContain("light governance");
});

test("empty actions → later, 'no action this tick'", () => {
  const e = deriveEntry(issue, [], [], 0);
  expect(e.priority).toBe("later");
  expect(e.rationale).toBe("no action this tick");
});

test("strongest signal wins: reply + implement → now", () => {
  const a: Action[] = [
    { kind: "reply", num: 7, toCommentId: "c1", body: "hi" },
    { kind: "implement", num: 7 },
  ];
  expect(deriveEntry(issue, a, [], 0).priority).toBe("now");
});

test("blockedBy and fails are attached only when non-empty/positive", () => {
  const withBoth = deriveEntry(issue, [], ["o/r#3"], 2);
  expect(withBoth.blockedBy).toEqual(["o/r#3"]);
  expect(withBoth.fails).toBe(2);
  const without = deriveEntry(issue, [], [], 0);
  expect(without.blockedBy).toBeUndefined();
  expect(without.fails).toBeUndefined();
});

const e = (number: number, priority: BacklogEntry["priority"], extra: Partial<BacklogEntry> = {}): BacklogEntry =>
  ({ number, title: `#${number}`, priority, rationale: "", ...extra });

test("sorts by bucket order now > soon > later > parked", () => {
  const out = sortEntries([e(1, "parked"), e(2, "later"), e(3, "now"), e(4, "soon")]);
  expect(out.map((x) => x.number)).toEqual([3, 4, 2, 1]);
});

test("within a bucket: not-blocked before blocked", () => {
  const out = sortEntries([e(1, "later", { blockedBy: ["o/r#9"] }), e(2, "later")]);
  expect(out.map((x) => x.number)).toEqual([2, 1]);
});

test("within a bucket: fewer fails before more, then lower number", () => {
  const out = sortEntries([e(5, "soon", { fails: 2 }), e(6, "soon"), e(3, "soon")]);
  expect(out.map((x) => x.number)).toEqual([3, 6, 5]);
});

test("does not mutate the input array", () => {
  const input = [e(2, "later"), e(1, "now")];
  sortEntries(input);
  expect(input.map((x) => x.number)).toEqual([2, 1]);
});

test("#140 backlog fingerprint tracks open issue updatedAt and facts", () => {
  const a = backlogFingerprint([
    { number: 1, title: "a", body: "b", labels: [], state: "open", updatedAt: 10 },
  ]);
  const b = backlogFingerprint([
    { number: 1, title: "a", body: "b", labels: [], state: "open", updatedAt: 11 },
  ]);
  const declined = backlogFingerprint([
    { number: 1, title: "a", body: "b", labels: ["monastery:declined"], state: "open", updatedAt: 99 },
  ]);
  expect(a).not.toBe(b);
  expect(declined).toBe(backlogFingerprint([]));
});

test("#140 isBacklogFresh requires a matching fingerprint", () => {
  const snap: BacklogSnapshot = {
    generatedAt: "1970-01-01T00:00:00.000Z",
    repo: "o/r",
    fingerprint: "abc",
    rankedOf: { ranked: 0, open: 0 },
    entries: [],
  };
  expect(isBacklogFresh(snap, "abc")).toBe(true);
  expect(isBacklogFresh(snap, "def")).toBe(false);
  expect(isBacklogFresh({ ...snap, fingerprint: undefined }, "abc")).toBe(false);
});

test("#140 refreshBacklog uses read-only triage output and never action-derived rationales", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "active", body: "impact\nDepends-on: owner/up#7", labels: [], state: "open", updatedAt: 1 },
    { number: 2, title: "approval", body: "waiting", labels: ["monastery:needs-approval"], state: "open", updatedAt: 2 },
    { number: 3, title: "declined", body: "done", labels: ["monastery:declined"], state: "open", updatedAt: 3 },
  ]});
  gh.externalIssues["owner/up#7"] = { number: 7, title: "upstream", body: "", labels: [], state: "open" };
  const provider = new FakeProvider({
    "backlog.json": JSON.stringify({
      entries: [
        { number: 1, priority: "now", rationale: "proposed implement -> patcher", blockedBy: ["fake/repo#999"] },
        { number: 2, priority: "now", rationale: "important but waiting" },
        { number: 999, priority: "now", rationale: "unknown" },
      ],
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), "monastery-backlog-test-"));

  const snap = await refreshBacklog({
    repo: "o/r",
    gh,
    provider,
    model: "haiku",
    artifactDir: dir,
    now: () => 0,
  });

  expect(provider.calls).toHaveLength(1);
  expect(snap.rankedOf).toEqual({ ranked: 2, open: 2 });
  expect(snap.fingerprint).toBe(backlogFingerprint(await gh.listOpenIssues("o/r", 0)));
  expect(snap.entries.map((e) => e.number)).toEqual([1, 2]);
  expect(snap.entries.find((e) => e.number === 1)?.rationale).not.toMatch(/implement|patcher/i);
  expect(snap.entries.find((e) => e.number === 1)?.blockedBy).toEqual(["owner/up#7"]);
  expect(snap.entries.find((e) => e.number === 2)).toMatchObject({
    priority: "parked",
    awaitingApproval: true,
    rationale: "awaiting human approval",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("#140 normal deferred rationale is preserved", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "wait", body: "needs upstream context", labels: [], state: "open", updatedAt: 1 },
  ]});
  const provider = new FakeProvider({
    "backlog.json": JSON.stringify({
      entries: [{ number: 1, priority: "later", rationale: "deferred until the upstream API ships" }],
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), "monastery-backlog-test-"));

  const snap = await refreshBacklog({
    repo: "o/r",
    gh,
    provider,
    model: "haiku",
    artifactDir: dir,
    now: () => 0,
  });

  expect(snap.entries[0].rationale).toBe("deferred until the upstream API ships");
  rmSync(dir, { recursive: true, force: true });
});
