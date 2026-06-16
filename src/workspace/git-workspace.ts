// src/workspace/git-workspace.ts
import { execa } from "execa";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";

export interface RunResult { stdout: string; exitCode: number }
export type Runner = (file: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>;

const defaultRun: Runner = async (file, args, opts) => {
  const r = await execa(file, args, { cwd: opts?.cwd, reject: false });
  return { stdout: r.stdout, exitCode: r.exitCode ?? 0 };
};

/** Provider scratch files written into the cwd; never commit these. */
const SCRATCH = ["_prompt.md", "_claude_stdout.json", "_codex_stdout.jsonl", "_codex_last_message.txt"];

// #169: a test file is identified by a *.test.* / *.spec.* basename or a /__tests__/ path segment.
function isTestPath(path: string): boolean {
  return /\.(test|spec)\.[^/]+$/.test(path) || /\/__tests__\//.test(path);
}

// #167: extract test file paths from a unified diff ("+++ b/<file>" lines whose basename matches test patterns).
function extractPatchTestFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m && isTestPath(m[1])) files.push(m[1]);
  }
  return files;
}

// #169: a deterministic, language-agnostic summary of a unified diff. The patcher's prose author summary could
// be off-language or contradict the diff (monastery#168); rendering the PR body's "Changes" section from THIS
// instead makes the body's first signal a fact derived from the diff, not the agent's self-report.
export interface DiffFileSummary { path: string; status: "A" | "M" | "D" | "R"; added: number; deleted: number; isTest: boolean }
export interface DiffSummary { files: DiffFileSummary[]; filesChanged: number; added: number; deleted: number; testFiles: number }

export function summarizeDiff(diff: string): DiffSummary {
  const files: DiffFileSummary[] = [];
  let cur: DiffFileSummary | null = null;
  for (const line of diff.split("\n")) {
    const head = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (head) {                                              // new file block; the b/ path is the post-change name
      cur = { path: head[2], status: "M", added: 0, deleted: 0, isTest: isTestPath(head[2]) };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.status = "A";
    else if (line.startsWith("deleted file mode")) cur.status = "D";
    else if (line.startsWith("rename to ")) cur.status = "R";
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) continue; // ---/+++ file headers, not content
    else if (line.startsWith("+")) cur.added++;
    else if (line.startsWith("-")) cur.deleted++;
  }
  return {
    files,
    filesChanged: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0),
    testFiles: files.filter((f) => f.isTest).length,
  };
}

// #167: detect vitest or jest from package.json content; null if undetectable (skip explicit re-run).
function detectJsTestRunner(packageJson: string): "vitest" | "jest" | null {
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(packageJson); } catch { return null; }
  const deps = { ...(pkg.dependencies as Record<string, unknown> ?? {}), ...(pkg.devDependencies as Record<string, unknown> ?? {}) };
  if ("vitest" in deps) return "vitest";
  if ("jest" in deps) return "jest";
  return null;
}

export class GitWorkspace implements Workspace {
  constructor(private run: Runner = defaultRun) {}

