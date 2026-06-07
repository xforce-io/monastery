// src/shell/actions.ts
import { z } from "zod";
import type { GitHubAdapter } from "../github/adapter.js";
import { currentSpec, parseEndorsements, SPEC_MARKER, ENDORSE_MARKER } from "./consensus.js";

// Human-gated actions, reachable only via an approval comment + a human 👍 (PROTOCOL §4).
// `implement` joins close/merge (issue #88): the agent may PROPOSE a patch, but the patcher
// (runImplement) only runs after a real human endorses it — the agent can never self-approve.
export const GatedKindSchema = z.enum(["close", "merge", "implement"]);
export type GatedKind = z.infer<typeof GatedKindSchema>;

/**
 * The actions an agent may propose — the single source of truth (schema + type, no drift).
 * The agent NEVER proposes gated executors (doClose/doMerge): they are not in this union (constitution §3).
 * Gated risk (close/merge) is reachable only via `propose`, which a human then approves (§4).
 * Most kinds are cheap, idempotent GitHub writes run by executeSafe; `implement` is the exception —
 * the engine routes it to the shell-owned patcher executor (runImplement), never executeSafe.
 */
export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reply"), num: z.number(), toCommentId: z.string().min(1), body: z.string().min(1) }),
  z.object({ kind: z.literal("relabel"), num: z.number(), add: z.array(z.string()), remove: z.array(z.string()) }),
  z.object({ kind: z.literal("panel"), num: z.number(), body: z.string().min(1) }),
  z.object({ kind: z.literal("openDraftPR"), num: z.number(), branch: z.string().min(1), title: z.string().min(1), body: z.string() }),
  z.object({ kind: z.literal("propose"), num: z.number(), proposal: GatedKindSchema, draft: z.string().min(1) }),
  // implement: "this issue is worth fixing — produce a patch PR." The engine routes it to the shell-owned
  // patcher (runImplement): it writes code in a sandbox clone and opens a human-gated draft PR. The agent
  // still never touches git/gh (constitution §3); the only path to main is a human Merge (§4).
  z.object({ kind: z.literal("implement"), num: z.number(), draft: z.string().optional() }),
  // spec / endorse: the multi-party consensus core (#48). `spec` appends a versioned shared spec comment;
  // `endorse` records this party's agreement to a spec version. Consensus = all parties endorsed the
  // current version (src/shell/consensus.ts). Both are agent-level, reversible; the merge gate stays the floor.
  z.object({ kind: z.literal("spec"), num: z.number(), body: z.string().min(1), parties: z.array(z.string()) }),
  z.object({ kind: z.literal("endorse"), num: z.number(), version: z.number() }),
]);
export type Action = z.infer<typeof ActionSchema>;

/** A batch of proposed actions (the maintainer agent's output shape). */
export const ActionsSchema = z.object({ actions: z.array(ActionSchema) });

const NEEDS_APPROVAL = "monastery:needs-approval";
// Shell-owned control labels (PROTOCOL §2): the agent may NEVER set/clear these via relabel — they encode
// approval/terminal state, and faking them would bypass the human gate (issue #92).
const CONTROL_LABELS: ReadonlySet<string> = new Set([NEEDS_APPROVAL, "monastery:declined"]);
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
      // Display labels only — control labels are shell-owned (issue #92); silently skip them.
      for (const l of a.add) if (!CONTROL_LABELS.has(l)) await gh.addLabel(repo, a.num, l);
      for (const l of a.remove) if (!CONTROL_LABELS.has(l)) await gh.removeLabel(repo, a.num, l);
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
      await proposeGate(gh, repo, a.num, a.proposal, a.draft);
      return;
    case "spec": {
      // Append-only versioned shared spec: bump the version only when the body changed (idempotent).
      const cur = currentSpec(await gh.listComments(repo, a.num));
      if (cur && cur.body === a.body.trim()) return; // unchanged -> no new version
      const version = (cur?.version ?? 0) + 1;
      await gh.postComment(repo, a.num, `${SPEC_MARKER(version, a.parties)}\n${a.body}`);
      return;
    }
    case "endorse": {
      const self = await gh.login();
      const already = parseEndorsements(await gh.listComments(repo, a.num))
        .some((e) => e.version === a.version && e.by === self);
      if (already) return; // this party already endorsed this version
      await gh.postComment(repo, a.num, `Endorsed spec v${a.version}.\n\n${ENDORSE_MARKER(a.version)}`);
      return;
    }
    case "implement":
      // Not a cheap safe write — it needs the full StepCtx (provider/workspace/self-review). The engine
      // routes `implement` to runImplement; reaching it here is a wiring bug, so fail loudly.
      throw new Error("'implement' is a shell executor (runImplement), not an executeSafe action");
  }
}

/**
 * Open the approval gate (PROTOCOL §4): post a fresh approval comment carrying the action marker
 * (so old reactions on a reused sticky panel cannot approve a new gate) + the needs-approval control label
 * (so the item moves to awaiting-gate). Shared by `propose` (close/merge) and `implement` (#88).
 */
export async function proposeGate(gh: GitHubAdapter, repo: string, num: number, proposal: GatedKind, draft: string): Promise<void> {
  // Visible banner (issue #90): the approval marker is an HTML comment a human can't see, so without this
  // they can't tell which comment to 👍. This line is plain text — it shows up on the issue page.
  const banner = "⏳ **NEEDS YOUR APPROVAL** — 👍 this comment to approve · 👎 to decline";
  await gh.postComment(repo, num, `${approvalMarker(proposal)}\n${banner}\n\n${draft}`);
  await gh.addLabel(repo, num, NEEDS_APPROVAL);
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
