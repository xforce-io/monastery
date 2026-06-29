# Curated Status Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the read-only views (`status` and its lenses) a deterministic, zero-LLM per-row "next step" hint so the read view itself says what to do next.

**Architecture:** A pure `rowHint(repo, entry, opts)` maps a `BacklogEntry` (+ optional live progress) to one terse hint string with an optional URL, using only fields already on the entry. `formatBacklog` appends `→ <hint>` per line and the `--json` path decorates each row with `nextHint`/`nextHintUrl`. The `status` snapshot path is taught to overlay the local progress sidecar (currently only the no-snapshot fallback does), so stale locks become visible. No schema change, no new GitHub calls.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥ 20, vitest.

## Global Constraints

- Node ≥ 20; TypeScript ESM — every relative import ends in `.js` (e.g. `from "./status.js"`).
- Zero new dependencies.
- Read path stays **zero LLM and zero extra GitHub calls** — hints derive only from already-loaded data (the backlog snapshot + the local progress sidecar).
- Never call `Date.now()` inside render/pure functions — `now` is injected by the caller (existing codebase convention).
- Tests live in `tests/`, run with `npx vitest run tests/<file>.test.ts`.
- Design source of truth: `docs/design/175-curated-status-hints.md`. Issue: https://github.com/xforce-io/monastery/issues/175.
- Commit messages: `feat(#175): <chinese summary>`, ending with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `src/cli/status.ts` — extend `humanizeElapsed` (hours); add `pid` to `ProgressView`; extract `toProgressView(snap, opts)` and refactor `enrichWithProgress` to reuse it. (Tasks 1–2)
- `src/cli/backlog.ts` — new `rowHint` + `RowHint`; teach `formatBacklog` to append hints; new `backlogJsonView` + `BacklogJsonEntry` for the `--json` path. (Tasks 3–4)
- `src/cli/index.ts` — `status` snapshot branch: overlay progress, pass hints to both human and JSON outputs. (Task 5)
- `tests/status.test.ts` — add cases for Tasks 1–2.
- `tests/rowhint.test.ts` (new) — Task 3.
- `tests/backlog-hints.test.ts` (new) — Task 4.

**Not changed (deliberate):** `formatPending` already emits the identical gate link (`backlog.ts:52`) — its only applicable hint type — so the "same hint vocabulary" goal already holds for `pending` without code change. There is no `blocked` command (the CLI command set is `{status, pending, assess, run}`). Forcing `rowHint` onto `PendingItem` would mean unifying two row types for no behavior gain — out of scope (YAGNI).

---

### Task 1: Teach `humanizeElapsed` to render hours

A 47h stale currently prints as `2818m26s`. The stale hint's whole value is a readable duration, so extend the formatter. Sub-hour output is unchanged, so existing `status.test.ts` assertions (`elapsed=4m12s`) keep passing.

**Files:**
- Modify: `src/cli/status.ts:55-59`
- Test: `tests/status.test.ts`

**Interfaces:**
- Produces: `humanizeElapsed(ms: number): string` — now `Hh Mm` for ≥ 1h (e.g. `47h0m`), unchanged below 1h.

- [ ] **Step 1: Write the failing test** — append to `tests/status.test.ts`:

```ts
import { humanizeElapsed } from "../src/cli/status.js"; // add to existing imports if absent

test("#175 humanizeElapsed renders hours for long durations", () => {
  expect(humanizeElapsed(5_000)).toBe("5s");          // unchanged: sub-minute
  expect(humanizeElapsed(252_000)).toBe("4m12s");     // unchanged: sub-hour
  expect(humanizeElapsed(169_106_485)).toBe("46h58m"); // 46h58m26s -> h+m
  expect(humanizeElapsed(3_600_000)).toBe("1h0m");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/status.test.ts -t "renders hours"`
Expected: FAIL — `expected "2818m26s" to be "46h58m"`.

