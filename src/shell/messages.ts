import { z } from "zod";
import { NEEDS_APPROVAL, NEEDS_HUMAN } from "../github/labels.js";

export const STATE_MARKER = "<!--monastery-state";

/**
 * #154: the closed set of human-gated actions, owned here as the SINGLE source so the class-A envelope
 * schema and `actions.ts`'s `GatedKindSchema` derive from one list (no drift). `actions.ts` builds its zod
 * enum FROM this tuple; messages.ts owns it to keep the schema-parse self-contained (no value cycle).
 */
export const GATED_KINDS = ["close", "merge", "implement", "rework", "decline"] as const;
export type GatedKind = (typeof GATED_KINDS)[number];

export type StateMessageKind = "note" | "approval";

/** The closed set of states a class-A machine message can be in (#144 A3). */
export const STATE_STATUSES = ["awaiting-approval", "blocked", "done", "note"] as const;
export type StateStatus = (typeof STATE_STATUSES)[number];

/**
 * #155: the SINGLE source for the status glyph (⏳/✅/⚠️), keyed by the #144 `StateStatus` closed set. Both
 * class-A heads (`deriveState`) and the cosmetic backlog/reconcile views consume this — so no surface
 * hand-writes a glyph literal. `note` carries no glyph (a plain note has no status badge).
 */
export const STATUS_GLYPH: Record<StateStatus, string> = {
  "awaiting-approval": "⏳",
  blocked: "⚠️",
  done: "✅",
  note: "",
};

/**
 * #90 approval banner — the `awaiting-approval` visible head, prepended by deriveState (never hand-written
 * at call sites). Exported so the one consumer that strips it back out (issue-step `stripMarkers`) stays in
 * sync with this canonical text instead of re-encoding it. The glyph comes from STATUS_GLYPH (#155).
 */
export const AWAITING_APPROVAL_BANNER =
  `${STATUS_GLYPH["awaiting-approval"]} **NEEDS YOUR APPROVAL** — 👍 this comment to approve · 👎 to decline · 👀 to send back for revision`;

/**
 * #144 A3: the SINGLE source from which a class-A message's visible head, machine-block `kind`, and
 * control-label op are all derived — so they can never drift apart. `head` is a generic prefix; the
 * caller's `body` still carries the specifics.
 */
export function deriveState(status: StateStatus): {
  head: string;
  kind: StateMessageKind;
  labels: { add?: string; remove?: string };
} {
  switch (status) {
    case "awaiting-approval":
      return { head: AWAITING_APPROVAL_BANNER, kind: "approval", labels: { add: NEEDS_APPROVAL } };
    case "blocked":
      return { head: `${STATUS_GLYPH.blocked} **需要人工介入 / needs a human**`, kind: "note", labels: { add: NEEDS_HUMAN } };
    case "done":
      return { head: `${STATUS_GLYPH.done} **已完成 / done**`, kind: "note", labels: { remove: NEEDS_APPROVAL } };
    case "note":
      return { head: "", kind: "note", labels: {} };
  }
}

export interface StateMessage {
  kind: StateMessageKind;
  body: string;
  action?: GatedKind;
  spec?: number;
  agent?: string;
  model?: string;
  /** #152: which provider the emitting role actually ran on (e.g. "claude"/"codex") — pairs with agent/model. */
  provider?: string;
  /** #153: stable idempotency key derived from the message's logical identity (deriveCorrelationId).
   * Carried IN the envelope so a re-run can recognize "this logical message was already sent" by scanning
   * comments — the root mitigation for GitHub having no transactions. */
  correlationId?: string;
  /** #153: optional diagnostic dimensions of the run/attempt that emitted this message (not a retry FSM). */
  run?: number;
  attempt?: number;
  status?: StateStatus;
}

/**
 * #153: derive a STABLE idempotency key from a machine message's logical identity. Same logical message
 * (same repo/issue/kind/action/spec) → same key across re-runs, so a re-run can recognize it was already
 * sent. A higher spec version is a *different* logical message (a fresh gate, #95 staleness) → different key.
 * Human-legible on purpose so the key is auditable straight from a comment's envelope.
 */
export function deriveCorrelationId(parts: { repo: string; num: number; kind: string; action?: GatedKind; spec?: number }): string {
  let key = `${parts.repo}#${parts.num}:${parts.kind}`;
  if (parts.action) key += `:${parts.action}`;
  if (parts.spec !== undefined) key += `@spec${parts.spec}`;
  return key;
}

const STATE_RE = /<!--monastery-state\s*([\s\S]*?)-->\n?/;

