import type { GatedKind } from "./actions.js";

export type StateMessageKind = "note" | "approval";

export interface StateMessage {
  kind: StateMessageKind;
  body: string;
  action?: GatedKind;
  spec?: number;
  agent?: string;
  model?: string;
}

const STATE_RE = /<!--monastery-state\s*([\s\S]*?)-->\n?/;

export function renderStateMessage(msg: StateMessage): string {
  const lines = [
    "v: 1",
    `kind: ${msg.kind}`,
    `protocol: ${msg.kind}`,
  ];
  if (msg.action) lines.push(`action: ${msg.action}`);
  if (msg.spec !== undefined) lines.push(`spec: ${msg.spec}`);
  if (msg.agent) lines.push(`agent: ${msg.agent}`);
  if (msg.model) lines.push(`model: ${msg.model}`);
  return `<!--monastery-state\n${lines.join("\n")}\n-->\n${msg.body}`;
}

export function parseStateMessage(body: string): StateMessage | null {
  const m = body.match(STATE_RE);
  if (!m) return null;
  const meta = parseMeta(m[1]);
  const kind = meta.kind ?? meta.protocol;
  if (kind !== "note" && kind !== "approval") return null;
  const action = parseAction(meta.action);
  const spec = meta.spec && /^\d+$/.test(meta.spec) ? Number(meta.spec) : undefined;
  return {
    kind,
    body: body.replace(STATE_RE, "").trim(),
    ...(action ? { action } : {}),
    ...(spec !== undefined ? { spec } : {}),
    ...(meta.agent ? { agent: meta.agent } : {}),
    ...(meta.model ? { model: meta.model } : {}),
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
