// src/github/adapter.ts
import type { Issue } from "../types.js";

/** The ONLY surface that writes to GitHub. M1 needs exactly these operations. */
export interface GitHubAdapter {
  listOpenIssues(repo: string, sinceMs: number): Promise<Issue[]>;
  /** Read one issue (any repo, open or closed) — used to read a cross-repo dependency's state. Null if absent. */
  getIssue(repo: string, num: number): Promise<Issue | null>;
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
  /** URL of an existing open PR whose head is `branch`, or null. */
  findPrForBranch(repo: string, branch: string): Promise<string | null>;
  /** State of the PR whose head is `branch`: open | merged | closed; null if none. */
  prState(repo: string, branch: string): Promise<"open" | "merged" | "closed" | null>;
  /** Full PR metadata for the PR whose head is `branch`: number, url, title, body, isDraft, baseRefName. Null if no PR. */
  getPrDetails(repo: string, branch: string): Promise<{ number: number; url: string; title: string; body: string; isDraft: boolean; baseRefName: string } | null>;
  /** Conversation comments on a PR (by PR number), oldest first. Same shape as listComments — author is login. */
  listPrComments(repo: string, prNumber: number): Promise<{ id: string; body: string; author: string }[]>;
  /** Reviews on a PR (by PR number): author, state (APPROVED / REQUEST_CHANGES / COMMENTED), body. */
  listPrReviews(repo: string, prNumber: number): Promise<{ author: string; state: string; body: string }[]>;
  /** Aggregate check status for a PR: all pass → "pass"; any fail → "fail"; else → "pending". */
  getPrChecks(repo: string, prNumber: number): Promise<"pass" | "fail" | "pending">;
  /** All comments on an issue/PR, oldest first. `author` is the commenter's login (identity, not marker).
   *  `updatedAt` is the comment's last-edit time (epoch ms), used to choose the newest approval gate. */
  listComments(repo: string, num: number): Promise<{ id: string; body: string; author: string; updatedAt: number }[]>;
  /** Reaction contents on a comment (`+1`/`-1` = approve/decline, PROTOCOL §4). */
  reactions(repo: string, commentId: string): Promise<{ content: string; author: string }[]>;
  /** The login this monastery instance acts as (its own identity) — used to attribute/dedup endorsements. */
  login(): Promise<string>;
  /** Merge the PR whose head is `branch` (a gated, human-approved action). */
  mergePR(repo: string, branch: string): Promise<void>;
  /** Millisecond timestamp of the most recent `labeled` event for `label`, or null if never labeled. */
  labelEventTime(repo: string, num: number, label: string): Promise<number | null>;
}
