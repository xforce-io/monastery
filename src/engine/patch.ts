// src/engine/patch.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepCtx } from "./issue-step.js";
import type { Issue, Outcome } from "../types.js";
import { reviewer, type ReviewFinding, type ReviewFn, type ReviewVerdict } from "../judges/reviewer.js";

const PATCH_FAIL_THRESHOLD = 3;
const PATCH_NOTE_MARKER = "<!--monastery-state\nprotocol: note\n-->";

const BRANCH_SLUG_MAX = 50;

export function branchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BRANCH_SLUG_MAX)
    .replace(/-+$/, "");
  return slug ? `feat/${issueNumber}-${slug}` : `feat/${issueNumber}`;
}

const PERSONA = [
  "You are monastery's patcher.",
  "Fix the described GitHub issue by editing files in this repository, then run the test suite.",
  "Do NOT touch git or gh — leave your changes in the working tree.",
  "Make the smallest correct change.",
].join(" ");

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
  return `${PATCH_NOTE_MARKER}\n⚠️ 自审在 ${REVIEW_MAX_ITERS} 轮后仍有未解决的 blocking — needs a human：\n${list}`;
}

function defaultReview(ctx: StepCtx): ReviewFn {
  return async (diff, issue) => {
    // Review artifacts live OUTSIDE the worktree so review.json never lands in the committed patch.
    const reviewDir = mkdtempSync(join(tmpdir(), "monastery-review-"));
    try {
      return await reviewer(ctx.provider, ctx.reviewModel ?? ctx.model, { diff, issue }, reviewDir);
    } finally {
      rmSync(reviewDir, { recursive: true, force: true });
    }
  };
}

/**
 * The shell-owned patcher executor (proposal-driven: the maintainer agent's `implement` action routes here).
 * Writes code in a sandbox clone, self-reviews, and opens a HUMAN-GATED draft PR. The agent never touches
 * git/gh — the shell owns clone/push/PR, and the only path to main is a human Merge (constitution §3/§4).
 */
export async function runImplement(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const branch = branchName(issue.number, issue.title);

  // Converge: an open PR already exists for this branch -> don't re-run the patcher (idempotent, PROTOCOL §7).
  const existingPr = await ctx.gh.findPrForBranch(ctx.repo, branch);
  if (existingPr) return { kind: "progressed", note: existingPr };

  const dir = await ctx.ws.clone(ctx.repo, branch);
  try {
    const context = `Fix issue #${issue.number}:\ntitle: ${issue.title}\n\n${issue.body}`;
    await ctx.provider.run({ persona: PERSONA, context, artifactDir: dir, model: ctx.model });
    let diff = await ctx.ws.stagedDiff(dir);

    if (!diff.trim()) {
      const fails = ctx.fails.recordFail(ctx.repo, issue.number);
      if (fails < PATCH_FAIL_THRESHOLD) {
        console.warn(`[monastery] patcher made no changes ${ctx.repo}#${issue.number} (${fails}/${PATCH_FAIL_THRESHOLD})`);
        return { kind: "noop" };
      }
      await ctx.gh.upsertPanel(ctx.repo, issue.number,
        `${PATCH_NOTE_MARKER}\n⚠️ patcher made no changes after ${fails} attempts — needs a human.`);
      return { kind: "noop" };
    }

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
        await ctx.gh.upsertPanel(ctx.repo, issue.number, reviewPanel(blocking));
        return { kind: "noop" };
      }
      await ctx.provider.run({ persona: FIX_PERSONA, context: fixContext(issue, blocking), artifactDir: dir, model: ctx.model });
      fixedTitles.push(...blocking.map((b) => b.title));
      tests = await ctx.ws.runTests(dir);
      diff = await ctx.ws.stagedDiff(dir);
    }

    await ctx.ws.commitPush(dir, branch, `fix: address #${issue.number}`);

    const MAX_DIFF = 60000;
    const shownDiff = diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + "\n… [diff truncated; see the PR Files tab]" : diff;
    const testLine = tests === null ? "no test suite detected" : tests ? "tests passing" : "⚠️ tests FAILING";
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
      `<details><summary>diff</summary>`,
      ``,
      "```diff",
      shownDiff,
      "```",
      `</details>`,
      ``,
      `— monastery (draft; review and merge if good).`,
    ].join("\n");
    const url = await ctx.gh.openDraftPR(ctx.repo, branch, `monastery: fix #${issue.number}`, body);
    return { kind: "progressed", note: url };
  } finally {
    await ctx.ws.cleanup(dir);
  }
}
