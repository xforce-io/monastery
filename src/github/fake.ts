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
  /** Injected reaction contents, keyed by commentId -> e.g. ["+1"]. */
  public commentReactions: Record<string, string[]> = {};
  /** Last-write time for posted comments, keyed by issue then zero-based comment index. */
  public commentUpdatedAt: Record<number, number[]> = {};
  /** Panel last-write time (monotonic counter), bumped by upsertPanel. */
  public panelUpdatedAt: Record<number, number> = {};
  private clock = 0;
  /** The login this fake "runs as" — author of its own posted comments/panels. */
  public selfLogin = "monastery";
  /** Comments authored by others (humans / peer bots), injected for identity tests, keyed by issue. */
  public authoredComments: Record<number, { body: string; author: string }[]> = {};
  /** External issues (other repos), injected for cross-repo read tests, keyed by `<owner>/<repo>#<num>`. */
  public externalIssues: Record<string, Issue> = {};
  /** Branches whose PR was merged via mergePR. */
  public merged: string[] = [];
  /** PR details (number, url, title, body, isDraft) by branch name, for tests. */
  public prDetailsByBranch: Record<string, { number: number; url: string; title: string; body: string; isDraft: boolean }> = {};
  /** PR conversation comments by PR number, for tests. */
  public prCommentsByPr: Record<number, { id: string; body: string; author: string }[]> = {};
  /** PR reviews by PR number, for tests. */
  public prReviewsByPr: Record<number, { author: string; state: string; body: string }[]> = {};
  /** PR check status by PR number, for tests. */
  public prChecksByPr: Record<number, "pass" | "fail" | "pending"> = {};
  constructor(private opts: { thesis: string; issues: Issue[]; files?: Record<string, string> }) {
    for (const i of opts.issues) this.issues.set(i.number, { ...i, labels: [...i.labels] });
    if (opts.files) this.files = { ...opts.files };
  }
  async listOpenIssues(_repo?: string, _sinceMs?: number): Promise<Issue[]> {
    return [...this.issues.values()].filter((i) => i.state === "open").map((i) => ({ ...i, labels: [...i.labels] }));
  }
  async getIssue(repo: string, n: number): Promise<Issue | null> {
    const ext = this.externalIssues[`${repo}#${n}`];
    if (ext) return { ...ext, labels: [...ext.labels] };
    const own = this.issues.get(n);
    return own ? { ...own, labels: [...own.labels] } : null;
  }
  async addLabel(_r: string, n: number, label: string): Promise<void> {
    const i = this.must(n); if (!i.labels.includes(label)) i.labels.push(label);
  }
  async removeLabel(_r: string, n: number, label: string): Promise<void> {
    const i = this.must(n); i.labels = i.labels.filter((l) => l !== label);
  }
  async upsertPanel(_r: string, n: number, body: string): Promise<void> { this.panels[n] = body; this.panelUpdatedAt[n] = ++this.clock; }
  async postComment(_r: string, n: number, body: string): Promise<void> {
    (this.comments[n] ??= []).push(body);
    (this.commentUpdatedAt[n] ??= []).push(++this.clock);
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
    this.prStates[head] ??= "open"; // keep prState consistent with an opened PR (don't clobber injected states)
    return `https://github.com/fake/pull/${this.prs.length}`;
  }
  async findPrForBranch(_r: string, branch: string): Promise<string | null> {
    const idx = this.prs.findIndex((p) => p.head === branch);
    return idx >= 0 ? `https://github.com/fake/pull/${idx + 1}` : null;
  }
  async prState(_r: string, branch: string): Promise<"open" | "merged" | "closed" | null> {
    return this.prStates[branch] ?? null;
  }
  async getPrDetails(_r: string, branch: string): Promise<{ number: number; url: string; title: string; body: string; isDraft: boolean } | null> {
    return this.prDetailsByBranch[branch] ?? null;
  }
  async listPrComments(_r: string, prNumber: number): Promise<{ id: string; body: string; author: string }[]> {
    return this.prCommentsByPr[prNumber] ?? [];
  }
  async listPrReviews(_r: string, prNumber: number): Promise<{ author: string; state: string; body: string }[]> {
    return this.prReviewsByPr[prNumber] ?? [];
  }
  async getPrChecks(_r: string, prNumber: number): Promise<"pass" | "fail" | "pending"> {
    return this.prChecksByPr[prNumber] ?? "pending";
  }
  async listComments(_r: string, n: number): Promise<{ id: string; body: string; author: string; updatedAt: number }[]> {
    // Others' comments first (chronological-ish), then monastery's own posts, then the sticky panel.
    const ext = (this.authoredComments[n] ?? []).map((c, i) => ({ id: `ext${i}`, body: c.body, author: c.author, updatedAt: 0 }));
    const own = (this.comments[n] ?? []).map((body, i) => ({ id: String(i), body, author: this.selfLogin, updatedAt: this.commentUpdatedAt[n]?.[i] ?? 0 }));
    const out = [...ext, ...own];
    // The sticky panel is a real marked comment on GitHub; surface it here (stable id) so readers
    // that scan marked comments see the same shape as the real adapter.
    if (this.panels[n] !== undefined) out.push({ id: `panel:${n}`, body: this.panels[n], author: this.selfLogin, updatedAt: this.panelUpdatedAt[n] ?? 0 });
    return out;
  }
  async reactions(_r: string, commentId: string): Promise<string[]> {
    return this.commentReactions[commentId] ?? [];
  }
  async login(): Promise<string> { return this.selfLogin; }
  async mergePR(_r: string, branch: string): Promise<void> {
    this.merged.push(branch);
  }
  async labelEventTime(_r: string, n: number, label: string): Promise<number | null> {
    return this.labelTimes[`${n}:${label}`] ?? null;
  }
  private must(n: number): Issue { const i = this.issues.get(n); if (!i) throw new Error(`no issue ${n}`); return i; }
}
