import type { GatedKind } from "./actions.js";
import { NEEDS_APPROVAL, NEEDS_HUMAN } from "../github/labels.js";

export const STATE_MARKER = "<!--monastery-state";

/** #90 approval banner — moved here so the visible head is derived, never hand-written at call sites. */
export const AWAITING_APPROVAL_BANNER =
  "⏳ **NEEDS YOUR APPROVAL** — 👍 this comment to approve · 👎 to decline · 👀 to send back for revision";

export type StateMessageKind = "note" | "approval";

/** The closed set of states a class-A machine message can be in (#144 A3). */
export type StateStatus = "awaiting-approval" | "blocked" | "done" | "note";

/**
 * #144 A3: the SINGLE source from which a class-A message's visible head, machine-block `kind`, and
 * control-label op are all derived — so they can never drift apart. `head` is a generic prefix; the
 * caller's `body` still carries the specifics. Only `awaiting-approval` has a named constant
 * (AWAITING_APPROVAL_BANNER) because it is referenced from external call sites; the other heads are
 * internal to this function.
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
  status?: StateStatus;
}

const STATE_RE = /<!--monastery-state\s*([\s\S]*?)-->\n?/;

type RenderInput =
  | { status: StateStatus; action?: GatedKind; spec?: number; agent?: string; model?: string; body: string }
  | { kind: StateMessageKind; action?: GatedKind; spec?: number; agent?: string; model?: string; body: string }; // legacy, removed in Task 7

export function renderStateMessage(msg: RenderInput): string {
  const status: StateStatus | undefined = "status" in msg ? msg.status : undefined;
  const derived = status ? deriveState(status) : null;
  const kind = derived ? derived.kind : (msg as { kind: StateMessageKind }).kind;
  const head = derived ? derived.head : "";

  const lines = ["v: 1", `kind: ${kind}`, `protocol: ${kind}`];
  if (status) lines.push(`status: ${status}`);
  if (msg.action) lines.push(`action: ${msg.action}`);
  if (msg.spec !== undefined) lines.push(`spec: ${msg.spec}`);
  if (msg.agent) lines.push(`agent: ${msg.agent}`);
  if (msg.model) lines.push(`model: ${msg.model}`);

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
  const status = isStateStatus(meta.status) ? meta.status : undefined;
  return {
    kind,
    body: body.replace(STATE_RE, "").trim(),
    ...(action ? { action } : {}),
    ...(spec !== undefined ? { spec } : {}),
    ...(meta.agent ? { agent: meta.agent } : {}),
    ...(meta.model ? { model: meta.model } : {}),
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