- [ ] **Step 3: Write minimal implementation** — replace `humanizeElapsed` body (`src/cli/status.ts:55-59`):

```ts
/** Humanize a duration: <1m -> "Ns"; <1h -> "Mm Ss"; otherwise "Hh Mm" (no zero-pad). */
export function humanizeElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/status.test.ts`
Expected: PASS (new case + all existing `formatStatus`/`enrichWithProgress` cases).

- [ ] **Step 5: Commit**

```bash
git add src/cli/status.ts tests/status.test.ts
git commit -m "feat(#175): humanizeElapsed 支持小时刻度

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add `pid` to `ProgressView` and extract `toProgressView`

The stale hint needs the holder pid (`先 ps <pid>`), but `ProgressView` currently drops it. Extract the view-construction so both the status path (`enrichWithProgress`) and the backlog path (Task 4) build the view identically.

**Files:**
- Modify: `src/cli/status.ts:34-41` (interface), `src/cli/status.ts:66-87` (`enrichWithProgress`)
- Test: `tests/status.test.ts`

**Interfaces:**
- Produces: `interface ProgressView { phase: string; attempt: string | undefined; elapsedMs: number; stale: boolean; status: string; reason: string | undefined; pid: number }`
- Produces: `toProgressView(snap: ProgressSnapshot | null, opts: { now: number; alive: boolean }): ProgressView | undefined` — returns `undefined` when `snap` is null or when a dead holder's last event was a clean `done`; otherwise the view (note: it does NOT check issue-number matching — the caller does).
- Consumes (unchanged signature): `enrichWithProgress(entry, snap, opts)` still gates on `snap.issue === entry.number`.

- [ ] **Step 1: Write the failing test** — append to `tests/status.test.ts`:

```ts
import { toProgressView } from "../src/cli/status.js"; // add to existing imports

