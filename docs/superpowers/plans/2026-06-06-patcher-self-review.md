# Patcher Self-Review Gate (#22) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert an open-PR-前 local self-review loop into `runPatch`: an independent reviewer judges the staged diff against the issue; blocking findings are fixed and re-reviewed (≤3 iters) before the draft PR is opened.

**Architecture:** A new `reviewer` judge (mirrors `triager`) returns a zod-validated `{ findings: [...] }`. `runPatch` runs it in a loop between `runTests` and `openDraftPR`. The reviewer is an **injectable `StepCtx.review` collaborator** (default wraps the judge via `ctx.provider`) so loop tests script verdict sequences without a real LLM. Reviewer failure (null) = conservative pass.

**Tech Stack:** TypeScript (ESM, NodeNext), zod, vitest. Design source: `docs/design/22-patcher-self-review.md`.

---

## File Structure

- **Create** `src/judges/reviewer.ts` — `reviewer()` judge, `ReviewVerdict`/`ReviewFinding` types, `ReviewFn` type.
- **Modify** `src/engine/issue-step.ts` — `StepCtx` gains optional `reviewModel?: string` and `review?: ReviewFn`.
- **Modify** `src/engine/patch.ts` — review loop, `REVIEW_MAX_ITERS`, `FIX_PERSONA`, `fixContext`, `reviewPanel`, `defaultReview`, PR-body augmentation.
- **Modify** `src/cli/index.ts` — inject `reviewModel: process.env.MONASTERY_REVIEW_MODEL ?? model`.
- **Create** `tests/reviewer.test.ts` — judge contract tests.
- **Modify** `tests/issue-step.test.ts` — extend `ctx()` to accept a `review` fn; add loop tests; inject a clean review into the existing "try-fix with changes" test.

`ReviewFn` lives in `reviewer.ts` (not `patch.ts`) so `issue-step.ts` can import it for `StepCtx` without a cycle (`patch.ts` already imports `StepCtx` from `issue-step.ts`).

---

## Task 1: reviewer judge + schema

**Files:**
- Create: `src/judges/reviewer.ts`
- Test: `tests/reviewer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/reviewer.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider/fake.js";
import { reviewer } from "../src/judges/reviewer.js";
import type { Issue } from "../src/types.js";

const issue: Issue = { number: 1, title: "t", body: "b", labels: [], state: "open" };
const dir = () => mkdtempSync(join(tmpdir(), "rev-"));

test("valid review.json -> parsed findings", async () => {
  const d = dir();
  const provider = new FakeProvider({
    "review.json": JSON.stringify({ findings: [{ severity: "blocking", title: "wrong", detail: "x" }] }),
  });
  const v = await reviewer(provider, "haiku", { diff: "d", issue }, d);
  expect(v).toEqual({ findings: [{ severity: "blocking", title: "wrong", detail: "x" }] });
  rmSync(d, { recursive: true, force: true });
});

test("empty findings -> clean verdict", async () => {
  const d = dir();
  const v = await reviewer(new FakeProvider({ "review.json": '{"findings":[]}' }), "haiku", { diff: "d", issue }, d);
  expect(v).toEqual({ findings: [] });
  rmSync(d, { recursive: true, force: true });
});

test("missing review.json -> null", async () => {
  const d = dir();
  const v = await reviewer(new FakeProvider({}), "haiku", { diff: "d", issue }, d);
  expect(v).toBeNull();
  rmSync(d, { recursive: true, force: true });
});

test("invalid schema -> null", async () => {
  const d = dir();
  const v = await reviewer(new FakeProvider({ "review.json": '{"findings":[{"severity":"nope"}]}' }), "haiku", { diff: "d", issue }, d);
  expect(v).toBeNull();
  rmSync(d, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reviewer.test.ts`
Expected: FAIL — `Cannot find module '../src/judges/reviewer.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/judges/reviewer.ts`:

