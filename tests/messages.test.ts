import { expect, test } from "vitest";
import { deriveState, STATE_MARKER, type StateStatus } from "../src/shell/messages.js";
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
