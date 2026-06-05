// src/github/fake.ts
import type { GitHubAdapter } from "./adapter.js";
import type { Issue } from "../types.js";

/** In-memory GitHub for deterministic engine tests. */
export class FakeGitHub implements GitHubAdapter {
  private issues: Map<number, Issue> = new Map();
  public panels: Record<number, string> = {};
  public comments: Record<number, string[]> = {};
  public closed: number[] = [];
  constructor(private opts: { thesis: string; issues: Issue[] }) {
    for (const i of opts.issues) this.issues.set(i.number, { ...i, labels: [...i.labels] });
  }
  async listOpenIssues(_repo?: string, _sinceMs?: number): Promise<Issue[]> {
    return [...this.issues.values()].filter((i) => i.state === "open").map((i) => ({ ...i, labels: [...i.labels] }));
  }
  async addLabel(_r: string, n: number, label: string): Promise<void> {
    const i = this.must(n); if (!i.labels.includes(label)) i.labels.push(label);
  }
  async removeLabel(_r: string, n: number, label: string): Promise<void> {
    const i = this.must(n); i.labels = i.labels.filter((l) => l !== label);
  }
  async upsertPanel(_r: string, n: number, body: string): Promise<void> { this.panels[n] = body; }
  async postComment(_r: string, n: number, body: string): Promise<void> {
    (this.comments[n] ??= []).push(body);
  }
  async closeIssue(_r: string, n: number): Promise<void> { this.must(n).state = "closed"; this.closed.push(n); }
  async readThesis(): Promise<string> { return this.opts.thesis; }
  private must(n: number): Issue { const i = this.issues.get(n); if (!i) throw new Error(`no issue ${n}`); return i; }
}