```ts
// src/judges/reviewer.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue } from "../types.js";

const FindingSchema = z.object({
  severity: z.enum(["blocking", "advisory"]),
  title: z.string(),
  detail: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
});
const ReviewSchema = z.object({ findings: z.array(FindingSchema) });
export type ReviewFinding = z.infer<typeof FindingSchema>;
export type ReviewVerdict = z.infer<typeof ReviewSchema>;

/** Injectable reviewer: judges a staged diff against the issue. Returns null on missing/invalid output. */
export type ReviewFn = (diff: string, issue: Issue) => Promise<ReviewVerdict | null>;

const PERSONA = [
  "You are monastery's code reviewer.",
  "Review a proposed patch (a unified diff) against the GitHub issue it claims to resolve.",
  "You have no GitHub access; you only read the input and write one file.",
].join(" ");

export async function reviewer(
  provider: AgentProvider,
  model: string,
  input: { diff: string; issue: Issue },
  artifactDir: string,
): Promise<ReviewVerdict | null> {
  const { diff, issue } = input;
  const context = [
    `<issue number="${issue.number}">\ntitle: ${issue.title}\n\n${issue.body}\n</issue>`,
    `<diff>\n${diff}\n</diff>`,
    `Judge the diff. BLOCKING = a correctness bug, a deviation from the issue's design/acceptance, a test that passes but asserts the wrong thing, or a security problem. ADVISORY = style, naming, or simplification nits.`,
    `Write ONLY the file review.json with this exact shape and nothing else:`,
    `{ "findings": [ { "severity": "blocking" | "advisory", "title": string, "detail": string, "file"?: string, "line"?: number } ] }`,
    `An empty findings array means the patch is good to ship.`,
  ].join("\n\n");

  const res = await provider.run({ persona: PERSONA, context, artifactDir, model });

  const p = join(artifactDir, "review.json");
  if (existsSync(p)) {
    const parsed = ReviewSchema.safeParse(safeJson(readFileSync(p, "utf8")));
    if (parsed.success) return parsed.data;
  }
  if (res.resultText) {
    const parsed = ReviewSchema.safeParse(safeJson(res.resultText));
    if (parsed.success) return parsed.data;
  }
  return null;
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reviewer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/judges/reviewer.ts tests/reviewer.test.ts
git commit -m "feat(#22): reviewer judge — zod-validated diff review findings"
```

---

## Task 2: StepCtx wiring + review loop (clean & conservative-pass paths)

**Files:**
- Modify: `src/engine/issue-step.ts` (StepCtx)
- Modify: `src/engine/patch.ts` (loop scaffold)
- Modify: `tests/issue-step.test.ts` (ctx helper + tests)

- [ ] **Step 1: Write the failing tests**

In `tests/issue-step.test.ts`, first **extend the `ctx()` helper** to accept a `review` fn. Replace the existing `ctx` definition with:

```ts
import type { ReviewFn, ReviewVerdict } from "../src/judges/reviewer.js";

const ctx = (
  gh: FakeGitHub,
  provider: FakeProvider,
  ws: FakeWorkspace = new FakeWorkspace(),
  now: () => number = () => 0,
  review?: ReviewFn,
) => ({
  repo: "o/r", gh, provider, model: "haiku",
  artifactRoot: mkdtempSync(join(tmpdir(), "monastery-step-")),
  fails: fakeFails(),
  ws,
  now,
  review,
});

// Returns a ReviewFn that yields the scripted verdicts in order (repeats the last one if over-called).
const scriptedReview = (verdicts: (ReviewVerdict | null)[]): ReviewFn => {
  let i = 0;
  return async () => verdicts[Math.min(i++, verdicts.length - 1)];
};
```

Then **update the existing "try-fix with changes" test** (number 30) to inject a clean review so it tests the intended happy path. Change its `ctx(...)` call to:

```ts
  const c = ctx(gh, new FakeProvider({}), ws, () => 0, scriptedReview([{ findings: [] }]));
