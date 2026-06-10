import { expect, test } from "vitest";
import { resolveModelLevel, resolveModelLevels } from "../src/provider/models.js";

test("provider-specific level model wins over generic and legacy model", () => {
  const env = {
    MONASTERY_MODEL: "legacy",
    MONASTERY_MODEL_STRONG: "generic-strong",
    MONASTERY_CODEX_MODEL_STRONG: "codex-strong",
  };
  expect(resolveModelLevel("codex", "strong", env)).toBe("codex-strong");
  expect(resolveModelLevel("claude", "strong", env)).toBe("generic-strong");
});

test("legacy MONASTERY_MODEL remains the fallback when no level model is set", () => {
  expect(resolveModelLevel("codex", "standard", { MONASTERY_MODEL: "legacy" })).toBe("legacy");
});

test("provider defaults are used before the hard default", () => {
  expect(resolveModelLevel("claude", "fast", {})).toBe("haiku");
  expect(resolveModelLevel("claude", "standard", {})).toBe("sonnet");
  expect(resolveModelLevel("codex", "standard", {})).toBe("");
});

test("resolveModelLevels returns all levels for the selected provider", () => {
  expect(resolveModelLevels("claude", { MONASTERY_CLAUDE_MODEL_FAST: "tiny" }))
    .toEqual({ fast: "tiny", standard: "sonnet", strong: "sonnet" });
});
