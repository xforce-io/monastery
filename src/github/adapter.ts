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
  readPanel(repo: string, num: number): Promise<string>;
  /** Create or update a label (idempotent). */
  ensureLabel(repo: string, name: string, color: string, description: string): Promise<void>;
  /** Does a file exist at this path on the repo's default branch? */
  fileExists(repo: string, path: string): Promise<boolean>;
  /** Create a file on the default branch (used to scaffold; caller checks fileExists first). */
  createFile(repo: string, path: string, content: string, message: string): Promise<void>;
  /** Open a draft PR from `head` to the default branch; returns the PR url. */
  openDraftPR(repo: string, head: string, title: string, body: string): Promise<string>;
}
