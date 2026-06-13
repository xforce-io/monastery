// src/engine/backlog.ts
import { createHash } from "node:crypto";
import type { Action } from "../shell/actions.js";
import type { AgentProvider } from "../provider/interface.js";
import type { GitHubAdapter } from "../github/adapter.js";
import { DECLINED, NEEDS_APPROVAL } from "../github/labels.js";
import { backlogTriage } from "../agents/backlog.js";
import type { BacklogEntry, BacklogSnapshot, Issue, Priority } from "../types.js";

/** Actions that mean "this issue is being advanced this tick" (short of handing it to the patcher). */
const ADVANCING: ReadonlySet<string> = new Set(["spec", "endorse", "propose", "panel", "openDraftPR"]);

const BUCKET: Record<Priority, number> = { now: 0, soon: 1, later: 2, parked: 3 };

/**
 * Legacy step-internal projection: derive an entry from maintainer actions.
 * #140 keeps this only for step's heavy-slot scheduling; it must not be persisted as `backlog.json`.
 */
export function deriveEntry(
  issue: { number: number; title: string },
  actions: Action[],
  blockedBy: string[],
  fails: number,
): BacklogEntry {
  const kinds = actions.map((a) => a.kind);
  let priority: Priority;
  let rationale: string;
  if (kinds.includes("implement") || kinds.includes("rework")) {
    priority = "now";
    rationale = kinds.includes("rework") ? "proposed rework → patcher (update PR)" : "proposed implement → patcher";
  } else if (kinds.some((k) => ADVANCING.has(k))) {
    priority = "soon";
    rationale = `advancing: ${kinds.join(", ")}`;
  } else if (kinds.length) {
    priority = "later";
    rationale = `light governance: ${kinds.join(", ")}`;
  } else {
    priority = "later";
    rationale = "no action this tick";
  }
  const entry: BacklogEntry = { number: issue.number, title: issue.title, priority, rationale };
  if (blockedBy.length) entry.blockedBy = blockedBy;
  if (fails > 0) entry.fails = fails;
  return entry;
}

/** Stable deterministic order: bucket, then not-blocked, then fewer fails, then lower number. */
export function sortEntries(entries: BacklogEntry[]): BacklogEntry[] {
  return [...entries].sort((a, b) =>
    BUCKET[a.priority] - BUCKET[b.priority]
    || (a.blockedBy?.length ?? 0) - (b.blockedBy?.length ?? 0)
    || (a.fails ?? 0) - (b.fails ?? 0)
    || a.number - b.number,
  );
}

export interface RefreshBacklogCtx {
  repo: string;
  gh: GitHubAdapter;
  provider: AgentProvider;
  model: string;
  artifactDir: string;
  now: () => number;
  language?: string;
}

export function backlogFingerprint(issues: Issue[]): string {
  const rows = triageIssues(issues).map((i) => ({
    number: i.number,
    state: i.state,
    updatedAt: i.updatedAt ?? 0,
    // Tests and non-GitHub adapters may not provide updatedAt. Include stable facts so freshness still works.
    title: i.updatedAt === undefined ? i.title : undefined,
    body: i.updatedAt === undefined ? i.body : undefined,
    labels: i.updatedAt === undefined ? [...i.labels].sort() : undefined,
  }));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function isBacklogFresh(snapshot: BacklogSnapshot | null, fingerprint: string): snapshot is BacklogSnapshot {
  return snapshot?.fingerprint === fingerprint;
}

export async function refreshBacklog(ctx: RefreshBacklogCtx, openIssues?: Issue[]): Promise<BacklogSnapshot> {
  const open = openIssues ?? await ctx.gh.listOpenIssues(ctx.repo, 0);
  const issues = triageIssues(open);
  const fingerprint = backlogFingerprint(open);
  const thesis = await ctx.gh.readThesis(ctx.repo);
  const output = await backlogTriage(ctx.provider, ctx.model, {
    repo: ctx.repo,
    thesis,
    issues,
    language: ctx.language,
  }, ctx.artifactDir);

  const entries = normalizeTriageEntries(issues, output?.entries ?? []);
  return {
    generatedAt: new Date(ctx.now()).toISOString(),
    repo: ctx.repo,
    fingerprint,
    rankedOf: { ranked: entries.length, open: issues.length },
    entries,
  };
}

function triageIssues(issues: Issue[]): Issue[] {
  return issues
    .filter((i) => i.state === "open" && !i.labels.includes(DECLINED))
    .sort((a, b) => a.number - b.number);
}

function normalizeTriageEntries(
  issues: Issue[],
  proposed: { number: number; priority: Priority; rationale: string; blockedBy?: string[] }[],
): BacklogEntry[] {
  const issueByNumber = new Map(issues.map((i) => [i.number, i]));
  const seen = new Set<number>();
  const entries: BacklogEntry[] = [];

  for (const p of proposed) {
    const issue = issueByNumber.get(p.number);
    if (!issue || seen.has(p.number)) continue;
    seen.add(p.number);
    entries.push(normalizeEntry(issue, p));
  }

  for (const issue of issues) {
    if (seen.has(issue.number)) continue;
    entries.push(normalizeEntry(issue, {
      number: issue.number,
      priority: issue.labels.includes(NEEDS_APPROVAL) ? "parked" : "later",
      rationale: issue.labels.includes(NEEDS_APPROVAL)
        ? "awaiting human approval"
        : "not ranked by triage output",
    }));
  }

  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => BUCKET[a.entry.priority] - BUCKET[b.entry.priority] || a.index - b.index)
    .map(({ entry }) => entry);
}

function normalizeEntry(
  issue: Issue,
  proposed: { priority: Priority; rationale: string; blockedBy?: string[] },
): BacklogEntry {
  const awaitingApproval = issue.labels.includes(NEEDS_APPROVAL);
  const entry: BacklogEntry = {
    number: issue.number,
    title: issue.title,
    priority: awaitingApproval ? "parked" : proposed.priority,
    rationale: awaitingApproval ? "awaiting human approval" : sanitizeRationale(proposed.rationale),
  };
  if (proposed.blockedBy?.length) entry.blockedBy = proposed.blockedBy;
  if (awaitingApproval) entry.awaitingApproval = true;
  return entry;
}

function sanitizeRationale(rationale: string): string {
  return /\b(implement|rework|patcher|executed|deferred)\b/i.test(rationale)
    ? "Prioritized from issue facts and current backlog context."
    : rationale;
}
