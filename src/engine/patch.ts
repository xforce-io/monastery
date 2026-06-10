// src/engine/patch.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepCtx } from "./issue-step.js";
import type { Issue, Outcome } from "../types.js";
import { reviewer, reviewerSpec, type ReviewFinding, type ReviewFn, type ReviewVerdict } from "../agents/reviewer.js";
import { patcherSpec } from "../agents/patcher.js";
import { effectivePolicy } from "../agents/spec.js";
import { isHumanComment } from "../shell/markers.js";
import type { Spec } from "../shell/consensus.js";
import { languageDirective, looksOffLanguage } from "../shell/language.js";
import { makePhaseLogger, type PhaseLogger } from "../phase-logger.js";

// Persona comes from the patcher's spec; operational knobs are resolved per-repo at run time (effectivePolicy).
const PERSONA = patcherSpec.persona;
const FIX_PERSONA = patcherSpec.fixPersona ?? patcherSpec.persona;

/** #76: prepend the repo's outward-text language directive to a persona; a no-op when no policy is set. */
function withLanguage(persona: string, language?: string): string {
  return language ? `${languageDirective(language)}\n\n${persona}` : persona;
}

const PATCH_NOTE_MARKER = "<!--monastery-state\nprotocol: note\n-->";

const BRANCH_SLUG_MAX = 50;

/** Parse the PR number from a PR url (`.../pull/N`); null if it doesn't match. */
function parsePrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function branchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BRANCH_SLUG_MAX)
    .replace(/-+$/, "");
  return slug ? `feat/${issueNumber}-${slug}` : `feat/${issueNumber}`;
}

function fixContext(issue: Issue, blocking: ReviewFinding[]): string {
  const items = blocking
    .map((b, i) => `${i + 1}. [${b.file ?? "?"}${b.line ? ":" + b.line : ""}] ${b.title}\n   ${b.detail}`)
    .join("\n");
  return `Fix issue #${issue.number} — the reviewer found these BLOCKING problems with your patch:\n\n${items}\n\nResolve every item above.`;
}

function reviewPanel(blocking: ReviewFinding[], iters: number): string {
  const list = blocking.map((b) => `- ${b.title}: ${b.detail}`).join("\n");
  return `${PATCH_NOTE_MARKER}\n⚠️ 自审在 ${iters} 轮后仍有未解决的 blocking — needs a human：\n${list}`;
}

function defaultReview(ctx: StepCtx): ReviewFn {
  return async (diff, issue) => {
    // Review artifacts live OUTSIDE the worktree so review.json never lands in the committed patch.
    const reviewDir = mkdtempSync(join(tmpdir(), "monastery-review-"));
    try {
      // #72/#131: reviewer model precedence — agents.reviewer.model → legacy ctx.reviewModel
      // (MONASTERY_REVIEW_MODEL) → strong model level → ctx.model.
      const reviewModel = effectivePolicy(reviewerSpec, ctx.repoPolicy).model ?? ctx.reviewModel ?? ctx.modelLevels?.strong ?? ctx.model;
      // #76: a review finding can land in a PR comment — give the reviewer the repo's language policy too.
      return await reviewer(ctx.provider, reviewModel, { diff, issue, language: ctx.language }, reviewDir);
    } finally {
      rmSync(reviewDir, { recursive: true, force: true });
    }
  };
}

/**
 * The shell-owned patcher executor (proposal-driven: the maintainer agent's `implement` action routes here).
 * Writes code in a sandbox clone, self-reviews, and opens a HUMAN-GATED draft PR. The agent never touches
 * git/gh — the shell owns clone/push/PR, and the only path to main is a human Merge (constitution §3/§4).
 *
 * #100: when an endorsed `spec` is supplied, ITS body — not the (possibly stale) issue body — is the
 * patcher's authoritative task description. The approval gate binds to a `spec: N` version (#95), so the
 * shell feeds the patcher exactly what was approved, closing the #99 hole where the patcher trusted a body
 * that still carried a rejected design.
 */
