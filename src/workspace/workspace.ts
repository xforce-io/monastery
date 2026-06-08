// src/workspace/workspace.ts
export interface Workspace {
  /** Clone `repo` into a fresh temp dir and create+checkout `branch` off the default branch. Returns the dir. */
  clone(repo: string, branch: string): Promise<string>;
  /** Shallow read-only checkout of `repo` (no branch). For code-reading agents that never write/commit. Returns the dir. */
  cloneReadOnly(repo: string): Promise<string>;
  /** Run the repo's test suite if detectable (npm). true=pass, false=fail, null=no suite detected. */
  runTests(dir: string): Promise<boolean | null>;
  /** Stage all changes (git add -A) and return the unified diff; "" if nothing changed. */
  stagedDiff(dir: string): Promise<string>;
  /** Commit the staged changes and push `branch` to origin. */
  commitPush(dir: string, branch: string, message: string): Promise<void>;
  /** Remove the temp dir. */
  cleanup(dir: string): Promise<void>;
}
