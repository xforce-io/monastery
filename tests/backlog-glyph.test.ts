// #155: backlog 视图字形统一 — the `status → glyph` vocabulary is the SINGLE source for the
// ⏳/✅/⚠️ literals scattered across backlog/reconcile views, aligned to #144's StateStatus closed set.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { STATUS_GLYPH, STATE_STATUSES, deriveState } from "../src/shell/messages.js";
import { formatPending } from "../src/cli/backlog.js";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

test("#155 STATUS_GLYPH is a closed vocab keyed by the StateStatus set", () => {
  // every StateStatus has exactly one glyph entry, and no extra keys (closed set, no drift vs #144)
  expect(Object.keys(STATUS_GLYPH).sort()).toEqual([...STATE_STATUSES].sort());
  expect(STATUS_GLYPH["awaiting-approval"]).toBe("⏳");
  expect(STATUS_GLYPH.blocked).toBe("⚠️");
  expect(STATUS_GLYPH.done).toBe("✅");
  expect(STATUS_GLYPH.note).toBe(""); // a plain note carries no status glyph
});

test("#155 deriveState heads derive their glyph FROM the vocab (no separate literal)", () => {
  expect(deriveState("awaiting-approval").head.startsWith(STATUS_GLYPH["awaiting-approval"])).toBe(true);
  expect(deriveState("blocked").head.startsWith(STATUS_GLYPH.blocked)).toBe(true);
  expect(deriveState("done").head.startsWith(STATUS_GLYPH.done)).toBe(true);
});

test("#155 formatPending prefixes awaiting items with the vocab glyph", () => {
  const out = formatPending([
    { repo: "o/r", number: 7, title: "feat", approvalKind: "implement", approvalCommentId: "999" },
  ]);
  expect(out).toContain(`${STATUS_GLYPH["awaiting-approval"]} #7 feat`);
});

test("#155 backlog view sources carry NO hand-written status-glyph literals (single source)", () => {
  // the three view surfaces named by the issue must reference STATUS_GLYPH, not inline ⏳/✅/⚠️
  for (const rel of ["engine/reconcile.ts", "engine/issue-step.ts", "cli/backlog.ts"]) {
    const text = src(rel);
    for (const glyph of ["⏳", "✅", "⚠️"]) {
      expect(text, `${rel} should not inline the ${glyph} literal`).not.toContain(glyph);
    }
  }
});