export async function runImplement(ctx: StepCtx, issue: Issue, spec?: Spec | null): Promise<Outcome> {
  const branch = branchName(issue.number, issue.title);
  const log = makePhaseLogger(ctx, issue.number);

  // Converge: an open PR already exists for this branch -> don't re-run the patcher (idempotent, PROTOCOL §7).
  // (Updating an OPEN PR from human feedback is rework's job, #79 — a distinct, gated action.)
  const existingPr = await ctx.gh.findPrForBranch(ctx.repo, branch);
  if (existingPr) return { kind: "progressed", note: existingPr };

  const clone = log.phase("clone");
  const dir = await ctx.ws.clone(ctx.repo, branch);
  clone.done();
  try {
    // #100: the endorsed spec (decision A) fully supersedes the issue body — the body may be stale (the very
    // failure in #99). No spec -> fall back to the body (plain-body issues are unchanged).
    const task = spec ? `endorsed spec v${spec.version}:\n\n${spec.body}` : issue.body;
    const context = `Fix issue #${issue.number}:\ntitle: ${issue.title}\n\n${task}`;
    const r = await patchAndReview(ctx, dir, issue, context, log);
    if (!r) return { kind: "noop" }; // bailed (no changes / review never converged) — panel already posted

    const pr = log.phase("pr");
    await ctx.ws.commitPush(dir, branch, `fix: address #${issue.number}`);

    const url = await ctx.gh.openDraftPR(ctx.repo, branch, `monastery: fix #${issue.number}`, prBody(issue, r));
    // The REVIEWER's voice = a separate marked comment on the PR (conclusion + advisory only).
    const prNum = parsePrNumber(url);
    if (prNum !== null) {
      await ctx.gh.postComment(ctx.repo, prNum, `${PATCH_NOTE_MARKER}\n${reviewSummary(r)}`);
    }
    pr.done({ url });
    return { kind: "progressed", note: url };
  } finally {
    await ctx.ws.cleanup(dir);
  }
}

const REWORK_MARKER = "<!--monastery-rework";
const REWORK_BUDGET = 3; // bounded self-revision: after this many rounds on one PR, stop and ask a human (#79)

/**
 * #79: update monastery's OWN open draft PR from human feedback, in place. The maintainer proposes `rework`
 * (human-gated like implement); the shell checks out the EXISTING branch, re-patches from the feedback, runs
 * the same self-review, and pushes to the SAME branch — never opening a second PR. Safety floors (spec v1):
 * only an open draft PR is reworkable (merged = terminal; closed → maintainer re-judges, #102); there must be
 * real human feedback; and a bounded attempt budget stops a runaway self-revision loop.
 */
export async function runRework(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const branch = branchName(issue.number, issue.title);
  const panel = (note: string) => ctx.gh.upsertPanel(ctx.repo, issue.number, `${PATCH_NOTE_MARKER}\n${note}`);

  // Guard 1: there must be monastery's own OPEN DRAFT PR. merged = terminal; anything else (none/closed) is
  // not reworkable here — a closed PR is the maintainer's call to re-judge (#102), not rework's to force.
  const state = await ctx.gh.prState(ctx.repo, branch);
  if (state === "merged") { await panel("✅ PR 已合并（merged）——无需 rework。"); return { kind: "noop" }; }
  const details = await ctx.gh.getPrDetails(ctx.repo, branch);
  if (!details || state !== "open" || !details.isDraft) {
    await panel("⚠️ 没有可 rework 的 open draft PR。"); return { kind: "noop" };
  }
  const prNum = details.number;

  // If a prior run pushed the rework but failed while writing the PR-thread round marker, it leaves this
  // issue-side recovery marker. Treat that as converged so the same feedback is not patched/pushed again.
  const issueComments = await ctx.gh.listComments(ctx.repo, issue.number);
  if (issueComments.some((c) => c.body.includes(REWORK_MARKER) && c.body.includes("committed=true"))) {
    return { kind: "progressed", note: details.url };
  }

  // Guard 2: there must be actual human feedback to act on (rework is feedback-driven, never self-initiated).
  const humanComments = (await ctx.gh.listPrComments(ctx.repo, prNum)).filter(isHumanComment);
  const humanReviews = (await ctx.gh.listPrReviews(ctx.repo, prNum)).filter((rv) => isHumanComment({ body: rv.body }));
  if (humanComments.length === 0 && humanReviews.length === 0) {
    await panel("⚠️ PR 上没有人类反馈可处理——不 rework。"); return { kind: "noop" };
  }

  // Guard 3: bounded attempt budget — count prior rework rounds already posted on the PR thread.
  const priorRounds = (await ctx.gh.listComments(ctx.repo, prNum)).filter((c) => c.body.includes(REWORK_MARKER)).length;
  if (priorRounds >= REWORK_BUDGET) {
    await panel(`⚠️ rework 已达 ${REWORK_BUDGET} 轮上限——needs a human。`); return { kind: "noop" };
  }
  const round = priorRounds + 1;
  const log = makePhaseLogger(ctx, issue.number);

  const clone = log.phase("clone");
  const dir = await ctx.ws.checkout(ctx.repo, branch); // EXISTING branch, in place
  clone.done();
  try {
    const feedback = [
      ...humanComments.map((c) => `<feedback author="${c.author}">\n${c.body}\n</feedback>`),
      ...humanReviews.map((rv) => `<review author="${rv.author}" state="${rv.state}">\n${rv.body}\n</review>`),
    ].join("\n");
    const context = [
      `Rework the OPEN draft PR for issue #${issue.number}: ${issue.title}`,
      `\nissue:\n${issue.body}`,
      `\ncurrent PR body:\n${details.body}`,
      `\nHuman feedback to address — this is WHY you are reworking; resolve every point:\n${feedback}`,
    ].join("\n");
    const r = await patchAndReview(ctx, dir, issue, context, log);
    if (!r) return { kind: "noop" }; // bailed — panel already posted

    const pr = log.phase("pr");
    await ctx.ws.commitPush(dir, branch, `fix: rework #${issue.number} (round ${round})`);

    const changes = r.authorSummary ? `\n\n## 本轮改动\n${r.authorSummary}` : "";
    try {
      await ctx.gh.postComment(ctx.repo, prNum,
        `${REWORK_MARKER} round=${round}-->\n🔁 **rework 第 ${round} 轮**（按人类反馈更新本 PR）${changes}\n\n${reviewSummary(r)}`);
    } catch (e) {
      await panel(`${REWORK_MARKER} round=${round} committed=true-->\n⚠️ rework 第 ${round} 轮已推送，但 PR 线程总结写入失败：${(e as Error).message}`);
      throw e;
    }
    pr.done({ round });
    return { kind: "progressed", note: details.url };
  } finally {
    await ctx.ws.cleanup(dir);
  }
}

