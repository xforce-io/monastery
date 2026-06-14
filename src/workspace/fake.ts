// src/workspace/fake.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "./workspace.js";

/** Test double: clone() makes a real empty temp dir (so a FakeProvider can write into it),
 *  but stagedDiff()/runTests() are driven by preset opts (the agent's edits are irrelevant here). */
export class FakeWorkspace implements Workspace {
  public cloned: { repo: string; branch: string; dir: string }[] = [];
  public checkedOut: { repo: string; branch: string; dir: string }[] = [];
  public clonedReadOnly: { repo: string; dir: string }[] = [];
  public committed: { branch: string; message: string }[] = [];
  public cleaned: string[] = [];
  public diffCalls = 0;
  /** #163: the base ref handed to each stagedDiff call (undefined = vs HEAD), so tests can assert which base the reviewer saw. */
  public diffBases: (string | undefined)[] = [];
  // #163: `diff` may be a function of the base ref, so a test can model "the cumulative diff is only visible WITH a base".
  constructor(private opts: { diff?: string | ((baseRef?: string) => string); tests?: boolean | null } = {}) {}
  async clone(repo: string, branch: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "fake-wt-"));
    this.cloned.push({ repo, branch, dir });
    return dir;
  }
  async checkout(repo: string, branch: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "fake-co-"));
    this.checkedOut.push({ repo, branch, dir });
    return dir;
  }
  async cloneReadOnly(repo: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "fake-ro-"));
    this.clonedReadOnly.push({ repo, dir });
    return dir;
  }
  async runTests(_dir?: string): Promise<boolean | null> { return this.opts.tests ?? null; }
  async stagedDiff(_dir: string, baseRef?: string): Promise<string> {
    this.diffCalls++;
    this.diffBases.push(baseRef);
    return typeof this.opts.diff === "function" ? this.opts.diff(baseRef) : this.opts.diff ?? "";
  }
  async commitPush(_dir: string, branch: string, message: string): Promise<void> {
    this.committed.push({ branch, message });
  }
  async cleanup(dir: string): Promise<void> { this.cleaned.push(dir); rmSync(dir, { recursive: true, force: true }); }
}