```

Add these new tests:

```ts
test("try-fix clean review -> draft PR opened, no fix run, diff staged twice", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 70, title: "bug", body: "broken", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const provider = new FakeProvider({});
  const c = ctx(gh, provider, ws, () => 0, scriptedReview([{ findings: [] }]));
  const out = await issueStep(c, 70);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);
  expect(provider.calls).toHaveLength(1); // only the initial edit; no fix run
  expect(ws.diffCalls).toBe(2);           // re-stage after tests reused for the first review
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("try-fix reviewer fails (null) -> conservative pass, PR opens with a note", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 71, title: "bug", body: "broken", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const c = ctx(gh, new FakeProvider({}), ws, () => 0, scriptedReview([null]));
  const out = await issueStep(c, 71);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);   // reviewer failure does not block delivery (body note added in Task 5)
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/issue-step.test.ts -t "clean review"`
Expected: FAIL — `ctx`/`scriptedReview` type errors or `review` not used by `runPatch` yet (PR opens but `provider.calls`/body assertions or types fail).

- [ ] **Step 3a: Add the StepCtx fields**

In `src/engine/issue-step.ts`, add the import and two optional fields to `StepCtx`:

```ts
import type { ReviewFn } from "../judges/reviewer.js";
```

```ts
export interface StepCtx {
  repo: string;
  gh: GitHubAdapter;
  provider: AgentProvider;
  model: string;
  artifactRoot: string;
  fails: FailTracker;
  ws: Workspace;
  now: () => number;
  reviewModel?: string;   // model for the reviewer judge (defaults to `model`)
  review?: ReviewFn;      // injectable reviewer (defaults to the real judge via provider)
}
```

(Keep the existing fields exactly as they are; only add `reviewModel?` and `review?`. If `now` is not yet on `StepCtx` in your branch, it is — it was added by #6.)

- [ ] **Step 3b: Add the review loop to runPatch**

In `src/engine/patch.ts`, update imports at the top:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepCtx } from "./issue-step.js";
import type { Issue, Outcome } from "../types.js";
import { TRY_FIX, PATCH_PROPOSED, NEEDS_HUMAN } from "../github/labels.js";
import { reviewer, type ReviewFinding, type ReviewFn, type ReviewVerdict } from "../judges/reviewer.js";
```

Add constants + helpers near the existing `PERSONA`:

```ts
const REVIEW_MAX_ITERS = 3;

const FIX_PERSONA = [
  "You are monastery's patcher, addressing review feedback.",
  "A reviewer flagged BLOCKING issues in your last change. Fix every one by editing files in this repository, then stop.",
  "Do NOT touch git or gh — leave your changes in the working tree.",
  "Make the smallest correct change that resolves every blocking item.",
].join(" ");

function fixContext(issue: Issue, blocking: ReviewFinding[]): string {
  const items = blocking
    .map((b, i) => `${i + 1}. [${b.file ?? "?"}${b.line ? ":" + b.line : ""}] ${b.title}\n   ${b.detail}`)
    .join("\n");
  return `Fix issue #${issue.number} — the reviewer found these BLOCKING problems with your patch:\n\n${items}\n\nResolve every item above.`;
}

function reviewPanel(blocking: ReviewFinding[]): string {
  const list = blocking.map((b) => `- ${b.title}: ${b.detail}`).join("\n");
  return `<!--monastery-state\nprotocol: patch\n-->\n⚠️ 自审在 ${REVIEW_MAX_ITERS} 轮后仍有未解决的 blocking — needs a human：\n${list}`;
}

function defaultReview(ctx: StepCtx): ReviewFn {
  return (diff, issue) =>
    reviewer(ctx.provider, ctx.reviewModel ?? ctx.model, { diff, issue }, mkdtempSync(join(tmpdir(), "monastery-review-")));
}
```

Now locate the tail of `runPatch` (after the no-changes check). It currently reads:

```ts
    ctx.fails.clearFail(ctx.repo, issue.number);
    const tests = await ctx.ws.runTests(dir);
    // re-stage AFTER tests so files the test run regenerates (e.g. package-lock.json from npm install) are committed too
    diff = await ctx.ws.stagedDiff(dir);
    await ctx.ws.commitPush(dir, branch, `fix: address #${issue.number}`);
