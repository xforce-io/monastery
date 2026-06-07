# Maintainer Backlog Snapshot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a per-repo, ranked backlog snapshot derived deterministically from the maintainer's chosen actions, viewable via a new `monastery backlog` command.

**Architecture:** Shell-only. The maintainer agent is unchanged. `issueStep` attaches a derived `BacklogEntry` to its `Outcome`; `reconcile` collects entries across the tick, sorts them, and writes `backlog.json` (skipped under `--dry-run`). A new CLI command renders the snapshot.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, zod (existing). No new deps.

**Spec:** `docs/design/82-backlog-snapshot.md` is the source of truth.

---

## File Structure

- Create `src/engine/backlog.ts` — pure `deriveEntry` + `sortEntries`.
- Create `src/cli/backlog.ts` — `formatBacklog` renderer.
- Create `tests/backlog.test.ts` — unit tests for derive + sort.
- Modify `src/types.ts` — add `Priority`, `BacklogEntry`, `BacklogSnapshot`; add optional `entry` to `Outcome`.
- Modify `src/config/store.ts` — `BacklogWriter` interface + `readBacklog`/`writeBacklog`.
- Modify `src/engine/issue-step.ts` — `StepCtx.backlog?`; attach entries in `active()`/`awaitingGate()`.
- Modify `src/engine/reconcile.ts` — collect entries, sort, write snapshot.
- Modify `src/cli/index.ts` — `parseArgs` for `backlog`; `backlog` command branch; inject `backlog: store` into the step `ctx`.
- Modify `tests/store.test.ts`, `tests/reconcile.test.ts`, `tests/cli.test.ts`, `tests/issue-step.test.ts`.

---

## Task 1: Backlog types + `deriveEntry`

**Files:**
- Modify: `src/types.ts`
- Create: `src/engine/backlog.ts`
- Test: `tests/backlog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/backlog.test.ts`:

```ts
// tests/backlog.test.ts
import { expect, test } from "vitest";
import { deriveEntry } from "../src/engine/backlog.js";
import type { Action } from "../src/shell/actions.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/backlog.test.ts`
Expected: FAIL — `deriveEntry` not found / module `src/engine/backlog.js` missing.

- [ ] **Step 3: Add types to `src/types.ts`**

Append to `src/types.ts`:

```ts
// Backlog snapshot (issue #82): maintainer-written, human-read, disposable. Derived
// deterministically from the maintainer's actions — see docs/design/82-backlog-snapshot.md.
export type Priority = "now" | "soon" | "later" | "parked";

export interface BacklogEntry {
  number: number;
  title: string;
  priority: Priority;
  rationale: string;
  blockedBy?: string[]; // open Depends-on refs
  fails?: number;       // consecutive maintainer-fail count
}

export interface BacklogSnapshot {
  generatedAt: string;
  repo: string;
  rankedOf: { ranked: number; open: number };
  entries: BacklogEntry[]; // already sorted
}
```

- [ ] **Step 4: Create `src/engine/backlog.ts` with `deriveEntry`**

```ts
// src/engine/backlog.ts — project the maintainer's chosen actions into a backlog entry.
// Pure + deterministic: no LLM, no IO. See docs/design/82-backlog-snapshot.md.
import type { Action } from "../shell/actions.js";
import type { BacklogEntry, Priority } from "../types.js";

/** Actions that mean "this issue is being advanced this tick" (short of handing it to the patcher). */
const ADVANCING: ReadonlySet<string> = new Set(["spec", "endorse", "propose", "panel", "openDraftPR"]);

/** Derive a backlog entry from the maintainer's proposed actions (strongest signal wins). */
export function deriveEntry(
  issue: { number: number; title: string },
  actions: Action[],
  blockedBy: string[],
  fails: number,
): BacklogEntry {
  const kinds = actions.map((a) => a.kind);
  let priority: Priority;
  let rationale: string;
  if (kinds.includes("implement")) {
    priority = "now";
    rationale = "proposed implement → patcher";
  } else if (kinds.some((k) => ADVANCING.has(k))) {
    priority = "soon";
    rationale = `advancing: ${kinds.join(", ")}`;
  } else if (kinds.length) {
    priority = "later";
    rationale = `light governance: ${kinds.join(", ")}`;
  } else {
    priority = "later";
    rationale = "no action this tick";
  }
  const entry: BacklogEntry = { number: issue.number, title: issue.title, priority, rationale };
  if (blockedBy.length) entry.blockedBy = blockedBy;
  if (fails > 0) entry.fails = fails;
  return entry;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/backlog.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/engine/backlog.ts tests/backlog.test.ts
git commit -m "feat(#82): derive backlog entry from maintainer actions"
```

