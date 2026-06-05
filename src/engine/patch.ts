// src/engine/patch.ts
import type { StepCtx } from "./issue-step.js";
import type { Issue, Outcome } from "../types.js";
import { TRY_FIX, PATCH_PROPOSED, NEEDS_HUMAN } from "../github/labels.js";

const PATCH_FAIL_THRESHOLD = 3;

const PERSONA = [
  "You are monastery's patcher.",
  "Fix the described GitHub issue by editing files in this repository, then run the test suite.",
  "Do NOT touch git or gh — leave your changes in the working tree.",
  "Make the smallest correct change.",
].join(" ");

export async function runPatch(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const branch = `monastery/fix-${issue.number}`;

  // Converge: a prior run may have pushed/opened a PR but failed before labeling. Don't redo the work.
  const existingPr = await ctx.gh.findPrForBranch(ctx.repo, branch);
  if (existingPr) {
    await ctx.gh.addLabel(ctx.repo, issue.number, PATCH_PROPOSED);
    await ctx.gh.removeLabel(ctx.repo, issue.number, TRY_FIX);
    return { kind: "progressed", note: existingPr };
  }

  const dir = await ctx.ws.clone(ctx.repo, branch);
  try {
    const context = `Fix issue #${issue.number}:\ntitle: ${issue.title}\n\n${issue.body}`;
    await ctx.provider.run({ persona: PERSONA, context, artifactDir: dir, model: ctx.model });
    const diff = await ctx.ws.stagedDiff(dir);

    if (!diff.trim()) {
      const fails = ctx.fails.recordFail(ctx.repo, issue.number);
      if (fails < PATCH_FAIL_THRESHOLD) {
        console.warn(`[monastery] patcher made no changes ${ctx.repo}#${issue.number} (${fails}/${PATCH_FAIL_THRESHOLD})`);
        return { kind: "noop" };
      }
      await ctx.gh.addLabel(ctx.repo, issue.number, NEEDS_HUMAN);
      await ctx.gh.upsertPanel(ctx.repo, issue.number,
        `<!--monastery-state\nprotocol: patch\n-->\n⚠️ patcher made no changes after ${fails} attempts — needs a human.`);
      return { kind: "noop" };
    }

    ctx.fails.clearFail(ctx.repo, issue.number);
    const tests = await ctx.ws.runTests(dir);
    await ctx.ws.commitPush(dir, branch, `fix: address #${issue.number}`);

    const MAX_DIFF = 60000;
    const shownDiff = diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + "\n… [diff truncated; see the PR Files tab]" : diff;
    const testLine = tests === null ? "no test suite detected" : tests ? "tests passing" : "⚠️ tests FAILING";
    const body = [
      `Proposed fix for #${issue.number} (${testLine}).`,
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
    await ctx.gh.addLabel(ctx.repo, issue.number, PATCH_PROPOSED);
    await ctx.gh.removeLabel(ctx.repo, issue.number, TRY_FIX);
    return { kind: "progressed", note: url };
  } finally {
    await ctx.ws.cleanup(dir);
  }
}