  async clone(repo: string, branch: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "monastery-wt-"));
    await this.run("gh", ["repo", "clone", repo, dir]);
    await this.run("git", ["-C", dir, "checkout", "-b", branch]);
    // keep the agent's scratch files and test-run node_modules out of the commit
    try { appendFileSync(join(dir, ".git", "info", "exclude"), "\n" + [...SCRATCH, "node_modules/"].join("\n") + "\n"); } catch { /* best effort */ }
    return dir;
  }

  // #79: check out an EXISTING remote branch (no `-b`) — for reworking an open draft PR in place.
  async checkout(repo: string, branch: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "monastery-wt-"));
    await this.run("gh", ["repo", "clone", repo, dir]);
    const co = await this.run("git", ["-C", dir, "checkout", branch]);
    if (co.exitCode !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`git checkout ${branch} failed (exit ${co.exitCode}): ${co.stdout}`);
    }
    try { appendFileSync(join(dir, ".git", "info", "exclude"), "\n" + [...SCRATCH, "node_modules/"].join("\n") + "\n"); } catch { /* best effort */ }
    return dir;
  }

  // Shallow checkout for code-reading agents (the maintainer): --depth 1, no branch. The shell never
  // commits this dir, so it stays read-only by convention — the agent may read any file but its edits are inert.
  async cloneReadOnly(repo: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "monastery-ro-"));
    const r = await this.run("gh", ["repo", "clone", repo, dir, "--", "--depth", "1"]);
    if (r.exitCode !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`gh repo clone (read-only) failed (exit ${r.exitCode}): ${r.stdout}`);
    }
    return dir;
  }

  async runTests(dir: string, patchDiff?: string): Promise<boolean | null> {
    if (existsSync(join(dir, "package.json"))) {
      const ci = await this.run("npm", ["ci"], { cwd: dir });
      if (ci.exitCode !== 0) await this.run("npm", ["install"], { cwd: dir }); // no lockfile / out of sync
      const t = await this.run("npm", ["test"], { cwd: dir });
      if (t.exitCode !== 0) return false;
      // #167: explicitly re-run patch test files that may not be covered by the repo's narrow npm test subset.
      // This prevents the gate from giving a false green when the patcher writes tests outside the default suite.
      if (patchDiff) {
        const patchTestFiles = extractPatchTestFiles(patchDiff);
        if (patchTestFiles.length > 0) {
          const runner = detectJsTestRunner(readFileSync(join(dir, "package.json"), "utf8"));
          if (runner === "vitest") {
            const r = await this.run("npx", ["vitest", "run", ...patchTestFiles], { cwd: dir });
            if (r.exitCode !== 0) return false;
          } else if (runner === "jest") {
            const r = await this.run("npx", ["jest", ...patchTestFiles], { cwd: dir });
            if (r.exitCode !== 0) return false;
          }
        }
      }
      return true;
    }
    if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "setup.py"))) {
      const r = await this.run("python", ["-m", "pytest"], { cwd: dir });
      if (r.exitCode !== 0) {
        const fallback = await this.run("pytest", [], { cwd: dir });
        return fallback.exitCode === 0;
      }
      return true;
    }
    if (existsSync(join(dir, "go.mod"))) {
      const r = await this.run("go", ["test", "./..."], { cwd: dir });
      return r.exitCode === 0;
    }
    if (existsSync(join(dir, "Cargo.toml"))) {
      const r = await this.run("cargo", ["test"], { cwd: dir });
      return r.exitCode === 0;
    }
    const makefile = join(dir, "Makefile");
    if (existsSync(makefile)) {
      const content = readFileSync(makefile, "utf8");
      if (/^test[ \t]*:/m.test(content)) {
        const r = await this.run("make", ["test"], { cwd: dir });
        return r.exitCode === 0;
      }
    }
    return null;
  }

  async stagedDiff(dir: string, baseRef?: string): Promise<string> {
    await this.run("git", ["-C", dir, "add", "-A"]);
    // #163: with a baseRef, diff the index against merge-base(baseRef, HEAD) — the cumulative PR diff a human
    // sees on GitHub — so the rework reviewer is not blind to work already committed on the branch tip. Without
    // a baseRef (implement path: HEAD = base), `git diff --cached` (vs HEAD) is already the full diff, unchanged.
    if (baseRef) {
      const mb = await this.run("git", ["-C", dir, "merge-base", baseRef, "HEAD"]);
      const base = mb.stdout.trim();
      if (base) {
        const d = await this.run("git", ["-C", dir, "diff", "--cached", base]);
        return d.stdout;
      }
      // merge-base unresolved (e.g. unrelated histories) — fall back to vs HEAD rather than crash the rework.
    }
    const d = await this.run("git", ["-C", dir, "diff", "--cached"]);
    return d.stdout;
  }

  async commitPush(dir: string, branch: string, message: string): Promise<void> {
    const commit = await this.run("git", [
      "-C", dir,
      "-c", "user.name=monastery",
      "-c", "user.email=monastery@users.noreply.github.com",
      "commit", "-m", message,
    ]);
    if (commit.exitCode !== 0) throw new Error(`git commit failed (exit ${commit.exitCode}): ${commit.stdout}`);
    const push = await this.run("git", ["-C", dir, "push", "-u", "origin", branch, "--force"]);
    if (push.exitCode !== 0) throw new Error(`git push failed (exit ${push.exitCode}): ${push.stdout}`);
  }

  async cleanup(dir: string): Promise<void> { rmSync(dir, { recursive: true, force: true }); }
}
