import { expect, test } from "vitest";
import { selectAgentProvider, type ProviderHealthProbe } from "../src/provider/select.js";

function probe(results: Record<string, { ok: boolean; reason?: string }>): ProviderHealthProbe {
  return async (name) => results[name] ?? { ok: false, reason: "not configured" };
}

test("auto selects claude when claude is healthy", async () => {
  const selected = await selectAgentProvider({ mode: "auto", health: probe({ claude: { ok: true }, codex: { ok: true } }) });
  expect(selected.name).toBe("claude");
});

test("auto falls back to codex when claude is unhealthy", async () => {
  const selected = await selectAgentProvider({ mode: "auto", health: probe({ claude: { ok: false, reason: "no claude" }, codex: { ok: true } }) });
  expect(selected.name).toBe("codex");
  expect(selected.fallbackFrom).toBe("claude");
});

test("explicit codex does not probe or select claude", async () => {
  const seen: string[] = [];
  const selected = await selectAgentProvider({
    mode: "codex",
    health: async (name) => { seen.push(name); return { ok: true }; },
  });
  expect(selected.name).toBe("codex");
  expect(seen).toEqual(["codex"]);
});

test("throws with both provider reasons when no provider is healthy", async () => {
  await expect(selectAgentProvider({
    mode: "auto",
    health: probe({ claude: { ok: false, reason: "missing" }, codex: { ok: false, reason: "auth" } }),
  })).rejects.toThrow(/claude: missing[\s\S]*codex: auth/);
});
