// src/workspace/fake.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";

/** Test double: clone() makes a real empty temp dir (so a FakeProvider can write into it),
 *  but stagedDiff()/runTests() are driven by preset opts (the agent's edits are irrelevant here). */
export class FakeWorkspace implements Workspace {
  public cloned: { repo: string; branch: string; dir: string }[] = [];
  public committed: { branch: string; message: string }[] = [];
  public cleaned: string[] = [];
  public diffCalls = 0;
  constructor(private opts: { diff?: string; tests?: boolean | null } = {}) {}
  async clone(repo: string, branch: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "fake-wt-"));
    this.cloned.push({ repo, branch, dir });
    return dir;
  }
  async runTests(_dir?: string): Promise<boolean | null> { return this.opts.tests ?? null; }
  async stagedDiff(_dir?: string): Promise<string> { this.diffCalls++; return this.opts.diff ?? ""; }
  async commitPush(_dir: string, branch: string, message: string): Promise<void> {
    this.committed.push({ branch, message });
  }
  async cleanup(dir: string): Promise<void> { this.cleaned.push(dir); rmSync(dir, { recursive: true, force: true }); }
}
