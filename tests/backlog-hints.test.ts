import { expect, test } from "vitest";
import { formatBacklog, backlogJsonView } from "../src/cli/backlog.js";
import type { BacklogSnapshot } from "../src/types.js";

const snap: BacklogSnapshot = {
  generatedAt: "2026-06-29T00:00:00Z",
  repo: "o/r",
  rankedOf: { ranked: 2, open: 2 },
  entries: [
    { number: 12, title: "gate me", priority: "now", rationale: "ready", approvalKind: "implement", approvalCommentId: "999" },
    { number: 5, title: "just queued", priority: "soon", rationale: "later" },
  ],
};

test("#175 formatBacklog appends a → hint with the gate link; plain rows get none", () => {
  const out = formatBacklog(snap);
  expect(out).toContain("→ 等你 👍(implement) https://github.com/o/r/issues/12#issuecomment-999");
  const queuedLine = out.split("\n").find((l) => l.includes("#5"))!;
  expect(queuedLine).not.toContain("→");
});

test("#175 stale progress overlays onto its matching row only", () => {
  const progress = { issue: 12, view: { phase: "patch", attempt: undefined, elapsedMs: 169_106_485, stale: true, status: "start", reason: undefined, pid: 4242 } };
  const out = formatBacklog(snap, { progress });
  expect(out).toContain("→ 进度陈旧 46h58m,先 ps 4242"); // stale outranks the gate hint on #12
});

test("#175 backlogJsonView decorates rows with nextHint/nextHintUrl", () => {
  const view = backlogJsonView(snap);
  expect(view.entries[0]).toMatchObject({ nextHint: "等你 👍(implement)", nextHintUrl: "https://github.com/o/r/issues/12#issuecomment-999" });
  expect(view.entries[1].nextHint).toBeUndefined();
});
