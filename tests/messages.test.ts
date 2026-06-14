import { expect, test } from "vitest";
import { deriveState, STATE_MARKER, renderStateMessage, parseStateMessage, deriveCorrelationId } from "../src/shell/messages.js";
import { NEEDS_APPROVAL, NEEDS_HUMAN } from "../src/github/labels.js";

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
