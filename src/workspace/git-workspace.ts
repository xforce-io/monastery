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
const SCRATCH = ["_prompt.md", "_claude_stdout.json"];

export class GitWorkspace implements Workspace {
  constructor(private run: Runner = defaultRun) {}

  async clone(repo: string, branch: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "monastery-wt-"));
    await this.run("gh", ["repo", "clone", repo, dir]);
    await this.run("git", ["-C", dir, "checkout", "-b", branch]);
    // keep the agent's scratch files out of the commit
    try { appendFileSync(join(dir, ".git", "info", "exclude"), "\n" + SCRATCH.join("\n") + "\n"); } catch { /* best effort */ }
    return dir;
  }

  async runTests(dir: string): Promise<boolean | null> {
    if (!existsSync(join(dir, "package.json"))) return null;
    await this.run("npm", ["ci"], { cwd: dir });
    const t = await this.run("npm", ["test"], { cwd: dir });
    return t.exitCode === 0;
  }

  async stagedDiff(dir: string): Promise<string> {
    await this.run("git", ["-C", dir, "add", "-A"]);
    const d = await this.run("git", ["-C", dir, "diff", "--cached"]);
    return d.stdout;
  }

  async commitPush(dir: string, branch: string, message: string): Promise<void> {
    await this.run("git", ["-C", dir, "commit", "-m", message]);
    await this.run("git", ["-C", dir, "push", "-u", "origin", branch]);
  }

  async cleanup(dir: string): Promise<void> { rmSync(dir, { recursive: true, force: true }); }
}