---

## Task 2: `sortEntries`

**Files:**
- Modify: `src/engine/backlog.ts`
- Test: `tests/backlog.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/backlog.test.ts`:

```ts
import { sortEntries } from "../src/engine/backlog.js";
import type { BacklogEntry } from "../src/types.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/backlog.test.ts`
Expected: FAIL — `sortEntries` not exported.

- [ ] **Step 3: Add `sortEntries` to `src/engine/backlog.ts`**

Add the import and function (place `BUCKET` near the top, `sortEntries` below `deriveEntry`):

```ts
// add Priority is already imported; add BacklogEntry to the type import:
// import type { BacklogEntry, Priority } from "../types.js";

const BUCKET: Record<Priority, number> = { now: 0, soon: 1, later: 2, parked: 3 };

/** Stable deterministic order: bucket, then not-blocked, then fewer fails, then lower number. */
export function sortEntries(entries: BacklogEntry[]): BacklogEntry[] {
  return [...entries].sort((a, b) =>
    BUCKET[a.priority] - BUCKET[b.priority]
    || (a.blockedBy?.length ?? 0) - (b.blockedBy?.length ?? 0)
    || (a.fails ?? 0) - (b.fails ?? 0)
    || a.number - b.number,
  );
}
```

Ensure the top-of-file type import reads: `import type { BacklogEntry, Priority } from "../types.js";`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/backlog.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/engine/backlog.ts tests/backlog.test.ts
git commit -m "feat(#82): deterministic backlog sort (bucket + tiebreaks)"
```

---

## Task 3: `Store.readBacklog` / `writeBacklog` + `BacklogWriter`

**Files:**
- Modify: `src/config/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/store.test.ts`:

```ts
import type { BacklogSnapshot } from "../src/types.js";

const snap = (repo: string): BacklogSnapshot => ({
  generatedAt: "1970-01-01T00:00:00.000Z",
  repo,
  rankedOf: { ranked: 1, open: 1 },
  entries: [{ number: 1, title: "a", priority: "now", rationale: "r" }],
});

test("backlog: read missing returns null; write then read round-trips; persists per-repo", () => {
  const { store, dir } = tmpStore();
  expect(store.readBacklog("o/r")).toBeNull();
  store.writeBacklog("o/r", snap("o/r"));
  expect(store.readBacklog("o/r")).toEqual(snap("o/r"));
  expect(existsSync(join(dir, "repos", "o__r", "backlog.json"))).toBe(true);
  expect(new Store(dir).readBacklog("o/r")).toEqual(snap("o/r")); // persisted
  rmSync(dir, { recursive: true, force: true });
});

