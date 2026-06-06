// src/github/dry-run.ts
import type { GitHubAdapter } from "./adapter.js";
import type { Issue } from "../types.js";

export interface IntendedAction {
  op: string;
  repo: string;
  args: Record<string, unknown>;
}

/** No-op wrapper: passes reads through to the inner adapter; records writes without executing them. */
export class DryRunAdapter implements GitHubAdapter {
  public readonly actions: IntendedAction[] = [];

  constructor(private inner: GitHubAdapter) {}

  // Read-only — pass through
  listOpenIssues(repo: string, sinceMs: number): Promise<Issue[]> {
    return this.inner.listOpenIssues(repo, sinceMs);
  }
  readThesis(repo: string): Promise<string> { return this.inner.readThesis(repo); }
  readPanel(repo: string, num: number): Promise<string> { return this.inner.readPanel(repo, num); }
  fileExists(repo: string, path: string): Promise<boolean> { return this.inner.fileExists(repo, path); }
  findPrForBranch(repo: string, branch: string): Promise<string | null> {
    return this.inner.findPrForBranch(repo, branch);
  }
  prState(repo: string, branch: string): Promise<"open" | "merged" | "closed" | null> {
    return this.inner.prState(repo, branch);
  }
  listComments(repo: string, num: number): Promise<{ id: string; body: string; author: string }[]> {
    return this.inner.listComments(repo, num);
  }
  reactions(repo: string, commentId: string): Promise<string[]> {
    return this.inner.reactions(repo, commentId);
  }
  labelEventTime(repo: string, num: number, label: string): Promise<number | null> {
    return this.inner.labelEventTime(repo, num, label);
  }

  // Writes — record only, no side effects
  async addLabel(repo: string, num: number, label: string): Promise<void> {
    this.actions.push({ op: "addLabel", repo, args: { num, label } });
  }
  async removeLabel(repo: string, num: number, label: string): Promise<void> {
    this.actions.push({ op: "removeLabel", repo, args: { num, label } });
  }
  async upsertPanel(repo: string, num: number, body: string): Promise<void> {
    this.actions.push({ op: "upsertPanel", repo, args: { num, bodyLength: body.length } });
  }
  async postComment(repo: string, num: number, body: string): Promise<void> {
    this.actions.push({ op: "postComment", repo, args: { num, bodyLength: body.length } });
  }
  async closeIssue(repo: string, num: number): Promise<void> {
    this.actions.push({ op: "closeIssue", repo, args: { num } });
  }
  async ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
    this.actions.push({ op: "ensureLabel", repo, args: { name, color, description } });
  }
  async createFile(repo: string, path: string, content: string, message: string): Promise<void> {
    this.actions.push({ op: "createFile", repo, args: { path, contentLength: content.length, message } });
  }
  async mergePR(repo: string, branch: string): Promise<void> {
    this.actions.push({ op: "mergePR", repo, args: { branch } });
  }
  async openDraftPR(repo: string, head: string, title: string, body: string): Promise<string> {
    this.actions.push({ op: "openDraftPR", repo, args: { head, title, bodyLength: body.length } });
    return `[dry-run] would open PR from ${head}`;
  }
}