interface PatchResult {
  diff: string;
  tests: boolean | null;
  authorSummary: string;
  reviewerFailed: boolean;
  fixedTitles: string[];
  lastVerdict: ReviewVerdict | null;
}

/**
 * Shared patch core (runImplement #88 + runRework #79): run the patcher in `dir` against `taskContext`, gate on
 * a non-empty diff, run tests, then the bounded self-review fix loop. Returns the artifacts, or null when it
 * bailed (no changes after the fail threshold, or review never converged) — in which case the human-facing
 * panel is already posted and the caller should return { kind: "noop" }.
 */
async function patchAndReview(ctx: StepCtx, dir: string, issue: Issue, taskContext: string, log: PhaseLogger): Promise<PatchResult | null> {
  const policy = effectivePolicy(patcherSpec, ctx.repoPolicy);
  const PATCH_FAIL_THRESHOLD = policy.failThreshold ?? 3;
  const REVIEW_MAX_ITERS = policy.maxIters ?? 3;
  const patcherModel = policy.model ?? ctx.modelLevels?.strong ?? ctx.model; // #72/#131: agents.patcher.model wins, then strong level

  const patch = log.phase("patch", { model: patcherModel });
  const implRes = await ctx.provider.run({ persona: withLanguage(PERSONA, ctx.language), context: taskContext, artifactDir: dir, model: patcherModel, timeoutMs: policy.timeoutMs });
  patch.done();
  // The patcher's stdout IS the author summary (what+why). It runs in the worktree, so it can't write a file
  // (that would land in the diff) — we capture resultText and render it into the PR body / round summary.
  let authorSummary = implRes.resultText?.trim() || "";
  warnIfOffLanguage(ctx, issue, authorSummary);
  let diff = await ctx.ws.stagedDiff(dir);

  if (!diff.trim()) {
    const fails = ctx.fails.recordFail(ctx.repo, issue.number);
    if (fails < PATCH_FAIL_THRESHOLD) {
      console.warn(`[monastery] patcher made no changes ${ctx.repo}#${issue.number} (${fails}/${PATCH_FAIL_THRESHOLD})`);
      return null;
    }
    await ctx.gh.upsertPanel(ctx.repo, issue.number,
      `${PATCH_NOTE_MARKER}\n⚠️ patcher made no changes after ${fails} attempts — needs a human.`);
    return null;
  }

  ctx.fails.clearFail(ctx.repo, issue.number);
  const runTests = async (): Promise<boolean | null> => {
    const t = log.phase("tests");
    const r = await ctx.ws.runTests(dir);
    t.done({ result: r === null ? "none" : String(r) });
    return r;
  };
  let tests = await runTests();
  // re-stage AFTER tests so files the test run regenerates (e.g. package-lock.json from npm install) are committed too
  diff = await ctx.ws.stagedDiff(dir);

  // Self-review gate: review the staged diff; fix BLOCKING findings and re-review (<= REVIEW_MAX_ITERS).
  const review = ctx.review ?? defaultReview(ctx);
  const fixedTitles: string[] = [];
  let lastVerdict: ReviewVerdict | null = null;
  let reviewerFailed = false;
  for (let iter = 1; iter <= REVIEW_MAX_ITERS; iter++) {
    const attempt = `${iter}/${REVIEW_MAX_ITERS}`;
    const rev = log.phase("review", { attempt });
    lastVerdict = await review(diff, issue);
    if (!lastVerdict) { rev.fail("reviewer-failed"); reviewerFailed = true; break; } // reviewer failed -> conservative pass
    const blocking = lastVerdict.findings.filter((f) => f.severity === "blocking");
    if (blocking.length === 0) { rev.done({ blocking: 0 }); break; }      // clean -> ship
    rev.done({ blocking: blocking.length });
    if (iter === REVIEW_MAX_ITERS) {                                     // give up -> needs a human, no PR
      await ctx.gh.upsertPanel(ctx.repo, issue.number, reviewPanel(blocking, REVIEW_MAX_ITERS));
      return null;
    }
    const fix = log.phase("patch:fix", { attempt, model: patcherModel });
    const fixRes = await ctx.provider.run({ persona: withLanguage(FIX_PERSONA, ctx.language), context: fixContext(issue, blocking), artifactDir: dir, model: patcherModel, timeoutMs: policy.timeoutMs });
    fix.done();
    if (fixRes.resultText?.trim()) { authorSummary = fixRes.resultText.trim(); warnIfOffLanguage(ctx, issue, authorSummary); }   // keep the summary current with the final diff
    fixedTitles.push(...blocking.map((b) => b.title));
    tests = await runTests();
    diff = await ctx.ws.stagedDiff(dir);
  }

  return { diff, tests, authorSummary, reviewerFailed, fixedTitles, lastVerdict };
}

