# Patch Completion Detection (#31) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop leaving `patch-proposed` issues stuck when a human closes the PR: monastery detects the PR's outcome (merged/closed) and reconciles the issue (done / declined-terminal).

**Architecture:** A new `GitHubAdapter.prState(repo, branch)` read returns `open|merged|closed|null`. `patch-proposed` issues become runnable; `issueStep` reconciles them against their PR's state instead of parking forever. The human's direct merge is the approval (no monastery-side merge, no LLM).

**Tech Stack:** TypeScript (ESM, NodeNext), vitest. Design source: `docs/design/31-patch-completion-detection.md`.

---

## File Structure

- **Modify** `src/github/adapter.ts` — add `prState` to the interface.
- **Modify** `src/github/gh-adapter.ts` — implement `prState` via `gh pr list`.
- **Modify** `src/github/dry-run.ts` — passthrough `prState` (read).
- **Modify** `src/github/fake.ts` — `prStates` injection + `prState`.
- **Modify** `src/engine/issue-step.ts` — `patch-proposed` → `reconcilePatchOutcome` + `terminalizePatchDeclined`.
- **Modify** `src/engine/reconcile.ts` — make `patch-proposed` runnable.
- **Tests**: `tests/gh-adapter.test.ts`, `tests/issue-step.test.ts`, `tests/reconcile.test.ts`.

