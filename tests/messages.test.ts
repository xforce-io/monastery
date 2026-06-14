import { expect, test } from "vitest";
import { deriveState, STATE_MARKER, renderStateMessage, parseStateMessage, deriveCorrelationId, isApprovalGate, isStickyPanel } from "../src/shell/messages.js";
import { NEEDS_APPROVAL, NEEDS_HUMAN } from "../src/github/labels.js";

const gateBody = renderStateMessage({ status: "awaiting-approval", action: "implement", spec: 1, body: "请批准" });
const panelNote = renderStateMessage({ status: "note", body: "fyi" });
const panelBlocked = renderStateMessage({ status: "blocked", body: "needs a human" });

test("#154 gate↔panel: isApprovalGate is true only for the append-only approval gate", () => {
  expect(isApprovalGate(gateBody)).toBe(true);
  expect(isApprovalGate(panelNote)).toBe(false);
  expect(isApprovalGate(panelBlocked)).toBe(false);
  expect(isApprovalGate("a plain human comment")).toBe(false);
});

test("#154 gate↔panel: isStickyPanel is true for any non-gate state surface, never the gate", () => {
  expect(isStickyPanel(panelNote)).toBe(true);
  expect(isStickyPanel(panelBlocked)).toBe(true);
  expect(isStickyPanel(gateBody)).toBe(false);          // the gate is append-only, NEVER the upsert target
  expect(isStickyPanel("a plain human comment")).toBe(false);
});

const block = (...lines: string[]) => `${STATE_MARKER}\n${lines.join("\n")}\n-->\nbody text`;

test("#154 schema: a present-but-invalid action rejects the whole block (not a silent drop)", () => {
  // Old behavior silently dropped the bad action and still returned a note. Schema-parse must reject so a
  // corrupt machine block is not misjudged as a valid note.
  expect(parseStateMessage(block("v: 1", "kind: approval", "status: awaiting-approval", "action: bogus"))).toBeNull();
});

test("#154 schema: a present-but-invalid status rejects the whole block", () => {
  expect(parseStateMessage(block("v: 1", "kind: note", "status: sideways"))).toBeNull();
});

test("#154 schema: a present-but-non-numeric spec rejects the whole block", () => {
  expect(parseStateMessage(block("v: 1", "kind: approval", "status: awaiting-approval", "action: implement", "spec: abc"))).toBeNull();
});

test("#154 schema: a legacy v0 protocol-only block is still tolerated (kind from protocol)", () => {
  // No v / kind / status — the pre-#144 wire shape. Must NOT be rejected.
  expect(parseStateMessage(block("protocol: approval", "action: close"))).toMatchObject({ kind: "approval", action: "close" });
});

test("#154 schema: a well-formed v1 block still round-trips every typed field", () => {
  const body = renderStateMessage({
    status: "awaiting-approval", action: "implement", spec: 3, agent: "maintainer",
    model: "opus", provider: "claude", correlationId: "o/r#1:approval:implement@spec3", run: 2, attempt: 1, body: "draft",
  });
  expect(parseStateMessage(body)).toMatchObject({
    kind: "approval", status: "awaiting-approval", action: "implement", spec: 3,
    agent: "maintainer", model: "opus", provider: "claude", correlationId: "o/r#1:approval:implement@spec3", run: 2, attempt: 1,
  });
});

test("#144 deriveState is the single source for head/kind/labels", () => {
  expect(deriveState("awaiting-approval")).toMatchObject({
    kind: "approval", labels: { add: NEEDS_APPROVAL },
  });
  expect(deriveState("awaiting-approval").head).toContain("NEEDS YOUR APPROVAL");

  expect(deriveState("blocked")).toMatchObject({ kind: "note", labels: { add: NEEDS_HUMAN } });
  expect(deriveState("blocked").head).toContain("需要人工介入");

  expect(deriveState("done")).toMatchObject({ kind: "note", labels: { remove: NEEDS_APPROVAL } });
  expect(deriveState("done").head).toContain("已完成");

  expect(deriveState("note")).toMatchObject({ kind: "note", head: "", labels: {} });
});

