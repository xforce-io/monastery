// src/github/adapter.ts
import type { Issue } from "../types.js";

/** The ONLY surface that writes to GitHub. M1 needs exactly these operations. */
export interface GitHubAdapter {
  listOpenIssues(repo: string, sinceMs: number): Promise<Issue[]>;
  addLabel(repo: string, num: number, label: string): Promise<void>;
  removeLabel(repo: string, num: number, label: string): Promise<void>;
  /** Find-or-create monastery's single sticky panel comment; edit in place. */
  upsertPanel(repo: string, num: number, body: string): Promise<void>;
  /** An official, outward comment (gated action). */
  postComment(repo: string, num: number, body: string): Promise<void>;
  closeIssue(repo: string, num: number): Promise<void>;
  readThesis(repo: string): Promise<string>;
}
