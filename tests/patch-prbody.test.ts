// tests/patch-prbody.test.ts — #169: the PR body's first signal is a DETERMINISTIC "Changes" section rendered
// from the real diff (files / line counts / which tests), so it can never drift off-language or contradict the
// diff the way the patcher's prose author summary did (monastery#168). The prose is demoted to a supplementary
// author note that is OMITTED when it's off the repo's outward-text language.
import { expect, test } from "vitest";
import { prBody } from "../src/engine/patch.js";
import type { Issue } from "../src/types.js";

const issue: Issue = { number: 167, title: "fix the gate", body: "", labels: [], state: "open" };

// a modified source file (+1 −1) and a newly ADDED test file (+2) — mirrors the monastery#168 shape.
const diff = [
  "diff --git a/src/engine/patch.ts b/src/engine/patch.ts",
  "--- a/src/engine/patch.ts",
  "+++ b/src/engine/patch.ts",
  "@@ -1,3 +1,3 @@",
  " context",
  "-old line",
  "+new line",
  "diff --git a/tests/git-workspace.test.ts b/tests/git-workspace.test.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/tests/git-workspace.test.ts",
  "@@ -0,0 +1,2 @@",
  "+test a",
  "+test b",
  "",
].join("\n");

const base = { diff, tests: true as boolean | null, reviewerFailed: false, fixedTitles: [] as string[], lastVerdict: null };

test("PR body renders a deterministic Changes section from the diff (files, line counts, test flag)", () => {
  const body = prBody(issue, { ...base, authorSummary: "Fixes the quality-gate blind spot." }, "en-US");
  expect(body).toContain("## Changes");
  expect(body).toMatch(/src\/engine\/patch\.ts.*\+1/);          // modified source file with its added count
  expect(body).toMatch(/tests\/git-workspace\.test\.ts.*\+2/);  // added test file with its added count
  expect(body).toContain("[test]");                              // the test file is flagged
  expect(body).toMatch(/tests: 1 file/);                         // summary line counts the test file
  // on-language prose is kept as a supplementary author note.
  expect(body).toContain("Fixes the quality-gate blind spot.");
});

test("off-language author summary is OMITTED while the deterministic Changes section stays (#169)", () => {
  const korean =
    "이 변경은 품질 게이트의 사각지대를 수정합니다. 좁은 테스트 하위 집합에서 패처가 새로 작성한 " +
    "테스트가 실행되지 않아 게이트가 거짓 통과를 반환하는 문제를 해결합니다. 이제 패치에 포함된 " +
    "테스트 파일은 감지된 러너로 명시적으로 다시 실행되므로 거짓 통과가 사라집니다.";
  const body = prBody(issue, { ...base, authorSummary: korean }, "en-US");
  expect(body).not.toContain(korean);                            // off-language prose must NOT reach the body
  expect(body).toContain("src/engine/patch.ts");                 // but the deterministic facts remain
  expect(body).toMatch(/tests: 1 file/);
});

test("empty author summary yields no author-note section, Changes still present", () => {
  const body = prBody(issue, { ...base, authorSummary: "" }, "en-US");
  expect(body).toContain("## Changes");
  expect(body).toContain("tests/git-workspace.test.ts");
});
