# 82 / 140 — backlog snapshot and read-only triage

> #82 introduced the local `backlog.json` snapshot.
> #140 supersedes the original derivation rule: backlog ranking must no longer be
> derived from per-issue maintainer actions such as `implement` or `rework`.

## Problem

The first backlog snapshot design made backlog ranking a projection of `step`:

```text
step -> reconcile -> issueStep -> maintainer actions -> deriveEntry -> backlog.json
```

That made the view observable, but it also coupled two different questions:

1. What is the current repo backlog order?
2. What governance action should be taken on this single issue now?

Those are not the same. A backlog entry whose rationale is
`proposed implement -> patcher` is not explaining why the issue matters; it is
describing a later execution decision.

## Goal

`monastery backlog` should be a read-only backlog triage view:

- list the repo's non-declined open issues;
- build a compact repo-level triage input from issue facts;
- rank all open issues into `now` / `soon` / `later` / `parked`;
- explain each rank with a human-readable rationale;
- cache the result in local `backlog.json`;
- refresh the cache only when the underlying issue set changed.

It must not write GitHub state or trigger `step` governance actions.

## Terms

**Triage** means analysis and prioritization. In the backlog path it is read-only.

**Label** means a GitHub issue label. Labels are one input feature to backlog triage,
alongside title, body, comments, dependency state, approval state, linked PR state,
and timestamps. Updating labels remains a `step` responsibility.

**Governance action** means an action such as `relabel`, `spec`, `propose`,
`implement`, `rework`, `reply`, or `close`. These belong to `step` / `issueStep`,
not to `backlog`.

## Layering

| Layer | Responsibility | May write GitHub? |
|---|---|---:|
| `backlog` | Read-only repo-level ranking and presentation | No |
| `step` / `reconcile` | Repo-level governance scheduling | Yes |
| `issueStep` | Single-issue governance state machine | Yes |
| patcher executor | Code changes, PR creation, rework after approval | Yes |

`reconcile` and `issueStep` remain useful for state-changing maintenance work. They
should not be a prerequisite for viewing the backlog order.

## Desired data flow

```text
monastery backlog
  -> listOpenIssues(repo)
  -> computeBacklogFingerprint(open issues)
  -> readBacklog(repo)
  -> if snapshot fingerprint is fresh:
       render cached snapshot
     else:
       buildBacklogTriageInput(open issues)
       triageBacklog(input)              [read-only, repo-level, schema-checked]
       normalize + sort + validate
       Store.writeBacklog(repo, snapshot)
       render snapshot
```

The triage agent may use an LLM, but its schema is limited to backlog data. It must
not return governance actions.

## Fingerprint

Freshness should be based on content, not a wall-clock TTL.

A sufficient fingerprint is:

- the set of open, non-declined issue numbers;
- each issue's `updatedAt`;
- any other fetched state that affects ranking, if added later.

If the fingerprint is unchanged, repeated `monastery backlog` runs should not spend
LLM tokens.

If the fingerprint changed, `monastery backlog` may perform one lightweight repo-level
triage pass and update the local snapshot.

## Snapshot

`backlog.json` remains local, disposable, and rebuildable.

It should contain the fingerprint used to build it, plus the ranked entries:

```ts
type Priority = "now" | "soon" | "later" | "parked";

interface BacklogEntry {
  number: number;
  title: string;
  priority: Priority;
  rationale: string;
  blockedBy?: string[];
  awaitingApproval?: boolean;
  approvalKind?: string;
  approvalCommentId?: string;
}

interface BacklogSnapshot {
  generatedAt: string;
  repo: string;
  fingerprint: string;
  rankedOf: { ranked: number; open: number };
  entries: BacklogEntry[];
}
```

`rankedOf.ranked` should normally equal the number of non-declined open issues. Unlike
the old `step`-derived snapshot, backlog ranking should not be capped by
`MAX_ITEMS_PER_TICK`.

## Ranking Inputs

Backlog triage can use:

- title and body;
- existing GitHub labels;
- recent human comments or maintainer notes;
- dependency references and whether they are still open;
- `needs-approval` / approval gate state;
- linked PR state;
- failure or progress metadata that is already locally known.

Labels are therefore an input feature, not the whole feature extraction layer.

## Output Boundaries

Backlog rationale should explain priority in terms of issue facts, for example:

```json
{
  "number": 140,
  "priority": "now",
  "rationale": "Backlog ranking currently depends on step-side implementation decisions, blocking a reliable lightweight priority view."
}
```

It should not contain execution-state rationales such as:

- `proposed implement -> patcher`
- `approved implement -> executed this tick`
- `approved implement -> deferred`
- `advancing: implement`

Those belong to `step` status/progress, not backlog priority.

## Non-goals

- Do not make `backlog` update GitHub labels.
- Do not make `backlog` call `reconcile()` or `issueStep()`.
- Do not add `--refresh`, `--cached`, or `--light` flags unless a real scripting need appears.
- Do not solve `step` throughput or progress reporting in this design.

## Acceptance Criteria

- `monastery backlog` does not call `reconcile()`, `issueStep()`, or patcher paths.
- A stale snapshot is refreshed by a read-only repo-level backlog triage pass.
- A fresh snapshot is rendered without LLM/token spend.
- All non-declined open issues are considered; `MAX_ITEMS_PER_TICK` does not limit backlog coverage.
- `backlog.json` rationales do not reference `implement`, `rework`, `patcher`, or tick execution status.
- `step` still owns `relabel`, `spec`, `propose`, `implement`, `rework`, and other governance actions.

## Historical Note

The original #82 design intentionally derived priority from maintainer actions to avoid
adding another LLM output field. #140 changes that tradeoff: backlog needs a separate
read-only triage output because action-derived priority made the view slow, partial, and
coupled to execution decisions.