test("backlog is isolated per repo", () => {
  const { store, dir } = tmpStore();
  store.writeBacklog("a/x", snap("a/x"));
  expect(store.readBacklog("a/x")).not.toBeNull();
  expect(store.readBacklog("b/y")).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `writeBacklog`/`readBacklog` not on `Store`.

- [ ] **Step 3: Implement in `src/config/store.ts`**

Add the import at the top (after the `PolicyOverrides` import):

```ts
import type { BacklogSnapshot } from "../types.js";
```

Add the interface near `FailTracker`:

```ts
/** Writes the per-repo backlog snapshot (issue #82). Disposable — rebuilt each step. */
export interface BacklogWriter {
  writeBacklog(repo: string, snapshot: BacklogSnapshot): void;
}
```

Change the class declaration:

```ts
export class Store implements FailTracker, BacklogWriter {
```

Add these methods inside the class (after the fail-counter methods):

```ts
  // --- repos/<slug>/backlog.json (disposable, issue #82) ---

  private backlogPath(repo: string): string { return join(this.root, "repos", repoSlug(repo), "backlog.json"); }

  readBacklog(repo: string): BacklogSnapshot | null {
    return this.readJson<BacklogSnapshot | null>(this.backlogPath(repo), null);
  }
  writeBacklog(repo: string, snapshot: BacklogSnapshot): void {
    mkdirSync(join(this.root, "repos", repoSlug(repo)), { recursive: true });
    this.writeJson(this.backlogPath(repo), snapshot);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/config/store.ts tests/store.test.ts
git commit -m "feat(#82): Store read/writeBacklog (disposable per-repo)"
```

---

## Task 4: `Outcome.entry` + `issueStep` attaches entries

**Files:**
- Modify: `src/types.ts`, `src/engine/issue-step.ts`
- Test: `tests/issue-step.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/issue-step.test.ts` (it already imports `FakeGitHub`, `FakeProvider`, `issueStep`; if a `baseCtx` helper is not present, add the one below):

```ts
import { mkdtempSync as _mkdtemp, rmSync as _rm } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _join } from "node:path";
import { FakeWorkspace } from "../src/workspace/fake.js";

const stepCtx = (gh: FakeGitHub, provider: FakeProvider) => ({
  repo: "o/r", gh, provider, model: "sonnet",
  artifactRoot: _mkdtemp(_join(_tmpdir(), "monastery-is-")),
  fails: { recordFail: () => 1, failCount: () => 0, clearFail: () => {} },
  ws: new FakeWorkspace(), now: () => 0,
});
const actionsProvider = (actions: object[]) =>
  new FakeProvider({ "actions.json": JSON.stringify({ actions }) });

test("active issue: outcome carries a derived entry (relabel → later)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  const ctx = stepCtx(gh, actionsProvider([{ kind: "relabel", num: 1, add: ["type:bug"], remove: [] }]));
  const out = await issueStep(ctx, 1);
  expect(out.entry).toMatchObject({ number: 1, title: "x", priority: "later" });
  _rm(ctx.artifactRoot, { recursive: true, force: true });
});

test("active issue with no valid output: entry is later 'no valid output'", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  // provider writes nothing parseable → maintainer() returns null
  const ctx = stepCtx(gh, new FakeProvider({}));
  const out = await issueStep(ctx, 1);
  expect(out.entry).toMatchObject({ number: 1, priority: "later", rationale: "no valid output" });
  _rm(ctx.artifactRoot, { recursive: true, force: true });
});

test("awaiting-gate issue: entry is parked", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await executeSafe(gh, "o/r", { kind: "propose", num: 1, proposal: "close", draft: "because X" }); // -> needs-approval + panel
  const ctx = stepCtx(gh, new FakeProvider({}));
  const out = await issueStep(ctx, 1);
  expect(out.entry).toMatchObject({ number: 1, priority: "parked", rationale: "awaiting human approval" });
  _rm(ctx.artifactRoot, { recursive: true, force: true });
});
```

If `executeSafe` is not yet imported in `tests/issue-step.test.ts`, add:
`import { executeSafe } from "../src/shell/actions.js";`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/issue-step.test.ts`
Expected: FAIL — `out.entry` is `undefined`.

- [ ] **Step 3: Add `entry` to `Outcome` in `src/types.ts`**

Replace the `Outcome` definition with the intersection form (keeps `kind` narrowing, adds optional `entry`):

```ts
export type Outcome = (
  | { kind: "progressed"; note?: string }
  | { kind: "waiting"; on: WaitReason }
  | { kind: "done" }
  | { kind: "noop" }
) & { entry?: BacklogEntry };
```

(`BacklogEntry` is defined later in the same file — a same-file type reference is fine.)

- [ ] **Step 4: Wire entries into `src/engine/issue-step.ts`**

Add imports:

```ts
import { deriveEntry } from "./backlog.js";
import type { BacklogWriter } from "../config/store.js";
```

Add an optional field to `StepCtx` (place beside `fails`):

```ts
  /** Sink for the per-repo backlog snapshot (issue #82); reconcile writes through it. */
  backlog?: BacklogWriter;
```

In `active()`, compute `blockedBy` right after `gatherMaintainerContext`:

```ts
  const input = await gatherMaintainerContext(ctx.gh, ctx.repo, issue);
  const blockedBy = (input.deps ?? []).filter((d) => d.state === "open").map((d) => d.ref);
```

In the no-valid-output branch, attach a fixed `later` entry to the returned `noop` (the branch already computes `fails`):

```ts
    return {
      kind: "noop",
      entry: {
        number: issue.number, title: issue.title, priority: "later", rationale: "no valid output",
        ...(blockedBy.length ? { blockedBy } : {}), ...(fails > 0 ? { fails } : {}),
      },
    };
```

At the end of `active()`, derive the entry from the proposed actions (fails are cleared on success, so `failCount` is 0):

```ts
  const entry = deriveEntry(issue, actions, blockedBy, ctx.fails.failCount(ctx.repo, issue.number));
  return actions.length ? { kind: "progressed", entry } : { kind: "noop", entry };
```

In `awaitingGate()`, attach a `parked` entry to the two "still waiting on a human" returns (the no-panel return and the no-signal return). Define it once at the top of the function and reuse:

```ts
  const parked = {
    number: issue.number, title: issue.title, priority: "parked" as const, rationale: "awaiting human approval",
  };
  // ... in the two `return { kind: "waiting", on: "human" }` sites, return:
  //     return { kind: "waiting", on: "human", entry: parked };
```

Leave the terminal returns (`done` for declined/approved-close) WITHOUT an entry — a terminalizing issue leaves the backlog.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/issue-step.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/engine/issue-step.ts tests/issue-step.test.ts
git commit -m "feat(#82): issueStep attaches a derived backlog entry to its Outcome"
```

---

## Task 5: `reconcile` collects, sorts, writes (dry-run skips)

**Files:**
- Modify: `src/engine/reconcile.ts`
- Test: `tests/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/reconcile.test.ts`:

Note: `tests/reconcile.test.ts` already imports `join`, `mkdirSync`, `writeFileSync`,
`AgentConfig`, `AgentProvider`, and `AgentResult` at the top — reuse them. Only add the
`BacklogSnapshot` type import.

```ts
import type { BacklogSnapshot } from "../src/types.js";

// provider returning a chosen action set per issue number (derived from the artifact dir)
class PerIssueProvider implements AgentProvider {
  public calls: AgentConfig[] = [];
  constructor(private byNum: Record<number, object[]>) {}
  async run(config: AgentConfig): Promise<AgentResult> {
    this.calls.push(config);
    const num = Number(config.artifactDir.split("/").pop());
    mkdirSync(config.artifactDir, { recursive: true });
    writeFileSync(join(config.artifactDir, "actions.json"), JSON.stringify({ actions: this.byNum[num] ?? [] }));
    return { artifacts: [] };
  }
}

test("writes a sorted backlog snapshot through ctx.backlog", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "a", body: "b", labels: [], state: "open" },  // relabel -> later
    { number: 2, title: "c", body: "d", labels: [], state: "open" },  // panel   -> soon
  ]});
  const provider = new PerIssueProvider({
    1: [{ kind: "relabel", num: 1, add: ["type:bug"], remove: [] }],
    2: [{ kind: "panel", num: 2, body: "status" }],
  });
  const written: BacklogSnapshot[] = [];
  const c = { ...baseCtx(gh, provider), backlog: { writeBacklog: (_r: string, s: BacklogSnapshot) => { written.push(s); } } };
  await reconcile(c);
  expect(written.length).toBe(1);
  expect(written[0].entries.map((e) => e.number)).toEqual([2, 1]); // soon(#2) before later(#1)
  expect(written[0].rankedOf).toEqual({ ranked: 2, open: 2 });
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("dry-run does NOT write the backlog", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "a", body: "b", labels: [], state: "open" }] });
  const written: BacklogSnapshot[] = [];
  const c = { ...baseCtx(gh, relabel(1)), dryRun: true, backlog: { writeBacklog: (_r: string, s: BacklogSnapshot) => { written.push(s); } } };
  await reconcile(c);
  expect(written.length).toBe(0);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts`
Expected: FAIL — `written` stays empty (snapshot not written yet).

- [ ] **Step 3: Implement in `src/engine/reconcile.ts`**

Add imports:

```ts
import type { BacklogEntry, BacklogSnapshot } from "../types.js";
import { sortEntries } from "./backlog.js";
```

Declare an `entries` accumulator beside `advanced` / `waiting`:

```ts
  const entries: BacklogEntry[] = [];
```

In the batch loop, collect each issue's entry (right after the `issueStep` call succeeds):

```ts
      const out = await issueStep(ctx, i.number);
      if (out.entry) entries.push(out.entry);
      if (out.kind === "progressed" || out.kind === "done") advanced++;
      else if (out.kind === "waiting" && out.on !== "human") waiting[out.on]++;
```

After the batch loop (before computing `idle`/`nextPollMs` is fine; just before the final `return`), write the snapshot unless dry-run:

```ts
  // Backlog snapshot (issue #82): maintainer-written projection of this tick's decisions.
  // Disposable; rebuilt every tick. Skipped under dry-run (no persistent side effects).
  if (!ctx.dryRun && ctx.backlog) {
    const snapshot: BacklogSnapshot = {
      generatedAt: new Date(ctx.now()).toISOString(),
      repo: ctx.repo,
      rankedOf: { ranked: entries.length, open: runnable.length },
      entries: sortEntries(entries),
    };
    ctx.backlog.writeBacklog(ctx.repo, snapshot);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reconcile.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/engine/reconcile.ts tests/reconcile.test.ts
git commit -m "feat(#82): reconcile writes the ranked backlog snapshot (dry-run skips)"
```

---

## Task 6: CLI `backlog` command + renderer + wiring

**Files:**
- Create: `src/cli/backlog.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/cli.test.ts`:

```ts
import { formatBacklog } from "../src/cli/backlog.js";
import type { BacklogSnapshot } from "../src/types.js";

test("parses `backlog --repo o/r --json`", () => {
  expect(parseArgs(["backlog", "--repo", "o/r", "--json"]))
    .toEqual({ cmd: "backlog", repo: "o/r", json: true });
});

test("formatBacklog renders header + ranked lines with priority, rationale, blockers", () => {
  const snap: BacklogSnapshot = {
    generatedAt: "1970-01-01T00:00:00.000Z",
    repo: "o/r",
    rankedOf: { ranked: 2, open: 3 },
    entries: [
      { number: 2, title: "c", priority: "soon", rationale: "advancing: panel" },
      { number: 1, title: "a", priority: "later", rationale: "no action this tick", blockedBy: ["o/r#9"], fails: 2 },
    ],
  };
  const out = formatBacklog(snap);
  expect(out).toContain("o/r");
  expect(out).toContain("ranked 2 of 3");
  expect(out).toContain("[soon] #2 c");
  expect(out).toContain("[later] #1 a");
  expect(out).toContain("blocked: o/r#9");
  expect(out).toContain("fails: 2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — `formatBacklog` missing; `parseArgs` returns step-shaped object for `backlog`.

- [ ] **Step 3: Create `src/cli/backlog.ts`**

```ts
// src/cli/backlog.ts — render a backlog snapshot (issue #82) for humans.
import type { BacklogSnapshot } from "../types.js";

export function formatBacklog(s: BacklogSnapshot): string {
  const header = `${s.repo} — backlog (ranked ${s.rankedOf.ranked} of ${s.rankedOf.open} open, @ ${s.generatedAt})`;
  const lines = s.entries.map((e) => {
    const parts = [`  [${e.priority}]`, `#${e.number}`, e.title, `— ${e.rationale}`];
    if (e.blockedBy?.length) parts.push(`(blocked: ${e.blockedBy.join(", ")})`);
    if (e.fails) parts.push(`(fails: ${e.fails})`);
    return parts.join(" ");
  });
  return [header, ...lines].join("\n");
}
```

- [ ] **Step 4: Wire `backlog` into `src/cli/index.ts`**

In `parseArgs`, extend the `status` line to also handle `backlog`:

```ts
  if (cmd === "status" || cmd === "backlog") return { cmd, repo: opt("repo"), json: flag("json") };
```

Add the import:

```ts
import { formatBacklog } from "./backlog.js";
import type { BacklogSnapshot } from "../types.js";
```

Add a command branch in `main()` (e.g. after the `status` branch):

```ts
  if (args.cmd === "backlog") {
    const repos = args.repo ? [args.repo] : store.listRepos();
    const snaps = repos
      .map((r) => store.readBacklog(r))
      .filter((s): s is BacklogSnapshot => s !== null);
    console.log(args.json ? JSON.stringify(snaps, null, 2) : snaps.map(formatBacklog).join("\n\n"));
    return;
  }
```

Inject the store as the backlog sink in the step `ctx` (inside `runOne`, add `backlog: store` to the ctx object literal):

```ts
        const ctx = { repo, gh, provider, model, reviewModel: process.env.MONASTERY_REVIEW_MODEL ?? model, repoPolicy: store.repoPolicy(repo), dryRun: args.dryRun, artifactRoot: mkdtempSync(join(tmpdir(), "monastery-")), fails: store, backlog: store, ws: new GitWorkspace(), now: () => Date.now() };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Full verification**

Run: `npx tsc --noEmit && npx vitest run && npm run -s build`
Expected: tsc exit 0; all tests pass; build success.

- [ ] **Step 7: Commit**

```bash
git add src/cli/backlog.ts src/cli/index.ts tests/cli.test.ts
git commit -m "feat(#82): monastery backlog command + renderer; wire store as backlog sink"
```

---

## Done criteria

- `npx tsc --noEmit`, `npx vitest run`, `npm run -s build` all green.
- `monastery step` writes `~/.monastery/repos/<o>__<r>/backlog.json`; `monastery step --dry-run` does not.
- `monastery backlog [--repo] [--json]` renders the ranked snapshot.
- Spec acceptance criteria in `docs/design/82-backlog-snapshot.md` all satisfied.
