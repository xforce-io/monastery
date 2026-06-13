// src/shell/actions.ts
import { z } from "zod";
import type { GitHubAdapter } from "../github/adapter.js";
import { LABEL_DEFS, NEEDS_APPROVAL } from "../github/labels.js";
import { currentSpec, parseEndorsements, SPEC_MARKER, ENDORSE_MARKER } from "./consensus.js";
import { renderStateMessage, deriveState, type StateStatus } from "./messages.js";

// Human-gated actions, reachable only via an approval comment + a human 👍 (PROTOCOL §4).
// `implement` joins close/merge (issue #88): the agent may PROPOSE a patch, but the patcher
// (runImplement) only runs after a real human endorses it — the agent can never self-approve.
export const GatedKindSchema = z.enum(["close", "merge", "implement", "rework"]);
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
  // rework (#79): "the open draft PR for this issue needs changes per human feedback." Like implement it is
  // human-gated and routed to a shell executor (runRework): it checks out the EXISTING branch, re-patches from
  // the feedback, and updates the SAME PR — never opens a new one. The agent still never touches git/gh (§3).
  z.object({ kind: z.literal("rework"), num: z.number(), draft: z.string().optional() }),
  // spec / endorse: the multi-party consensus core (#48). `spec` appends a versioned shared spec comment;
  // `endorse` records this party's agreement to a spec version. Consensus = all parties endorsed the
  // current version (src/shell/consensus.ts). Both are agent-level, reversible; the merge gate stays the floor.
  z.object({
    kind: z.literal("spec"), num: z.number(),
    // #100: every consumer (currentSpec, the maintainer's context, consensusReached, the patcher) reads ONLY
    // the highest-version comment as the spec — never concatenated. So each version must be a complete,
    // self-contained design that supersedes prior ones; a delta would silently drop its own base.
    body: z.string().min(1).describe(
      "完整、自包含的设计文档:每个版本取代旧版,必须能脱离历史版本独立成立(全量,非增量 diff)。",
    ),
    parties: z.array(z.string()),
  }),
  z.object({ kind: z.literal("endorse"), num: z.number(), version: z.number() }),
]);
export type Action = z.infer<typeof ActionSchema>;

export interface ActionProvenance {
  agent?: string;
  model?: string;
}

/** A batch of proposed actions (the maintainer agent's output shape). */
export const ActionsSchema = z.object({ actions: z.array(ActionSchema) });

// Shell-owned control labels (PROTOCOL §2): the agent may NEVER set/clear these via relabel — they encode
// approval/terminal state, and faking them would bypass the human gate (issue #92).
const CONTROL_LABELS: ReadonlySet<string> = new Set([NEEDS_APPROVAL, "monastery:declined"]);
const replyMarker = (toCommentId: string) => `<!--monastery-reply to=${toCommentId}-->`;
/** Execute a SAFE action, idempotently (constitution §3, §6). */
export async function executeSafe(gh: GitHubAdapter, repo: string, a: Action, provenance: ActionProvenance = {}): Promise<void> {
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
      await gh.upsertPanel(repo, a.num, renderStateMessage({ status: "note", body: a.body, ...provenance }));
      return;
    case "openDraftPR":
      if (await gh.findPrForBranch(repo, a.branch)) return; // already open
      await gh.openDraftPR(repo, a.branch, a.title, a.body);
      return;
    case "propose":
      await proposeGate(gh, repo, a.num, a.proposal, a.draft, provenance);
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
    case "rework":
      // #79: like implement, a shell executor (runRework) — needs StepCtx. Routed by the engine, never here.
      throw new Error("'rework' is a shell executor (runRework), not an executeSafe action");
  }
}

/**
 * Open the approval gate (PROTOCOL §4): post a fresh approval comment carrying the action marker
 * (so old reactions on a reused sticky panel cannot approve a new gate) + the needs-approval control label
 * (so the item moves to awaiting-gate). Shared by `propose` (close/merge) and `implement` (#88).
 */
export async function proposeGate(gh: GitHubAdapter, repo: string, num: number, proposal: GatedKind, draft: string, provenance: ActionProvenance = {}): Promise<void> {
  // Stamp the spec version this gate is opened against (#95) — a later, higher-version spec makes it stale.
  const specVersion = currentSpec(await gh.listComments(repo, num))?.version ?? 0;
  await applyStateLabels(gh, repo, num, "awaiting-approval");
  await gh.postComment(repo, num, renderStateMessage({ status: "awaiting-approval", action: proposal, spec: specVersion, body: draft, ...provenance }));
}

export async function ensureControlLabel(gh: GitHubAdapter, repo: string, name: string): Promise<void> {
  const def = LABEL_DEFS.find((l) => l.name === name);
  if (!def) throw new Error(`unknown control label: ${name}`);
  await gh.ensureLabel(repo, def.name, def.color, def.description);
}

/** #144 A3: apply the control-label op implied by a state — the label NAME comes from deriveState,
 * never hand-picked, so head/label/block can't drift. Idempotent. */
export async function applyStateLabels(gh: GitHubAdapter, repo: string, num: number, status: StateStatus): Promise<void> {
  const { labels } = deriveState(status);
  if (labels.add) { await ensureControlLabel(gh, repo, labels.add); await gh.addLabel(repo, num, labels.add); }
  if (labels.remove) await gh.removeLabel(repo, num, labels.remove);
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