```

Replace that block (down to and including the `commitPush` line) with:

```ts
    ctx.fails.clearFail(ctx.repo, issue.number);
    let tests = await ctx.ws.runTests(dir);
    // re-stage AFTER tests so files the test run regenerates (e.g. package-lock.json from npm install) are committed too
    diff = await ctx.ws.stagedDiff(dir);

    // Self-review gate: review the staged diff; fix BLOCKING findings and re-review (<= REVIEW_MAX_ITERS).
    const review = ctx.review ?? defaultReview(ctx);
    const fixedTitles: string[] = [];
    let lastVerdict: ReviewVerdict | null = null;
    let reviewerFailed = false;
    for (let iter = 1; iter <= REVIEW_MAX_ITERS; iter++) {
      lastVerdict = await review(diff, issue);
      if (!lastVerdict) { reviewerFailed = true; break; }                 // reviewer failed -> conservative pass
      const blocking = lastVerdict.findings.filter((f) => f.severity === "blocking");
      if (blocking.length === 0) break;                                    // clean -> ship
      if (iter === REVIEW_MAX_ITERS) {                                     // give up -> needs a human, no PR
        await ctx.gh.addLabel(ctx.repo, issue.number, NEEDS_HUMAN);
        await ctx.gh.upsertPanel(ctx.repo, issue.number, reviewPanel(blocking));
        return { kind: "noop" };
      }
      await ctx.provider.run({ persona: FIX_PERSONA, context: fixContext(issue, blocking), artifactDir: dir, model: ctx.model });
      fixedTitles.push(...blocking.map((b) => b.title));
      tests = await ctx.ws.runTests(dir);
      diff = await ctx.ws.stagedDiff(dir);
    }

    await ctx.ws.commitPush(dir, branch, `fix: address #${issue.number}`);
