// src/workspace/workspace.ts
export interface Workspace {
  /** Clone `repo` into a fresh temp dir and create+checkout `branch` off the default branch. Returns the dir. */
  clone(repo: string, branch: string): Promise<string>;
  /** Clone `repo` and check out an EXISTING remote `branch` (no `-b`). For reworking an open draft PR (#79). Returns the dir. */
  checkout(repo: string, branch: string): Promise<string>;
  /** Shallow read-only checkout of `repo` (no branch). For code-reading agents that never write/commit. Returns the dir. */
  cloneReadOnly(repo: string): Promise<string>;
  /**
   * Run the repo's test suite if detectable. true=pass, false=fail, null=no suite detected.
   * #167: if `patchDiff` is provided (unified diff of the patch), any test files added/modified by
   * the patch that fall outside the repo's default test command are explicitly re-run so the gate
   * cannot give a false green when `npm test` covers only a narrow subset of the repo.
   */
  runTests(dir: string, patchDiff?: string): Promise<boolean | null>;
  /**
   * Stage all changes (git add -A) and return the unified diff; "" if nothing changed.
   * #163: with `baseRef` (e.g. "origin/main") the diff is taken against `merge-base(baseRef, HEAD)` — the
   * cumulative PR diff a human sees on GitHub — instead of vs HEAD. rework passes the PR base; implement omits
   * it (HEAD = the base, so vs-HEAD is already the full diff). Without `baseRef` the legacy vs-HEAD behavior holds.
   */
  stagedDiff(dir: string, baseRef?: string): Promise<string>;
  /** Commit the staged changes and push `branch` to origin. */
  commitPush(dir: string, branch: string, message: string): Promise<void>;
  /** Remove the temp dir. */
  cleanup(dir: string): Promise<void>;
}
