// src/workspace/git-workspace.ts
import { execa } from "execa";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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

  async runTests(dir: string): Promise<boolean | null> {
    if (!existsSync(join(dir, "package.json"))) return null;
    const ci = await this.run("npm", ["ci"], { cwd: dir });
    if (ci.exitCode !== 0) await this.run("npm", ["install"], { cwd: dir }); // no lockfile / out of sync
    const t = await this.run("npm", ["test"], { cwd: dir });
    return t.exitCode === 0;
  }

  async stagedDiff(dir: string): Promise<string> {
    await this.run("git", ["-C", dir, "add", "-A"]);
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