```

(The PR-body lines that follow `commitPush` are augmented in Task 5. For now they keep using `tests`/`diff` — both are still in scope.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/issue-step.test.ts -t "review"`
Expected: PASS — "clean review", "reviewer fails (null)", and the updated "try-fix with changes" all green. (The reviewer-fails body note is asserted later, in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add src/engine/issue-step.ts src/engine/patch.ts tests/issue-step.test.ts
git commit -m "feat(#22): review loop scaffold — clean & conservative-pass paths"
```

---

## Task 3: blocking → fix → clean

**Files:**
- Test: `tests/issue-step.test.ts`

The loop logic for this path was written in Task 2 (Step 3b). This task adds its test.

- [ ] **Step 1: Write the failing test**

Add to `tests/issue-step.test.ts`:

```ts
test("try-fix blocking then clean -> one fix run, then PR opened", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 72, title: "bug", body: "broken", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const provider = new FakeProvider({});
  const review = scriptedReview([
    { findings: [{ severity: "blocking", title: "off-by-one", detail: "loop bound" }] },
    { findings: [] },
  ]);
  const c = ctx(gh, provider, ws, () => 0, review);
  const out = await issueStep(c, 72);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);
  expect(provider.calls).toHaveLength(2);       // initial edit + one fix run
  expect(provider.calls[1].persona).toContain("addressing review feedback");
  expect(ws.diffCalls).toBe(3);                 // re-stage after tests, then after the fix
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/issue-step.test.ts -t "blocking then clean"`
Expected: PASS (logic already implemented in Task 2).

If it FAILS, the loop in `patch.ts` is wrong — fix the loop, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/issue-step.test.ts
git commit -m "test(#22): blocking->fix->clean review path"
```

---

## Task 4: cap exhaustion → needs-human, no PR

**Files:**
- Test: `tests/issue-step.test.ts`

Logic written in Task 2; this task adds its test.

- [ ] **Step 1: Write the failing test**

```ts
test("try-fix review never clean -> needs-human after 3 iters, no PR", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 73, title: "bug", body: "broken", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const blocking = { findings: [{ severity: "blocking" as const, title: "still wrong", detail: "d" }] };
  const c = ctx(gh, new FakeProvider({}), ws, () => 0, scriptedReview([blocking, blocking, blocking]));
  const out = await issueStep(c, 73);
  expect(out).toEqual({ kind: "noop" });
  expect(gh.prs).toHaveLength(0);                       // never opened a PR
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:needs-human");
  expect(gh.panels[73]).toContain("still wrong");
  expect(ws.committed).toHaveLength(0);                 // no push
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/issue-step.test.ts -t "never clean"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/issue-step.test.ts
git commit -m "test(#22): review cap -> needs-human, no PR"
```

---

## Task 5: PR body — review summary + advisory + reviewer-failed note

**Files:**
- Modify: `src/engine/patch.ts` (PR body)
- Test: `tests/issue-step.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("advisory-only review -> no fix, PR body lists advisory", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 74, title: "bug", body: "broken", labels: ["monastery:try-fix"], state: "open" }] });
  const ws = new FakeWorkspace({ diff: "--- a\n+++ b\n@@ fix @@", tests: true });
  const review = scriptedReview([{ findings: [{ severity: "advisory", title: "rename foo", detail: "clarity" }] }]);
  const c = ctx(gh, new FakeProvider({}), ws, () => 0, review);
  const out = await issueStep(c, 74);
  expect(out.kind).toBe("progressed");
  expect(gh.prs).toHaveLength(1);
  expect(gh.prs[0].body).toContain("rename foo");       // advisory surfaced in PR body
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
```

Also add a body assertion to the Task 2 "reviewer fails (null)" test:

```ts
  expect(gh.prs[0].body).toContain("自审未能运行"); // conservative-pass note
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/issue-step.test.ts -t "advisory-only"`
Expected: FAIL — body does not yet contain "rename foo".

- [ ] **Step 3: Augment the PR body**

In `src/engine/patch.ts`, find the existing PR-body construction:

```ts
    const MAX_DIFF = 60000;
    const shownDiff = diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + "\n… [diff truncated; see the PR Files tab]" : diff;
    const testLine = tests === null ? "no test suite detected" : tests ? "tests passing" : "⚠️ tests FAILING";
    const body = [
      `Proposed fix for #${issue.number} (${testLine}).`,
      ``,
      `Closes #${issue.number}`,
      ``,
```

Insert a review section immediately after the `testLine` declaration and into the `body` array:

```ts
    const advisories = (lastVerdict?.findings ?? []).filter((f) => f.severity === "advisory");
    const reviewLine = reviewerFailed
      ? "⚠️ 自审未能运行（reviewer 失败）——本 PR 未经语义自审。"
      : fixedTitles.length
        ? `自审修正：\n${fixedTitles.map((t) => `- ${t}`).join("\n")}`
        : "自审通过：无 blocking。";
    const advisoryBlock = advisories.length ? `\n\nadvisory（未阻断）：\n${advisories.map((a) => `- ${a.title}`).join("\n")}` : "";
    const body = [
      `Proposed fix for #${issue.number} (${testLine}).`,
      ``,
      `${reviewLine}${advisoryBlock}`,
      ``,
      `Closes #${issue.number}`,
      ``,
```

(Keep the rest of the `body` array — the `<details>` diff block and the footer — exactly as it is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/issue-step.test.ts -t "advisory-only"`
Run: `npx vitest run tests/issue-step.test.ts -t "reviewer fails"`
Expected: both PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all tests PASS (existing + new). If "try-fix with changes" fails on `diffCalls`, confirm Task 2 reused the post-test diff for the first review (no extra `stagedDiff` on the clean path).

- [ ] **Step 6: Commit**

```bash
git add src/engine/patch.ts tests/issue-step.test.ts
git commit -m "feat(#22): PR body — review summary, advisory, reviewer-failed note"
```

---

## Task 6: CLI injects reviewModel

**Files:**
- Modify: `src/cli/index.ts`

The CLI `main()` is not unit-tested (only `parseArgs` is), so this task is verified by `tsc` + build, not a unit test.

- [ ] **Step 1: Inject reviewModel into the ctx**

In `src/cli/index.ts`, find the `step` command's ctx construction:

```ts
      const ctx = { repo, gh, provider, model, artifactRoot: mkdtempSync(join(tmpdir(), "monastery-")), fails: store, ws: new GitWorkspace(), now: () => Date.now() };
```

Change it to add `reviewModel`:

```ts
      const ctx = { repo, gh, provider, model, reviewModel: process.env.MONASTERY_REVIEW_MODEL ?? model, artifactRoot: mkdtempSync(join(tmpdir(), "monastery-")), fails: store, ws: new GitWorkspace(), now: () => Date.now() };
```

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors; `ESM ⚡️ Build success`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(#22): CLI injects MONASTERY_REVIEW_MODEL into ctx"
```

---

## Final verification

- [ ] Run `npx vitest run` → all pass.
- [ ] Run `npx tsc --noEmit` → clean.
- [ ] Confirm the existing patch behavior is unchanged for the no-changes and PR-already-exists paths (those return before the review loop).
- [ ] Open the PR: `gh pr create --base main --head feat/22-patcher-self-review --title "feat(#22): patcher self-review gate" --body "Closes #22 — see docs/design/22-patcher-self-review.md"`.