test("#144 STATE_MARKER is the canonical machine-block prefix", () => {
  expect(STATE_MARKER).toBe("<!--monastery-state");
});

test("#144 render(status) prepends the head and serializes status", () => {
  const body = renderStateMessage({ status: "blocked", agent: "patcher", model: "sonnet", body: "details here" });
  expect(body).toContain("status: blocked");
  expect(body).toContain("kind: note");          // derived
  expect(body).toContain("需要人工介入");          // head prepended
  expect(body).toContain("details here");
  expect(parseStateMessage(body)).toMatchObject({ status: "blocked", kind: "note", agent: "patcher", model: "sonnet" });
});

test("#152 render/parse round-trips the provider provenance alongside agent/model", () => {
  const body = renderStateMessage({ status: "note", agent: "reviewer", model: "gpt-test", provider: "codex", body: "fyi" });
  expect(body).toContain("provider: codex");
  expect(parseStateMessage(body)).toMatchObject({ agent: "reviewer", model: "gpt-test", provider: "codex" });
});

test("#152 provider is omitted from the envelope when not supplied", () => {
  const body = renderStateMessage({ status: "note", agent: "maintainer", model: "opus", body: "x" });
  expect(body).not.toContain("provider:");
  expect(parseStateMessage(body)).not.toHaveProperty("provider");
});

test("#144 render(status: note) emits no head prefix", () => {
  const body = renderStateMessage({ status: "note", body: "just fyi" });
  expect(body.split("-->\n")[1]).toBe("just fyi");  // body unchanged, no banner
  expect(parseStateMessage(body)).toMatchObject({ status: "note", kind: "note" });
});

test("#153 render/parse round-trips the correlationId idempotency key (+ run/attempt)", () => {
  const body = renderStateMessage({
    status: "awaiting-approval", action: "implement", spec: 2,
    correlationId: "xforce-io/monastery#1:approval:implement@spec2", run: 7, attempt: 3,
    body: "## Plan",
  });
  expect(body).toContain("correlationId: xforce-io/monastery#1:approval:implement@spec2");
  expect(body).toContain("run: 7");
  expect(body).toContain("attempt: 3");
  expect(parseStateMessage(body)).toMatchObject({
    correlationId: "xforce-io/monastery#1:approval:implement@spec2", run: 7, attempt: 3,
  });
});

test("#153 deriveCorrelationId is deterministic and varies by logical identity", () => {
  const base = { repo: "xforce-io/monastery", num: 1, kind: "approval", action: "implement" as const, spec: 2 };
  // stable, human-legible key — same inputs across reruns yield the same key
  expect(deriveCorrelationId(base)).toBe("xforce-io/monastery#1:approval:implement@spec2");
  expect(deriveCorrelationId(base)).toBe(deriveCorrelationId(base));
  // a higher spec version is a DIFFERENT logical message (a fresh gate, #95 staleness) -> different key
  expect(deriveCorrelationId({ ...base, spec: 3 })).not.toBe(deriveCorrelationId(base));
  // a different action is a different logical message
  expect(deriveCorrelationId({ ...base, action: "close" })).not.toBe(deriveCorrelationId(base));
  // minimal form: no action / no spec
  expect(deriveCorrelationId({ repo: "o/r", num: 5, kind: "note" })).toBe("o/r#5:note");
});

test("#153 correlationId/run/attempt are omitted from the envelope when not supplied", () => {
  const body = renderStateMessage({ status: "note", body: "fyi" });
  expect(body).not.toContain("correlationId:");
  expect(body).not.toContain("run:");
  expect(body).not.toContain("attempt:");
  const parsed = parseStateMessage(body)!;
  expect(parsed).not.toHaveProperty("correlationId");
  expect(parsed).not.toHaveProperty("run");
  expect(parsed).not.toHaveProperty("attempt");
});
