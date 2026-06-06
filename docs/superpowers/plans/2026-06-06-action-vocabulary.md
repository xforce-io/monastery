# Action Vocabulary (#34) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent↔shell interface: `executeSafe` runs the SAFE actions an agent may propose (reply/relabel/panel/openDraftPR/propose), idempotently; shell-only gated executors `doClose`/`doMerge` are NOT in the action union and are triggered later by human signals.

**Architecture:** A new `src/shell/actions.ts` defines the `Action` union + `executeSafe` + the two gated executors. Idempotency is per-action via GitHub-observable markers (reply-marker, panel, findPrForBranch, prState). Two new adapter calls: `listComments` (read, for reply idempotency) and `mergePR` (gated write).

**Tech Stack:** TypeScript (ESM, NodeNext), vitest. Design source: `docs/design/34-action-vocabulary.md`. Governing principles: `docs/CONSTITUTION.md`.

---

## File Structure

- **Create** `src/shell/actions.ts` — `Action` union, `GatedKind`, `executeSafe`, `doClose`, `doMerge`.
- **Modify** `src/github/adapter.ts` — add `listComments`, `mergePR` to the interface.
- **Modify** `src/github/gh-adapter.ts` — implement both.
- **Modify** `src/github/dry-run.ts` — `listComments` passthrough (read); `mergePR` record-only (write).
- **Modify** `src/github/fake.ts` — `listComments`, `mergePR` + a `merged` field.
- **Create** `tests/actions.test.ts`, **modify** `tests/gh-adapter.test.ts`.

