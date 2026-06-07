# 82 — maintainer backlog snapshot

> Source of truth for #82. Issue body keeps a one-line summary + link to this doc.
> Related: #77/#81 (step lock), #34 (v2 thin governance shell), maintainer-as-PM A.2.

## Problem

Short-term backlog ordering lives in a hand-written `todos.md`. Nobody owns it, so it
drifts — it just went stale because GitHub state (`#74 merged`, `#80 merged`) was copied
in by hand. Meanwhile the maintainer agent is already a PM: every tick it judges, per open
issue, whether that item is "among the MOST worth advancing now" (`maintainer.ts:39-42`).
That judgement is **not persisted and not observable** — humans can only track it via the
hand-written file.

## Goal

Project the maintainer's decisions into a **per-repo, observable, rebuildable** backlog
snapshot that replaces `todos.md`'s `suggested order`, plus a view command.

## Non-goals

- No `--concurrency`, no issue lease, no scheduler (same as #77).
- No human-editable backlog: to change priority, change the issue (label/comment). The
  snapshot is a read-only derived artifact (see Roles).
- No LLM-emitted priority/score field (see Key decision).

## Key decision: derive priority from actions, not from a new LLM field

The maintainer's priority judgement is **already expressed in the actions it chooses** —
`implement` means "do this now", light governance means "not the most worth doing now".
Asking the LLM to *also* emit a separate `priority` field would create a second judgement
source that can contradict the first (propose `implement` yet label it `later`). It would
also reintroduce scale drift and parse failures.

So priority is **deterministically derived from the actions the maintainer already chose**.
The snapshot is a faithful projection of what the agent actually decided — it cannot "say
one thing and do another", because the snapshot *is* computed from the doing. The maintainer
agent is **not modified**; this feature lives entirely in the shell. This matches #34's
thin-shell principle: the shell observes and projects the agent's decisions without adding
to what it must be trusted to produce.

## Roles & data flow

`backlog.json` is **maintainer-written, human-read**, disposable and rebuildable — same
class as `cache.json` (`store.ts:13`). Humans don't edit it; "rebuild" = next tick
overwrites. Because nobody hand-edits it, overwrite-on-rebuild never clobbers human work.

```
reconcile (tick)
  └─ for issue in batch:
       issueStep → active()  → maintainer() returns actions (UNCHANGED)
                              → deriveEntry(issue, actions, deps, fails) → Outcome.entry
                  → awaitingGate() → entry = parked
  └─ collect out.entry across the batch
  └─ sort (priority bucket → deterministic tiebreak)
  └─ Store.writeBacklog(repo, snapshot)         [skipped under --dry-run]

monastery backlog --repo  →  Store.readBacklog  →  render ranked list
```

## Derivation (pure function, `engine/backlog.ts`)

`deriveEntry(issue, actions, deps, fails)` — take the **strongest** signal among the
proposed actions:

| Actions this tick | priority | rationale (mechanical) |
|---|---|---|
| contains `implement` | `now` | "proposed implement → patcher" |
| contains `spec`/`endorse`/`propose`/`panel`/`openDraftPR` | `soon` | "advancing: {kinds}" |
| only `reply`/`relabel` | `later` | "light governance: {kinds}" |
| empty | `later` | "no action this tick" |
| awaiting-gate (no maintainer call) | `parked` | "awaiting human approval" |
| no valid maintainer output (null / out-of-scope) | `later` | "no valid output" |

`blockedBy` = the issue's `Depends-on:` refs still open (from `input.deps`). `fails` =
current consecutive-fail count (existing fail tracker).

`propose` (asks a human to approve close/merge) counts as `soon` — it is advancing
governance this tick. Next tick the issue carries `needs-approval` and routes through
`awaitingGate()`, becoming `parked`. This progression is intentional, not a contradiction.

## Sorting

Bucket order `now > soon > later > parked`. Within a bucket, deterministic tiebreak:

1. not blocked by open deps first (`blockedBy` empty wins);
2. fewer `fails` first;
3. lower issue `number` first (older first — stable).

`parked` sits last: it's already handed to a human, the agent has nothing to do on it.

## Data structures

```ts
// types.ts — Outcome gains an optional carrier
interface Outcome { /* existing kind/on... */ entry?: BacklogEntry }

// engine/backlog.ts (new) + config/store.ts
type Priority = "now" | "soon" | "later" | "parked";

interface BacklogEntry {
  number: number;
  title: string;
  priority: Priority;
  rationale: string;
  blockedBy?: string[];   // open Depends-on refs
  fails?: number;
}

interface BacklogSnapshot {
  generatedAt: string;                       // this step's wall clock
  repo: string;
  rankedOf: { ranked: number; open: number };// honest coverage note
  entries: BacklogEntry[];                   // already sorted
}
```

`backlog.json` lives at `<root>/repos/<owner>__<repo>/backlog.json`, beside `cache.json`
(NOT merged into it — `cache.json` is the run cursor `{cursor, fails}`, a different concern).

## Change points (6, all shell-side)

1. `types.ts` — add optional `Outcome.entry`.
2. `engine/backlog.ts` (new) — `deriveEntry` + `sortEntries`, both pure.
3. `issue-step.ts` — `active()` calls `deriveEntry` (it already has actions / `input.deps` /
   fails) and attaches `entry`; `awaitingGate()` attaches a `parked` entry. No other change.
4. `reconcile.ts` — collect `out.entry` in the tick loop; after the loop, sort and
   `Store.writeBacklog` (unless `ctx.dryRun`).
5. `config/store.ts` — `readBacklog` / `writeBacklog` (reuse existing read/writeJson).
6. `cli/index.ts` — `monastery backlog [--repo] [--json]`: extend `parseArgs`, add a main
   branch, add a renderer modelled on `status.ts`.

## Boundaries

- **More than `MAX_ITEMS_PER_TICK` (20) open issues**: un-stepped issues have no `entry` and
  are omitted; `rankedOf {ranked, open}` states "ranked N of M" honestly (no silent cap).
- **dry-run**: does NOT write `backlog.json` (pure preview, no persistent side effect).
- **Snapshot reflects proposed intent**, not execution success. An action that fails in
  `executeSafe` (fault-isolated) does not change the entry — the panel/log reflects failures.

## Failure modes / LLM robustness

The maintainer is the only LLM call; its influence is confined to *which actions it chose*,
and action kinds are a **closed vocabulary + schema-validated**. Everything downstream
(derive, sort, persist, render) is deterministic, so LLM nondeterminism cannot reach it.

| LLM nondeterminism | Handling | Backlog effect |
|---|---|---|
| invalid JSON / invented kind | `maintainer()` → null → recordFail → noop (existing) | entry → `later`/"no valid output"; no crash |
| out-of-scope (`num` mismatch) | `active()` rejects whole batch (existing) | same → `later` |
| action mix drifts tick to tick | none — this is the agent's real judgement changing | priority bucket may **flicker**; semantic feature, not a bug |
| multiple actions at once | derive takes the strongest signal (`implement` ⇒ `now`) | deterministic, no ambiguity |

No parse of free-text scores ⇒ no scale drift. Tiebreak is fully deterministic ⇒ stable
intra-bucket order even when a bucket flickers. If flicker is ever annoying, add an N-tick
damping later (YAGNI for now).

## Test plan (TDD)

- `deriveEntry` mapping — one test per row of the derivation table.
- `sortEntries` — bucket order + each tiebreak rule, stable on ties.
- `Store` `read/writeBacklog` round-trip; missing file → empty snapshot.
- CLI `backlog` renderer + `--json`; `parseArgs(["backlog", ...])`.
- `reconcile` integration: a batch of fake issues with known actions → expected ranked
  snapshot written (and NOT written under dry-run).