export function renderStateMessage(msg: { status: StateStatus; action?: GatedKind; spec?: number; agent?: string; model?: string; provider?: string; correlationId?: string; run?: number; attempt?: number; body: string }): string {
  const { head, kind } = deriveState(msg.status);
  const lines = ["v: 1", `kind: ${kind}`, `protocol: ${kind}`, `status: ${msg.status}`];
  if (msg.action) lines.push(`action: ${msg.action}`);
  if (msg.spec !== undefined) lines.push(`spec: ${msg.spec}`);
  if (msg.agent) lines.push(`agent: ${msg.agent}`);
  if (msg.model) lines.push(`model: ${msg.model}`);
  if (msg.provider) lines.push(`provider: ${msg.provider}`);
  if (msg.correlationId) lines.push(`correlationId: ${msg.correlationId}`);
  if (msg.run !== undefined) lines.push(`run: ${msg.run}`);
  if (msg.attempt !== undefined) lines.push(`attempt: ${msg.attempt}`);
  const body = head ? `${head}\n\n${msg.body}` : msg.body;
  return `${STATE_MARKER}\n${lines.join("\n")}\n-->\n${body}`;
}

const numericField = z.string().regex(/^\d+$/);

/**
 * #154: the typed class-A envelope schema. `parseMeta` decodes the wire `key: value` lines into a record;
 * this validates that record. A present-but-invalid typed field (action/status/spec/run/attempt) fails the
 * parse so a corrupt machine block is REJECTED rather than silently coerced into a half-note ("非法块被拒,
 * 非误判"). Unknown keys pass through (forward-compat); a legacy v0 block (protocol-only, no v/status) is
 * tolerated because every typed field is optional.
 */
const MetaSchema = z
  .object({
    v: z.string().optional(),
    kind: z.string().optional(),
    protocol: z.string().optional(),
    status: z.enum(STATE_STATUSES).optional(),
    action: z.enum(GATED_KINDS).optional(),
    spec: numericField.optional(),
    run: numericField.optional(),
    attempt: numericField.optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    correlationId: z.string().optional(),
  })
  .passthrough();

export function parseStateMessage(body: string): StateMessage | null {
  const m = body.match(STATE_RE);
  if (!m) return null;
  const parsed = MetaSchema.safeParse(parseMeta(m[1]));
  if (!parsed.success) return null; // #154: a corrupt typed block is rejected, never misjudged as a note
  const meta = parsed.data;
  const kind = meta.kind ?? meta.protocol; // v1 `kind`, falling back to the v0 `protocol` field
  if (kind !== "note" && kind !== "approval") return null;
  return {
    kind,
    body: body.replace(STATE_RE, "").trim(),
    ...(meta.action ? { action: meta.action } : {}),
    ...(meta.spec !== undefined ? { spec: Number(meta.spec) } : {}),
    ...(meta.agent ? { agent: meta.agent } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.provider ? { provider: meta.provider } : {}),
    ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
    ...(meta.run !== undefined ? { run: Number(meta.run) } : {}),
    ...(meta.attempt !== undefined ? { attempt: Number(meta.attempt) } : {}),
    ...(meta.status ? { status: meta.status } : {}),
  };
}

export function isStateMessage(body: string, kind?: StateMessageKind): boolean {
  const msg = parseStateMessage(body);
  return !!msg && (!kind || msg.kind === kind);
}

/**
 * #154: the SINGLE schema helper that splits the two same-prefixed class-A surfaces by FIELD, so no call
 * site hand-writes a `kind`/`status`/`action` combination.
 *
 * `isApprovalGate` — an append-only approval comment (`kind: approval`) carrying a gated action. Only the
 * gate flow reads/consumes it; `upsertPanel` must NEVER rewrite it (that drops the approval門, #154).
 * `isStickyPanel` — the rewritable state surface `upsertPanel`/`readPanel` manage (any non-gate state
 * message: note/blocked/done). Selecting it by field is what keeps a gate at index [0] from being clobbered.
 */
export function isApprovalGate(body: string): boolean {
  return parseStateMessage(body)?.kind === "approval";
}
export function isStickyPanel(body: string): boolean {
  const kind = parseStateMessage(body)?.kind;
  return kind !== undefined && kind !== "approval";
}

export function approvalKind(body: string): GatedKind | null {
  return parseStateMessage(body)?.action ?? null;
}

export function approvalSpecVersion(body: string): number {
  return parseStateMessage(body)?.spec ?? 0;
}

export function stripStateMessage(body: string): string {
  return body.replace(STATE_RE, "").trim();
}

function parseMeta(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
