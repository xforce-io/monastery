# 88 — implement needs human endorsement + step return/error-code overhaul

> Source of truth for #88. Related: #48 (the P2 stakeholder-limit this implements),
> #86 (heavy-work throttle — builds on top of this gate).

## Problem

### A. consensus self-endorse hole
monastery runs as the owner's GitHub identity (`xforce-io`), so every marked comment it
posts (spec / endorse) is authored by the owner. `consensusReached` (`shell/consensus.ts`)
only looks at the comment `author`, so the agent can: self-fill `parties=xforce-io` → post
its own `<!--monastery-endorse-->` (author=xforce-io) → consensus auto-reaches → implement.
Observed on #86 and #84 — the human never participated.

### B. step return / exit-code are a mess
- `noop` is a grab-bag: terminal, no-valid-output, empty-actions, (future) deferred — all
  indistinguishable.
- exit `1` is a junk drawer: lock conflict, unknown command, agent failure, any exception.
- single-issue output prints only `#N: <kind>` — no human explanation.

## Goals

1. `implement` must be **endorsed by a real human (👍)** before it executes; the agent cannot
   self-approve.
2. step's Outcome / exit-code / explanation text become a coherent, explainable system.

## Design

### 1. `implement` becomes a gated action (reuse propose → awaiting-gate → 👍)

Keep the `implement` action but add an optional `draft` (the human-facing design/plan summary).
The shell **no longer runs the patcher directly**; it opens an approval gate, reusing the
existing `propose` machinery:

- `GatedKind` gains `"implement"`; the `implement` action carries `draft`.
- `active()`: on `implement` → `postComment(approvalMarker("implement") + draft)` +
  `needs-approval` label → issue enters **awaiting-gate**. Outcome = `waiting{on:"approval"}`.
- `awaitingGate()`: reads `action: implement` marker + a **real human 👍** → `runImplement`;
  👎 → declined (existing path).
- The admission signal is a 👍 **reaction** a human adds on the panel — an action the agent
  physically cannot perform on its own comment. This is what closes the self-endorse hole:
  identity can't distinguish agent-vs-human (both are `xforce-io`), but a reaction can.

### 2. consensus no longer auto-triggers implement

- Remove the "consensusReached → maintainer directly implements" path. The maintainer prompt
  changes from "consensus reached → implement" to "judge implement → **propose** implement
  (posts a fresh approval comment, waits for the human's 👍)".
- `spec`/`endorse` remain usable for multi-party design discussion, but an agent-authored
  `endorse` is **no longer an implement trigger** — the only trigger is a real 👍.

### 3. Outcome gains `reason` (explainable)

```ts
type Outcome =
  | { kind: "progressed"; note?: string }
  | { kind: "waiting"; on: "approval" | "feedback" | "peer" | "ci" }
  | { kind: "done"; reason: "closed" | "declined" | "merged" }
  | { kind: "noop"; reason: "terminal" | "no-valid-output" | "deferred" | "idle" }
  & { entry?: BacklogEntry }
```

(`waiting.on` widens from the old `WaitReason` — `approval` is the #88 gate, `feedback` is
"waiting on a human comment". `ci`/`peer` stay for reconcile's existing bookkeeping.)

### 4. exit codes classified

```
0  success (incl. normal waiting/noop — waiting is not an error)
1  runtime / unexpected exception
2  usage error (unknown command / missing argument)
3  agent structured-output failure (StructuredAgentError — provider produced no valid output)
4  repo lock conflict (repo_locked)
```

- `StructuredAgentError` reaching `main` → exit `3` (was `1`).
- `repo_locked` → exit `4` (was `1`, from `stepRepos`).
- unknown command / `init` missing arg → exit `2` (init already uses 2).

### 5. explanation text

- single issue: `#N: <kind> — <human explanation of reason>`, e.g.
  - `#86: waiting — awaiting your 👍 on the implement proposal`
  - `#73: noop — deferred (one implement per tick)`  *(once #86 lands)*
  - `#90: noop — no valid agent output (3 consecutive; escalated to panel)`
- reconcile `summarize`: per-state counts **plus an explicit "awaiting your approval" list**,
  so a human sees exactly which issues are blocked on them.

## Change points

| File | Change |
|---|---|
| `src/types.ts` | `Outcome` `reason`/widened `waiting.on` |
| `src/shell/actions.ts` | `GatedKind` += `implement`; `implement` action += `draft`; `approvalMarker` already generic; gate open via fresh approval comment + needs-approval |
| `src/engine/issue-step.ts` | `active()` implement → open gate (NOT runImplement); `awaitingGate()` `implement`+👍 → runImplement; thread `reason` through every Outcome |
| `src/agents/maintainer.ts` | prompt: implement is now "propose, needs human 👍"; drop "consensus reached → implement" |
| `src/engine/reconcile.ts` | `summarize` with explanations + awaiting-approval list; carry `reason` |
| `src/agents/spec.ts` / `src/cli/index.ts` | `StructuredAgentError` → exit 3; `repo_locked` → exit 4; usage → 2; single-issue explanation output |

## Non-goals

- #86 (at most one implement per tick) is separate and builds on this gate.
- Don't remove consensus's multi-party design-discussion use — only cut its automatic link to
  implement.

## Test plan (TDD)

- `GatedKind`/`implement`+draft schema; gate opens panel with `action: implement` marker.
- `active()`: `implement` opens the gate (does NOT runImplement); Outcome `waiting{on:"approval"}`.
- `awaitingGate()`: `implement` + 👍 → runImplement; 👎 → declined.
- an agent-authored `endorse` does NOT trigger implement (no execution without a real 👍).
- `Outcome.reason` values across active/awaiting/terminal paths.
- exit codes: `repo_locked`→4, `StructuredAgentError`→3, usage→2 (cli/main level).
- single-issue + reconcile output carries the explanation text.
- existing tests updated to the new Outcome shape; no behavioral regression elsewhere.

## Acceptance

- maintainer judging implement → posts a fresh approval comment + `needs-approval`, Outcome
  `waiting{on:"approval"}`, output explains "awaiting your endorsement". No code is written yet.
- human 👍 the panel → next tick runs `runImplement`.
- agent-authored spec/endorse cannot pass implement without a real 👍.
- single-issue `step --issue N` is also gated (admission ≠ scheduling; it only bypasses #86's
  throttle, never the endorsement).
- state, return value, and explanation text all consistently reflect "awaiting endorsement".
- exit codes follow the classification; `npx tsc` + `vitest` green.