test("#175 toProgressView carries pid and stale flag; suppresses dead+done", () => {
  const snap = { issue: 7, phase: "patch", status: "start", since: 1000, pid: 4242 };
  const view = toProgressView(snap, { now: 5000, alive: false });
  expect(view).toMatchObject({ phase: "patch", elapsedMs: 4000, stale: true, pid: 4242 });

  expect(toProgressView(null, { now: 5000, alive: true })).toBeUndefined();
  const done = { issue: 7, phase: "review", status: "done", since: 1000, pid: 4242 };
  expect(toProgressView(done, { now: 5000, alive: false })).toBeUndefined(); // dead+done = leftover
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/status.test.ts -t "carries pid"`
Expected: FAIL — `toProgressView is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/status.ts`, add `pid: number;` to the `ProgressView` interface (after `reason`):

```ts
export interface ProgressView {
  phase: string;
  attempt: string | undefined;
  elapsedMs: number;
  stale: boolean;
  status: string;
  reason: string | undefined;
  pid: number;
}
```

Add `toProgressView` and refactor `enrichWithProgress` to reuse it (replace `src/cli/status.ts:66-87`):

```ts
/** Build the overlay view from a progress snapshot. undefined when absent, or when a dead holder's
 *  last event was a clean `done` (a finished run's leftover, not in-progress work). Does NOT match by
 *  issue number — callers do that. The caller supplies `alive` (StepLock.isAlive on snap.pid) and `now`. */
export function toProgressView(
  snap: ProgressSnapshot | null,
  opts: { now: number; alive: boolean },
): ProgressView | undefined {
  if (!snap) return undefined;
  if (!opts.alive && snap.status === "done") return undefined;
  return {
    phase: snap.phase,
    attempt: snap.attempt,
    elapsedMs: opts.now - snap.since,
    stale: !opts.alive,
    status: snap.status,
    reason: snap.reason,
    pid: snap.pid,
  };
}

/** #75: overlay a per-repo progress snapshot onto a status entry. No-op unless the snapshot is for THIS issue. */
export function enrichWithProgress(
  entry: StatusEntry,
  snap: ProgressSnapshot | null,
  opts: { now: number; alive: boolean },
): StatusEntry {
  if (!snap || snap.issue !== entry.number) return entry;
  const progress = toProgressView(snap, opts);
  return progress ? { ...entry, progress } : entry;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/status.test.ts`
Expected: PASS — new case plus existing `enrichWithProgress`/`formatStatus` cases (behavior preserved: dead+done still yields no `progress`).

- [ ] **Step 5: Commit**

```bash
git add src/cli/status.ts tests/status.test.ts
git commit -m "feat(#175): ProgressView 带 pid,抽出 toProgressView

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `rowHint` — the deterministic per-row hint

**Files:**
- Modify: `src/cli/backlog.ts` (add imports + `RowHint` + `rowHint`)
- Test: `tests/rowhint.test.ts` (new)

**Interfaces:**
- Consumes: `ProgressView` and `humanizeElapsed` from `./status.js`; `BacklogEntry` from `../types.js`.
- Produces: `interface RowHint { text: string; url?: string }`
- Produces: `rowHint(repo: string, e: BacklogEntry, opts?: { progress?: ProgressView; failThreshold?: number }): RowHint | null` — one hint by priority **stale > awaiting-gate > blocked > fails**, else `null`. `opts.progress` is the view for THIS entry only (caller matches by issue number). `failThreshold` defaults to 3.

- [ ] **Step 1: Write the failing test** — create `tests/rowhint.test.ts`:

```ts
import { expect, test } from "vitest";
import { rowHint } from "../src/cli/backlog.js";
import type { BacklogEntry } from "../src/types.js";

const base: BacklogEntry = { number: 5, title: "t", priority: "soon", rationale: "r" };

test("#175 awaiting-gate row hints with a direct 👍 link", () => {
  const e = { ...base, number: 12, approvalKind: "implement", approvalCommentId: "999" };
  expect(rowHint("o/r", e)).toEqual({
    text: "等你 👍(implement)",
    url: "https://github.com/o/r/issues/12#issuecomment-999",
  });
});

test("#175 stale progress outranks everything and names the pid", () => {
  const e = { ...base, approvalKind: "merge", approvalCommentId: "1" };
  const progress = { phase: "patch", attempt: undefined, elapsedMs: 169_106_485, stale: true, status: "start", reason: undefined, pid: 4242 };
  expect(rowHint("o/r", e, { progress })).toEqual({ text: "进度陈旧 46h58m,先 ps 4242" });
});

test("#175 blocked row points at its blockers", () => {
  expect(rowHint("o/r", { ...base, blockedBy: ["#3", "#4"] })).toEqual({ text: "等 #3, #4" });
});

test("#175 fails at/over threshold nudges a look; under threshold is silent", () => {
  expect(rowHint("o/r", { ...base, fails: 3 })).toEqual({ text: "连败 3 次,可能要你看看" });
  expect(rowHint("o/r", { ...base, fails: 2 })).toBeNull();
  expect(rowHint("o/r", { ...base, fails: 2 }, { failThreshold: 2 })).toEqual({ text: "连败 2 次,可能要你看看" });
});

test("#175 a plain queued row has no hint", () => {
  expect(rowHint("o/r", base)).toBeNull();
});

test("#175 non-stale progress does not suppress the gate hint", () => {
  const e = { ...base, approvalKind: "close", approvalCommentId: "7" };
  const progress = { phase: "review", attempt: "1/3", elapsedMs: 1000, stale: false, status: "start", reason: undefined, pid: 9 };
  expect(rowHint("o/r", e, { progress })?.url).toBe("https://github.com/o/r/issues/5#issuecomment-7");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rowhint.test.ts`
Expected: FAIL — `rowHint is not a function`.

- [ ] **Step 3: Write minimal implementation** — in `src/cli/backlog.ts`, extend the import block and add the function. Update the top imports:

```ts
import type { BacklogSnapshot, BacklogEntry } from "../types.js";
import { STATUS_GLYPH } from "../shell/messages.js";
import { humanizeElapsed, type ProgressView } from "./status.js";
```

Append to `src/cli/backlog.ts`:

```ts
export interface RowHint { text: string; url?: string }

const DEFAULT_FAIL_THRESHOLD = 3;

/** #175: the one terminal "next step" for a backlog row, by priority stale > gate > blocked > fails.
 *  Deterministic, zero-LLM, derived only from fields already on the entry (+ optional live progress for
 *  THIS entry, matched by the caller). null when the row needs nothing from the human right now. */
export function rowHint(
  repo: string,
  e: BacklogEntry,
  opts?: { progress?: ProgressView; failThreshold?: number },
): RowHint | null {
  const progress = opts?.progress;
  const failThreshold = opts?.failThreshold ?? DEFAULT_FAIL_THRESHOLD;
  if (progress?.stale) {
    return { text: `进度陈旧 ${humanizeElapsed(progress.elapsedMs)},先 ps ${progress.pid}` };
  }
  if (e.approvalCommentId) {
    return {
      text: `等你 👍(${e.approvalKind ?? "approval"})`,
      url: `https://github.com/${repo}/issues/${e.number}#issuecomment-${e.approvalCommentId}`,
    };
  }
  if (e.blockedBy?.length) {
    return { text: `等 ${e.blockedBy.join(", ")}` };
  }
  if (e.fails && e.fails >= failThreshold) {
    return { text: `连败 ${e.fails} 次,可能要你看看` };
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rowhint.test.ts`
Expected: PASS (6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/cli/backlog.ts tests/rowhint.test.ts
git commit -m "feat(#175): rowHint 确定性下一步提示

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire hints into `formatBacklog` (human) and `backlogJsonView` (JSON)

**Files:**
- Modify: `src/cli/backlog.ts:18-27` (`formatBacklog`); add `BacklogJsonEntry` + `backlogJsonView`
- Test: `tests/backlog-hints.test.ts` (new)

**Interfaces:**
- Produces: `formatBacklog(s: BacklogSnapshot, opts?: { progress?: { issue: number; view: ProgressView }; failThreshold?: number }): string` — appends `  → <text> [<url>]` to each row when `rowHint` returns one. Backward compatible (opts optional).
- Produces: `interface BacklogJsonEntry extends BacklogEntry { nextHint?: string; nextHintUrl?: string }`
- Produces: `backlogJsonView(s: BacklogSnapshot, opts?: { progress?: { issue: number; view: ProgressView }; failThreshold?: number }): BacklogSnapshot & { entries: BacklogJsonEntry[] }` — the snapshot with each row decorated; rows without a hint are returned unchanged.
- Consumes: `rowHint` (Task 3); `ProgressView` (Task 2).

- [ ] **Step 1: Write the failing test** — create `tests/backlog-hints.test.ts`:

```ts
import { expect, test } from "vitest";
import { formatBacklog, backlogJsonView } from "../src/cli/backlog.js";
import type { BacklogSnapshot } from "../src/types.js";

const snap: BacklogSnapshot = {
  generatedAt: "2026-06-29T00:00:00Z",
  repo: "o/r",
  rankedOf: { ranked: 2, open: 2 },
  entries: [
    { number: 12, title: "gate me", priority: "now", rationale: "ready", approvalKind: "implement", approvalCommentId: "999" },
    { number: 5, title: "just queued", priority: "soon", rationale: "later" },
  ],
};

test("#175 formatBacklog appends a → hint with the gate link; plain rows get none", () => {
  const out = formatBacklog(snap);
  expect(out).toContain("→ 等你 👍(implement) https://github.com/o/r/issues/12#issuecomment-999");
  const queuedLine = out.split("\n").find((l) => l.includes("#5"))!;
  expect(queuedLine).not.toContain("→");
});

test("#175 stale progress overlays onto its matching row only", () => {
  const progress = { issue: 12, view: { phase: "patch", attempt: undefined, elapsedMs: 169_106_485, stale: true, status: "start", reason: undefined, pid: 4242 } };
  const out = formatBacklog(snap, { progress });
  expect(out).toContain("→ 进度陈旧 46h58m,先 ps 4242"); // stale outranks the gate hint on #12
});

test("#175 backlogJsonView decorates rows with nextHint/nextHintUrl", () => {
  const view = backlogJsonView(snap);
  expect(view.entries[0]).toMatchObject({ nextHint: "等你 👍(implement)", nextHintUrl: "https://github.com/o/r/issues/12#issuecomment-999" });
  expect(view.entries[1].nextHint).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/backlog-hints.test.ts`
Expected: FAIL — `backlogJsonView is not a function` / no `→` in output.

- [ ] **Step 3: Write minimal implementation** — replace `formatBacklog` (`src/cli/backlog.ts:18-27`) and add the JSON view:

```ts
export function formatBacklog(
  s: BacklogSnapshot,
  opts?: { progress?: { issue: number; view: ProgressView }; failThreshold?: number },
): string {
  const header = `${s.repo} — backlog (ranked ${s.rankedOf.ranked} of ${s.rankedOf.open} open, @ ${s.generatedAt})`;
  const lines = s.entries.map((e) => {
    const parts = [`  [${e.priority}]`, `#${e.number}`, e.title, `— ${e.rationale}`];
    if (e.blockedBy?.length) parts.push(`(blocked: ${e.blockedBy.join(", ")})`);
    if (e.fails) parts.push(`(fails: ${e.fails})`);
    const view = opts?.progress?.issue === e.number ? opts.progress.view : undefined;
    const hint = rowHint(s.repo, e, { progress: view, failThreshold: opts?.failThreshold });
    if (hint) parts.push(`→ ${hint.text}${hint.url ? ` ${hint.url}` : ""}`);
    return parts.join(" ");
  });
  return [header, ...lines].join("\n");
}

export interface BacklogJsonEntry extends BacklogEntry { nextHint?: string; nextHintUrl?: string }

/** #175: the snapshot decorated with per-row next-step hints for `--json` consumers. */
export function backlogJsonView(
  s: BacklogSnapshot,
  opts?: { progress?: { issue: number; view: ProgressView }; failThreshold?: number },
): BacklogSnapshot & { entries: BacklogJsonEntry[] } {
  const entries = s.entries.map((e): BacklogJsonEntry => {
    const view = opts?.progress?.issue === e.number ? opts.progress.view : undefined;
    const hint = rowHint(s.repo, e, { progress: view, failThreshold: opts?.failThreshold });
    if (!hint) return e;
    return { ...e, nextHint: hint.text, ...(hint.url ? { nextHintUrl: hint.url } : {}) };
  });
  return { ...s, entries };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/backlog-hints.test.ts tests/backlog.test.ts`
Expected: PASS — new cases plus existing `backlog.test.ts` (the `(blocked:)`/`(fails:)` detail rendering is untouched).

- [ ] **Step 5: Commit**

```bash
git add src/cli/backlog.ts tests/backlog-hints.test.ts
git commit -m "feat(#175): formatBacklog/backlogJsonView 输出每行提示

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire the `status` command snapshot path

Teach the snapshot branch to overlay progress (fixes stale-invisible) and pass hints to both outputs.

**Files:**
- Modify: `src/cli/index.ts:20-21` (imports), `src/cli/index.ts:92-118` (status snapshot branch)

**Interfaces:**
- Consumes: `toProgressView` (Task 2), `backlogJsonView` (Task 4), `FAIL_THRESHOLD` (`../engine/issue-step.js`), and existing `readProgress`, `isAlive`, `formatBacklog`.

- [ ] **Step 1: Update imports** — `src/cli/index.ts`:

Add `toProgressView` to the `./status.js` import (line 20):

```ts
import { formatStatus, toStatusEntry, explainOutcome, readProgress, enrichWithProgress, toProgressView, type StatusEntry } from "./status.js";
```

Add `backlogJsonView` to the `./backlog.js` import (line 21):

```ts
import { formatBacklog, backlogJsonView, formatBacklogRepoError, formatMissingBacklog, formatPending, missingBacklog, type BacklogRepoError, type MissingBacklog, type PendingItem } from "./backlog.js";
```

Add `FAIL_THRESHOLD` to the existing `issue-step.js` import (line 13):

```ts
import { issueStep, withReadOnlyCheckout, pendingApprovals, FAIL_THRESHOLD } from "../engine/issue-step.js";
```

- [ ] **Step 2: Wire the snapshot branch** — replace the `if (snapshot) { ... continue; }` block (`src/cli/index.ts:103-107`) with:

```ts
      const snapshot = store.readBacklog(repo);
      if (snapshot) {
        // #175: overlay the local progress sidecar (zero network) so stale locks are visible in the
        // snapshot path too, and decorate each row with its next-step hint.
        const snap = readProgress(lock.progressPath(repo));
        const view = snap ? toProgressView(snap, { now, alive: isAlive(snap.pid) }) : undefined;
        const progress = view ? { issue: snap!.issue, view } : undefined;
        jsonOut.push(backlogJsonView(snapshot, { progress, failThreshold: FAIL_THRESHOLD }));
        blocks.push(formatBacklog(snapshot, { progress, failThreshold: FAIL_THRESHOLD }));
        continue;
      }
```

- [ ] **Step 3: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS — no type errors; all tests green.

- [ ] **Step 4: Manual smoke check**

Run: `npm run build && node dist/cli/index.js status --repo xforce-io/monastery`
Expected: each ranked row prints; any awaiting-gate row shows `→ 等你 👍(...) https://github.com/.../issuecomment-...`; if a stale lock exists, its row shows `→ 进度陈旧 ...,先 ps <pid>`. Then `... status --repo xforce-io/monastery --json` shows `nextHint`/`nextHintUrl` on the corresponding rows.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(#175): status 快照路径叠加进度并输出每行提示

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (vs `docs/design/175-curated-status-hints.md`):**
- §4 word table — all five rows: awaiting-gate (T3 + T4), stale (T1 humanize + T2 pid + T3 + T5 overlay), blocked (T3), fails (T3), no-snapshot (pre-existing fallback at `index.ts`, untouched), plain (T3 → null). ✅
- §5 接线点 1 (formatBacklog `→` + `--json` fields) — T4. ✅
- §5 接线点 2 (snapshot path progress overlay) — T5. ✅
- §5 接线点 3 (pending/blocked lens) — covered by justification: `formatPending` already emits the identical gate link; no `blocked` command exists. Documented under File Structure. ✅
- §6 invariants (zero LLM / zero extra GitHub / pure `rowHint` / decoupled from #176) — no provider or `gh` call added; progress is the local sidecar; `rowHint` is pure. ✅
- §9 acceptance — T4 (hints + link), T5 (stale visible), T3 (pure), suite stays green. ✅

**Placeholder scan:** none — every step has concrete code/commands and expected output.

**Type consistency:** `ProgressView` gains `pid` (T2) and is consumed by `rowHint`/`formatBacklog`/`backlogJsonView` (T3/T4) and produced via `toProgressView` (T2) at the call site (T5). `rowHint` signature `(repo, entry, opts)` is identical across T3 definition and T4 callers. `formatBacklog`/`backlogJsonView` both take `{ progress?: { issue, view }; failThreshold? }`, matching what T5 passes. `46h58m` expected string is consistent with the T1 formatter (`169_106_485ms → 46h58m`).