`reactions` (issue 👍 read) is NOT built here — it has no consumer until the engine wires gated triggers (constitution §8/§9: don't build ahead of need). Deferred to the engine slice.

---

## Task 1: adapter `listComments` + `mergePR`

**Files:**
- Modify: `src/github/adapter.ts`, `src/github/gh-adapter.ts`, `src/github/dry-run.ts`, `src/github/fake.ts`
- Test: `tests/gh-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/gh-adapter.test.ts`:

```ts
test("listComments parses id+body json", async () => {
  const json = JSON.stringify([{ id: "10", body: "hello" }, { id: "11", body: "world" }]);
  const gh = new GhAdapter(async () => json);
  expect(await gh.listComments("o/r", 7)).toEqual([{ id: "10", body: "hello" }, { id: "11", body: "world" }]);
});

test("mergePR issues the correct gh argv", async () => {
  const captured: string[][] = [];
  const gh = new GhAdapter(async (args) => { captured.push(args); return ""; });
  await gh.mergePR("o/r", "feat/6-x");
  expect(captured[0]).toEqual(["pr", "merge", "feat/6-x", "--repo", "o/r", "--merge"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/gh-adapter.test.ts -t "listComments\|mergePR"`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement**

In `src/github/adapter.ts`, add to the interface (after `prState`):
```ts
  /** All comments on an issue/PR, oldest first. */
  listComments(repo: string, num: number): Promise<{ id: string; body: string }[]>;
  /** Merge the PR whose head is `branch` (a gated, human-approved action). */
  mergePR(repo: string, branch: string): Promise<void>;
```

In `src/github/gh-adapter.ts`, add the methods (place after `prState`):
```ts
  async listComments(repo: string, num: number): Promise<{ id: string; body: string }[]> {
    const out = await this.run([
      "api", `repos/${repo}/issues/${num}/comments`, "--jq", "[.[] | {id: (.id|tostring), body}]",
    ]).catch(() => "[]");
    return JSON.parse(out || "[]") as { id: string; body: string }[];
  }
  async mergePR(repo: string, branch: string): Promise<void> {
    await this.run(["pr", "merge", branch, "--repo", repo, "--merge"]);
  }
```

In `src/github/dry-run.ts`, add the read passthrough (in the read section) and the write (in the write section):
```ts
  listComments(repo: string, num: number): Promise<{ id: string; body: string }[]> {
    return this.inner.listComments(repo, num);
  }
```
```ts
  async mergePR(repo: string, branch: string): Promise<void> {
    this.actions.push({ op: "mergePR", repo, args: { branch } });
  }
```

In `src/github/fake.ts`, add a `merged` field (near `prStates`):
```ts
  public merged: string[] = [];
```
and the methods (near `prState`):
```ts
  async listComments(_r: string, n: number): Promise<{ id: string; body: string }[]> {
    return (this.comments[n] ?? []).map((body, i) => ({ id: String(i), body }));
  }
  async mergePR(_r: string, branch: string): Promise<void> {
    this.merged.push(branch);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/gh-adapter.test.ts`
Expected: PASS. Also `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/github/adapter.ts src/github/gh-adapter.ts src/github/dry-run.ts src/github/fake.ts tests/gh-adapter.test.ts
git commit -m "feat(#34): adapter listComments + mergePR"
```

---

## Task 2: `Action` union + `executeSafe`

**Files:**
- Create: `src/shell/actions.ts`
- Test: `tests/actions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/actions.test.ts`:

```ts
import { expect, test } from "vitest";
import { FakeGitHub } from "../src/github/fake.js";
import { executeSafe } from "../src/shell/actions.js";

const gh = () => new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });

test("reply posts a comment with a reply-marker; second call is idempotent (skips)", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "reply", num: 1, toCommentId: "99", body: "hi" });
  expect(g.comments[1]).toHaveLength(1);
  expect(g.comments[1][0]).toContain("hi");
  expect(g.comments[1][0]).toContain("<!--monastery-reply to=99-->");
  await executeSafe(g, "o/r", { kind: "reply", num: 1, toCommentId: "99", body: "hi again" });
  expect(g.comments[1]).toHaveLength(1); // already replied to comment 99 -> skipped
});

test("relabel adds and removes labels", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "relabel", num: 1, add: ["type:bug"], remove: [] });
  await executeSafe(g, "o/r", { kind: "relabel", num: 1, add: ["thesis:in"], remove: ["type:bug"] });
  const [i] = await g.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("thesis:in");
  expect(i.labels).not.toContain("type:bug");
});

test("panel upserts the single sticky panel, carrying a monastery marker", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "panel", num: 1, body: "status A" });
  await executeSafe(g, "o/r", { kind: "panel", num: 1, body: "status B" });
  expect(g.panels[1]).toContain("status B");            // upsert, not append (latest content)
  expect(g.panels[1]).not.toContain("status A");
  expect(g.panels[1]).toContain("<!--monastery-state"); // marker -> never mistaken for a human comment
});

test("openDraftPR opens once; skips when a PR already exists", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "openDraftPR", num: 1, branch: "feat/1-x", title: "t", body: "b" });
  expect(g.prs).toHaveLength(1);
  await executeSafe(g, "o/r", { kind: "openDraftPR", num: 1, branch: "feat/1-x", title: "t", body: "b" });
  expect(g.prs).toHaveLength(1); // findPrForBranch found it -> skipped
});

test("propose writes an approval panel + needs-approval label", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "propose", num: 1, proposal: "close", draft: "close because X" });
  expect(g.panels[1]).toContain("protocol: approval");
  expect(g.panels[1]).toContain("action: close");
  expect(g.panels[1]).toContain("close because X");
  const [i] = await g.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:needs-approval");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/actions.test.ts`
Expected: FAIL — `../src/shell/actions.js` not found.

- [ ] **Step 3: Implement `src/shell/actions.ts`**

```ts
// src/shell/actions.ts
import type { GitHubAdapter } from "../github/adapter.js";

export type GatedKind = "close" | "merge";

/** The SAFE actions an agent may propose. The agent NEVER proposes gated executors (see doClose/doMerge). */
export type Action =
  | { kind: "reply"; num: number; toCommentId: string; body: string }
  | { kind: "relabel"; num: number; add: string[]; remove: string[] }
  | { kind: "panel"; num: number; body: string }
  | { kind: "openDraftPR"; num: number; branch: string; title: string; body: string }
  | { kind: "propose"; num: number; proposal: GatedKind; draft: string };

const NEEDS_APPROVAL = "monastery:needs-approval";
const replyMarker = (toCommentId: string) => `<!--monastery-reply to=${toCommentId}-->`;
const approvalMarker = (proposal: GatedKind) => `<!--monastery-state\nprotocol: approval\naction: ${proposal}\n-->`;

/** Execute a SAFE action, idempotently (constitution §3, §6). */
export async function executeSafe(gh: GitHubAdapter, repo: string, a: Action): Promise<void> {
  switch (a.kind) {
    case "reply": {
      const marker = replyMarker(a.toCommentId);
      const existing = await gh.listComments(repo, a.num);
      if (existing.some((c) => c.body.includes(marker))) return; // already replied to this comment
      await gh.postComment(repo, a.num, `${a.body}\n\n${marker}`);
      return;
    }
    case "relabel":
      for (const l of a.add) await gh.addLabel(repo, a.num, l);
      for (const l of a.remove) await gh.removeLabel(repo, a.num, l);
      return;
    case "panel":
      // Carry the panel marker so upsertPanel finds its single sticky comment AND it's never mistaken
      // for a human comment (constitution §6, §7). The agent supplies content; the shell stamps the marker.
      await gh.upsertPanel(repo, a.num, `<!--monastery-state\nprotocol: note\n-->\n${a.body}`);
      return;
    case "openDraftPR":
      if (await gh.findPrForBranch(repo, a.branch)) return; // already open
      await gh.openDraftPR(repo, a.branch, a.title, a.body);
      return;
    case "propose":
      await gh.upsertPanel(repo, a.num, `${approvalMarker(a.proposal)}\n${a.draft}`);
      await gh.addLabel(repo, a.num, NEEDS_APPROVAL);
      return;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/actions.test.ts`
Expected: PASS (5 tests). Also `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/shell/actions.ts tests/actions.test.ts
git commit -m "feat(#34): Action union + executeSafe (idempotent safe actions)"
```

---

## Task 3: gated executors `doClose` / `doMerge`

**Files:**
- Modify: `src/shell/actions.ts`
- Test: `tests/actions.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/actions.test.ts`:

```ts
import { doClose, doMerge } from "../src/shell/actions.js"; // add to existing import line

test("doClose closes the issue and posts the reason", async () => {
  const g = gh();
  await doClose(g, "o/r", 1, "out of scope");
  expect(g.closed).toContain(1);
  expect(g.comments[1][0]).toBe("out of scope");
});

test("doMerge merges the PR; skips if already merged", async () => {
  const g = gh();
  await doMerge(g, "o/r", "feat/1-x");
  expect(g.merged).toEqual(["feat/1-x"]);
  g.prStates["feat/1-x"] = "merged";
  await doMerge(g, "o/r", "feat/1-x");
  expect(g.merged).toEqual(["feat/1-x"]); // already merged -> skipped
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/actions.test.ts -t "doClose\|doMerge"`
Expected: FAIL — `doClose`/`doMerge` not exported.

- [ ] **Step 3: Implement (append to `src/shell/actions.ts`)**

```ts
/**
 * GATED executors — shell-only, triggered by a human signal (PR Merge / issue 👍).
 * NOT in the Action union: there is no code path for the agent to call these (constitution §3, §4).
 */
export async function doClose(gh: GitHubAdapter, repo: string, num: number, reason: string): Promise<void> {
  // Close FIRST: a closed issue leaves the worklist, so this can't re-run and double-post the reason.
  await gh.closeIssue(repo, num);
  await gh.postComment(repo, num, reason);
}

export async function doMerge(gh: GitHubAdapter, repo: string, branch: string): Promise<void> {
  if ((await gh.prState(repo, branch)) === "merged") return; // idempotent: already merged
  await gh.mergePR(repo, branch);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/actions.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run` → all pass.
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/shell/actions.ts tests/actions.test.ts
git commit -m "feat(#34): gated executors doClose/doMerge (shell-only, human-triggered)"
```

---

## Final verification

- [ ] `npx vitest run` → all pass; `npx tsc --noEmit` → clean.
- [ ] Confirm: the `Action` union contains NO `close`/`merge` execution variant — only `propose` (constitution §3: the agent cannot fire gated actions).
- [ ] Open the PR: `gh pr create --base main --head feat/34-action-vocabulary --title "feat(#34): action vocabulary + safety classification" --body "Closes part of #34 — see docs/design/34-action-vocabulary.md"`.
```
