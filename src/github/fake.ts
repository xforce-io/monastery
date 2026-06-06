// src/github/fake.ts
import type { GitHubAdapter } from "./adapter.js";
import type { Issue } from "../types.js";

/** In-memory GitHub for deterministic engine tests. */
export class FakeGitHub implements GitHubAdapter {
  private issues: Map<number, Issue> = new Map();
  public panels: Record<number, string> = {};
  public comments: Record<number, string[]> = {};
  public closed: number[] = [];
  public ensuredLabels: { name: string; color: string; description: string }[] = [];
  public files: Record<string, string> = {};
  public prs: { head: string; title: string; body: string }[] = [];
  /** Injected label-event times, keyed by `${num}:${label}` -> ms timestamp. */
  public labelTimes: Record<string, number> = {};
  /** Injected PR states, keyed by branch -> "open"|"merged"|"closed". */
  public prStates: Record<string, "open" | "merged" | "closed"> = {};
  constructor(private opts: { thesis: string; issues: Issue[]; files?: Record<string, string> }) {
    for (const i of opts.issues) this.issues.set(i.number, { ...i, labels: [...i.labels] });
    if (opts.files) this.files = { ...opts.files };
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
  async readPanel(_r: string, n: number): Promise<string> { return this.panels[n] ?? ""; }
  async ensureLabel(_r: string, name: string, color: string, description: string): Promise<void> {
    this.ensuredLabels.push({ name, color, description });
  }
  async fileExists(_r: string, path: string): Promise<boolean> {
    return path in this.files;
  }
  async createFile(_r: string, path: string, content: string, _message: string): Promise<void> {
    this.files[path] = content;
  }
  async openDraftPR(_r: string, head: string, title: string, body: string): Promise<string> {
    this.prs.push({ head, title, body });
    return `https://github.com/fake/pull/${this.prs.length}`;
  }
  async findPrForBranch(_r: string, branch: string): Promise<string | null> {
    const idx = this.prs.findIndex((p) => p.head === branch);
    return idx >= 0 ? `https://github.com/fake/pull/${idx + 1}` : null;
  }
  async prState(_r: string, branch: string): Promise<"open" | "merged" | "closed" | null> {
    return this.prStates[branch] ?? null;
  }
  async labelEventTime(_r: string, n: number, label: string): Promise<number | null> {
    return this.labelTimes[`${n}:${label}`] ?? null;
  }
  private must(n: number): Issue { const i = this.issues.get(n); if (!i) throw new Error(`no issue ${n}`); return i; }
}