/**
 * #76 enforcement (NON-blocking safety net): the patcher's author summary becomes the PR body, so if it
 * drifts off the repo's outward-text language, leave a warn trail for the human. We do NOT hard-block or
 * rewrite — the draft PR is itself the human review gate, and the issue's non-goal is "prevent obvious
 * drift", not "detect every mixing boundary" (over-eager rewrites risk false positives that lose work).
 */
function warnIfOffLanguage(ctx: StepCtx, issue: Issue, summary: string): void {
  if (ctx.language && looksOffLanguage(summary, ctx.language)) {
    console.warn(`[monastery] off-language patcher summary ${ctx.repo}#${issue.number}: expected ${ctx.language} — opening the draft PR anyway (human review is the gate).`);
  }
}

/** The PR body = the AUTHOR's voice only: 本次改动 + 测试状态 + Closes + diff (the reviewer's voice is a separate comment). */
function prBody(issue: Issue, r: PatchResult): string {
  const MAX_DIFF = 60000;
  const shownDiff = r.diff.length > MAX_DIFF ? r.diff.slice(0, MAX_DIFF) + "\n… [diff truncated; see the PR Files tab]" : r.diff;
  const testLine = r.tests === null ? "no test suite detected" : r.tests ? "tests passing" : "⚠️ tests FAILING";
  const changesBlock = r.authorSummary ? `## 本次改动\n\n${r.authorSummary}\n\n` : "";
  return [
    `Proposed fix for #${issue.number} (${testLine}).`,
    ``,
    `${changesBlock}Closes #${issue.number}`,
    ``,
    `<details><summary>diff</summary>`,
    ``,
    "```diff",
    shownDiff,
    "```",
    `</details>`,
    ``,
    `— monastery (draft; review and merge if good).`,
  ].join("\n");
}

/** The reviewer's voice: conclusion + advisory list (blocking never reaches here — it's resolved in the fix loop). */
function reviewSummary(r: PatchResult): string {
  const advisories = (r.lastVerdict?.findings ?? []).filter((f) => f.severity === "advisory");
  const reviewLine = r.reviewerFailed
    ? "⚠️ 自审未能运行（reviewer 失败）——本 PR 未经语义自审。"
    : r.fixedTitles.length
      ? `自审修正：\n${r.fixedTitles.map((t) => `- ${t}`).join("\n")}`
      : "自审通过：无 blocking。";
  const advisoryBlock = advisories.length ? `\n\nadvisory（未阻断）：\n${advisories.map((a) => `- ${a.title}`).join("\n")}` : "";
  return `${reviewLine}${advisoryBlock}`;
}
