// tests/patch-branch.test.ts
import { expect, test } from "vitest";
import { branchName } from "../src/engine/patch.js";

test("branchName: basic title produces feat/{n}-{slug}", () => {
  expect(branchName(28, "fix patcher branch naming")).toBe("feat/28-fix-patcher-branch-naming");
});

test("branchName: uppercase and spaces are lowercased and kebab-ized", () => {
  expect(branchName(1, "Add New Feature")).toBe("feat/1-add-new-feature");
});

test("branchName: non-alphanumeric chars (punctuation, parens, slashes) collapse to single dash", () => {
  expect(branchName(5, "bug: foo/bar (crash) -- fix!")).toBe("feat/5-bug-foo-bar-crash-fix");
});

test("branchName: leading and trailing dashes are stripped from slug", () => {
  expect(branchName(7, "  spaces around  ")).toBe("feat/7-spaces-around");
});

test("branchName: slug is capped at 50 chars and trailing dash cleaned", () => {
  const longTitle = "a".repeat(60);
  const result = branchName(99, longTitle);
  const slug = result.replace("feat/99-", "");
  expect(slug.length).toBeLessThanOrEqual(50);
  expect(slug).not.toMatch(/-$/);
});

test("branchName: empty-after-kebab title falls back to feat/{n}", () => {
  expect(branchName(3, "---")).toBe("feat/3");
  expect(branchName(3, "   ")).toBe("feat/3");
});

test("branchName: numeric-only title preserved as slug", () => {
  expect(branchName(10, "123")).toBe("feat/10-123");
});
