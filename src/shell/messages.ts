import type { GatedKind } from "./actions.js";
import { NEEDS_APPROVAL, NEEDS_HUMAN } from "../github/labels.js";

export const STATE_MARKER = "<!--monastery-state";

/**
 * #90 approval banner — the `awaiting-approval` visible head, prepended by deriveState (never hand-written
 * at call sites). Exported so the one consumer that strips it back out (issue-step `stripMarkers`) stays in
 * sync with this canonical text instead of re-encoding it.
 */
export const AWAITING_APPROVAL_BANNER =
  "⏳ **NEEDS YOUR APPROVAL** — 👍 this comment to approve · 👎 to decline · 👀 to send back for revision";

export type StateMessageKind = "note" | "approval";

/** The closed set of states a class-A machine message can be in (#144 A3). */
export type StateStatus = "awaiting-approval" | "blocked" | "done" | "note";

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
      return { head: "⚠️ **需要人工介入 / needs a human**", kind: "note", labels: { add: NEEDS_HUMAN } };
    case "done":
      return { head: "✅ **已完成 / done**", kind: "note", labels: { remove: NEEDS_APPROVAL } };
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

export function parseStateMessage(body: string): StateMessage | null {
  const m = body.match(STATE_RE);
  if (!m) return null;
  const meta = parseMeta(m[1]);
  const kind = meta.kind ?? meta.protocol;
  if (kind !== "note" && kind !== "approval") return null;
  const action = parseAction(meta.action);
  const spec = meta.spec && /^\d+$/.test(meta.spec) ? Number(meta.spec) : undefined;
  const run = meta.run && /^\d+$/.test(meta.run) ? Number(meta.run) : undefined;
  const attempt = meta.attempt && /^\d+$/.test(meta.attempt) ? Number(meta.attempt) : undefined;
  const status = isStateStatus(meta.status) ? meta.status : undefined;
  return {
    kind,
    body: body.replace(STATE_RE, "").trim(),
    ...(action ? { action } : {}),
    ...(spec !== undefined ? { spec } : {}),
    ...(meta.agent ? { agent: meta.agent } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.provider ? { provider: meta.provider } : {}),
    ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
    ...(run !== undefined ? { run } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(status ? { status } : {}),
  };
}

export function isStateMessage(body: string, kind?: StateMessageKind): boolean {
  const msg = parseStateMessage(body);
  return !!msg && (!kind || msg.kind === kind);
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

function parseAction(raw: string | undefined): GatedKind | null {
  if (raw === "close" || raw === "merge" || raw === "implement" || raw === "rework") return raw;
  return null;
}

function isStateStatus(raw: string | undefined): raw is StateStatus {
  return raw === "awaiting-approval" || raw === "blocked" || raw === "done" || raw === "note";
}
