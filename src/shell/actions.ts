// src/shell/actions.ts
import { z } from "zod";
import type { GitHubAdapter } from "../github/adapter.js";

export const GatedKindSchema = z.enum(["close", "merge"]);
export type GatedKind = z.infer<typeof GatedKindSchema>;

/**
 * The SAFE actions an agent may propose — the single source of truth (schema + type, no drift).
 * The agent NEVER proposes gated executors (doClose/doMerge): they are not in this union (constitution §3).
 * Gated risk (close/merge) is reachable only via `propose`, which a human then approves (§4).
 */
export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reply"), num: z.number(), toCommentId: z.string().min(1), body: z.string().min(1) }),
  z.object({ kind: z.literal("relabel"), num: z.number(), add: z.array(z.string()), remove: z.array(z.string()) }),
  z.object({ kind: z.literal("panel"), num: z.number(), body: z.string().min(1) }),
  z.object({ kind: z.literal("openDraftPR"), num: z.number(), branch: z.string().min(1), title: z.string().min(1), body: z.string() }),
  z.object({ kind: z.literal("propose"), num: z.number(), proposal: GatedKindSchema, draft: z.string().min(1) }),
]);
export type Action = z.infer<typeof ActionSchema>;

/** A batch of proposed actions (the maintainer agent's output shape). */
export const ActionsSchema = z.object({ actions: z.array(ActionSchema) });

const NEEDS_APPROVAL = "monastery:needs-approval";
const replyMarker = (toCommentId: string) => `<!--monastery-reply to=${toCommentId}-->`;
const approvalMarker = (proposal: GatedKind) => `<!--monastery-state\nprotocol: approval\naction: ${proposal}\n-->`;

/** Execute a SAFE action, idempotently (constitution §3, §6). */
export async function executeSafe(gh: GitHubAdapter, repo: string, a: Action): Promise<void> {
  switch (a.kind) {
    case "reply": {
      const marker = replyMarker(a.toCommentId);
      const existing = await gh.listComments(repo, a.num);
      if (existing.some((c) => c.body.includes(marker))) return; // already replied to this comment
      await gh.postComment(repo, a.num, `${a.body}\n\n${marker}`);
      return;
    }
    case "relabel":
      for (const l of a.add) await gh.addLabel(repo, a.num, l);
      for (const l of a.remove) await gh.removeLabel(repo, a.num, l);
      return;
    case "panel":
      // Carry the panel marker so upsertPanel finds its single sticky comment AND it's never mistaken
      // for a human comment (constitution §6, §7). The agent supplies content; the shell stamps the marker.
      await gh.upsertPanel(repo, a.num, `<!--monastery-state\nprotocol: note\n-->\n${a.body}`);
      return;
    case "openDraftPR":
      if (await gh.findPrForBranch(repo, a.branch)) return; // already open
      await gh.openDraftPR(repo, a.branch, a.title, a.body);
      return;
    case "propose":
      await gh.upsertPanel(repo, a.num, `${approvalMarker(a.proposal)}\n${a.draft}`);
      await gh.addLabel(repo, a.num, NEEDS_APPROVAL);
      return;
  }
}

/**
 * GATED executors — shell-only, triggered by a human signal (PR Merge / issue 👍).
 * NOT in the Action union: there is no code path for the agent to call these (constitution §3, §4).
 */
export async function doClose(gh: GitHubAdapter, repo: string, num: number, reason: string): Promise<void> {
  // Close FIRST: a closed issue leaves the worklist, so this can't re-run and double-post the reason.
  await gh.closeIssue(repo, num);
  await gh.postComment(repo, num, reason);
}

export async function doMerge(gh: GitHubAdapter, repo: string, branch: string): Promise<void> {
  if ((await gh.prState(repo, branch)) === "merged") return; // idempotent: already merged
  await gh.mergePR(repo, branch);
}