`branchName` is already exported from `src/engine/patch.ts`; `issue-step.ts` already imports from `./patch.js` (`runPatch`), so adding `branchName` to that import introduces no cycle (patch.ts's back-reference to `StepCtx` is `import type`, erased at runtime).

---

## Task 1: `GitHubAdapter.prState`

**Files:**
- Modify: `src/github/adapter.ts`, `src/github/gh-adapter.ts`, `src/github/dry-run.ts`, `src/github/fake.ts`
- Test: `tests/gh-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/gh-adapter.test.ts`:

```ts
test("prState returns the lowercased PR state, null when absent", async () => {
  const captured: string[][] = [];
  const merged = new GhAdapter(async (args) => { captured.push(args); return "MERGED"; });
  expect(await merged.prState("o/r", "feat/28-x")).toBe("merged");
  expect(captured[0]).toEqual(["pr", "list", "--repo", "o/r", "--head", "feat/28-x", "--state", "all", "--json", "state", "--jq", '.[0].state // ""']);
  expect(await new GhAdapter(async () => "OPEN").prState("o/r", "x")).toBe("open");
  expect(await new GhAdapter(async () => "CLOSED").prState("o/r", "x")).toBe("closed");
  expect(await new GhAdapter(async () => "").prState("o/r", "nope")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gh-adapter.test.ts -t prState`
Expected: FAIL — `prState` is not a function / not on the type.

- [ ] **Step 3: Implement across the four adapter files**

In `src/github/adapter.ts`, add to the `GitHubAdapter` interface (next to `findPrForBranch`):
```ts
  prState(repo: string, branch: string): Promise<"open" | "merged" | "closed" | null>;
```

In `src/github/gh-adapter.ts`, add the method (mirror `findPrForBranch`):
```ts
  async prState(repo: string, branch: string): Promise<"open" | "merged" | "closed" | null> {
    const out = await this.run(
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "state", "--jq", '.[0].state // ""'],
    ).catch(() => "");
    const s = out.trim().toLowerCase();
    return s === "open" || s === "merged" || s === "closed" ? s : null;
  }
```

In `src/github/dry-run.ts`, add the passthrough (it's a read, no side effect):
```ts
  prState(repo: string, branch: string): Promise<"open" | "merged" | "closed" | null> { return this.inner.prState(repo, branch); }
```

In `src/github/fake.ts`, add a public injection field (near `labelTimes`):
```ts
  /** Injected PR states, keyed by branch -> "open"|"merged"|"closed". */
  public prStates: Record<string, "open" | "merged" | "closed"> = {};
```
and the method (near `findPrForBranch`):
```ts
  async prState(_repo: string, branch: string): Promise<"open" | "merged" | "closed" | null> {
    return this.prStates[branch] ?? null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gh-adapter.test.ts -t prState`
Expected: PASS. Also `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/github/adapter.ts src/github/gh-adapter.ts src/github/dry-run.ts src/github/fake.ts tests/gh-adapter.test.ts
git commit -m "feat(#31): GitHubAdapter.prState (open|merged|closed|null)"
```

---

## Task 2: issueStep reconciles patch-proposed against PR outcome

**Files:**
- Modify: `src/engine/issue-step.ts`
- Test: `tests/issue-step.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/issue-step.test.ts` (the `ctx()` helper and `FakeGitHub` are already imported there):

```ts
test("patch-proposed + PR open -> noop (still waiting)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 80, title: "x", body: "y", labels: ["monastery:patch-proposed"], state: "open" }] });
  gh.prStates["feat/80-x"] = "open";
  const c = ctx(gh, new FakeProvider({}));
  expect(await issueStep(c, 80)).toEqual({ kind: "noop" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:patch-proposed"); // untouched
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("patch-proposed + PR closed unmerged -> declined terminal, un-stuck", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 81, title: "x", body: "y", labels: ["monastery:patch-proposed"], state: "open" }] });
  gh.prStates["feat/81-x"] = "closed";
  const c = ctx(gh, new FakeProvider({}));
  expect(await issueStep(c, 81)).toEqual({ kind: "done" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:declined");
  expect(i.labels).toContain("monastery/state:done");
  expect(i.labels).not.toContain("monastery:patch-proposed");
  expect(gh.panels[81]).toContain("未合并");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("patch-proposed + PR merged -> state:done, un-stuck", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 82, title: "x", body: "y", labels: ["monastery:patch-proposed"], state: "open" }] });
  gh.prStates["feat/82-x"] = "merged";
  const c = ctx(gh, new FakeProvider({}));
  expect(await issueStep(c, 82)).toEqual({ kind: "done" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery/state:done");
  expect(i.labels).not.toContain("monastery:patch-proposed");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
```

(Branch names: `branchName(80, "x")` → `feat/80-x`, etc. — the slug of `"x"` is `x`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/issue-step.test.ts -t "patch-proposed + PR"`
Expected: FAIL — patch-proposed still returns a blind `noop`, so the closed/merged cases don't transition.

- [ ] **Step 3: Implement in `src/engine/issue-step.ts`**

Add `branchName` to the existing patch import:
```ts
import { runPatch, branchName } from "./patch.js";
```

Replace this line near the top of `issueStep`:
```ts
  if (issue.labels.includes(PATCH_PROPOSED) || issue.labels.includes(NEEDS_HUMAN)) return { kind: "noop" }; // parked
```
with:
```ts
  if (issue.labels.includes(NEEDS_HUMAN)) return { kind: "noop" }; // parked for a human
  if (issue.labels.includes(PATCH_PROPOSED)) return reconcilePatchOutcome(ctx, issue);
```

Add these two functions (place them near `terminalizeDeclined`):
```ts
/** A patch-proposed issue: reconcile against its PR's actual outcome. The human merges/closes the PR
 *  directly (their merge is the approval); monastery only detects the result. */
async function reconcilePatchOutcome(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const branch = branchName(issue.number, issue.title);
  switch (await ctx.gh.prState(ctx.repo, branch)) {
    case "merged":
      // Defensive: `Closes #N` usually auto-closes the issue (so we never see it here). Mark done anyway.
      await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("done"));
      await ctx.gh.removeLabel(ctx.repo, issue.number, PATCH_PROPOSED);
      return { kind: "done" };
    case "closed":
      return terminalizePatchDeclined(ctx, issue);
    default:
      return { kind: "noop" }; // open / null -> keep waiting on the human
  }
}

/** Human closed the PR unmerged -> the patch is declined; un-stick the issue to a terminal state. */
async function terminalizePatchDeclined(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  await ctx.gh.addLabel(ctx.repo, issue.number, DECLINED);
  await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("done"));
  await ctx.gh.removeLabel(ctx.repo, issue.number, PATCH_PROPOSED);
  await ctx.gh.upsertPanel(ctx.repo, issue.number, `${PANEL_PREFIX}\nPR 已关闭未合并 — patch 被拒，monastery 不再处理。`);
  return { kind: "done" };
}
```
(`DECLINED`, `PATCH_PROPOSED`, `stateLabel`, `PANEL_PREFIX` are already imported/defined in this file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/issue-step.test.ts`
Expected: PASS — the 3 new tests plus all existing ones (the existing "patch-proposed is parked" tests still get `noop` because their `prStates` are unset → `prState` returns `null` → default `noop`).
Also `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/engine/issue-step.ts tests/issue-step.test.ts
git commit -m "feat(#31): reconcile patch-proposed issues against PR outcome"
```

---

## Task 3: reconcile makes patch-proposed runnable

**Files:**
- Modify: `src/engine/reconcile.ts`
- Test: `tests/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/reconcile.test.ts` (use the file's existing ctx/setup pattern — a `FakeGitHub` + the ctx object passed to `reconcile`):

```ts
test("patch-proposed with a closed PR is runnable -> reconciled to declined", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 90, title: "x", body: "y", labels: ["monastery:patch-proposed"], state: "open" }] });
  gh.prStates["feat/90-x"] = "closed";
  const c = makeCtx(gh); // the existing ctx builder used by other tests in this file
  const r = await reconcile(c);
  expect(r.advanced).toBe(1);
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:declined");
  expect(i.labels).not.toContain("monastery:patch-proposed");
});
```
Note: replace `makeCtx(gh)` with however this test file already constructs the reconcile ctx (e.g. an inline object `{ repo: "o/r", gh, provider: new FakeProvider({}), model: "haiku", artifactRoot: mkdtempSync(...), fails: ..., ws: new FakeWorkspace(), now: () => 0 }`). Match the existing tests in the file exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts -t "patch-proposed with a closed PR"`
Expected: FAIL — `advanced` is `0` because `patch-proposed` is still filtered out of `runnable` (never reaches `issueStep`).

- [ ] **Step 3: Make patch-proposed runnable in `src/engine/reconcile.ts`**

In the `runnable` filter, replace this line:
```ts
    if (i.labels.includes(PATCH_PROPOSED) || i.labels.includes(NEEDS_HUMAN)) return false; // parked
```
with:
```ts
    if (i.labels.includes(NEEDS_HUMAN)) return false; // parked for a human
    if (i.labels.includes(PATCH_PROPOSED)) return true; // runnable: reconcile against the PR's outcome
```
(The later `try-fix` line's `&& !i.labels.includes(PATCH_PROPOSED)` guard is now redundant but harmless — leave it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reconcile.test.ts`
Expected: PASS — the new test plus all existing reconcile tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/reconcile.ts tests/reconcile.test.ts
git commit -m "feat(#31): patch-proposed issues are runnable (reconcile PR outcome)"
```

---

## Final verification

- [ ] `npx vitest run` → all pass.
- [ ] `npx tsc --noEmit` → clean.
- [ ] Confirm backward compatibility: existing "patch-proposed is parked / not patched again" tests still pass (unset `prStates` → `prState` null → `noop`).
- [ ] Open the PR: `gh pr create --base main --head feat/31-patch-completion-detection --title "feat(#31): patch completion detection" --body "Closes #31 — see docs/design/31-patch-completion-detection.md"`.
