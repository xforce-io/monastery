// tests/provider.test.ts
import { expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider/fake.js";
import { surfaceClaudeConventions } from "../src/provider/claude-code.js";

test("FakeProvider writes the preset files into artifactDir and returns them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-agent-"));
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"off-thesis"}' });
  const result = await provider.run({ persona: "p", context: "c", artifactDir: dir, model: "haiku" });
  expect(result.artifacts.map((a) => a.split("/").pop())).toContain("verdict.json");
  expect(JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")).verdict).toBe("out");
  rmSync(dir, { recursive: true, force: true });
});

test("FakeProvider returns resultText when provided", async () => {
  const { mkdtempSync } = await import("node:fs");
  const dir = mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-"));
  const r = await new FakeProvider({}, "hello").run({ persona: "p", context: "c", artifactDir: dir, model: "haiku" });
  expect(r.resultText).toBe("hello");
});

test("surfaceClaudeConventions: AGENTS.md present, no CLAUDE.md -> writes @AGENTS.md, cleanup removes it", () => {
  const d = mkdtempSync(join(tmpdir(), "surf-"));
  writeFileSync(join(d, "AGENTS.md"), "repo conventions", "utf8");
  const cleanup = surfaceClaudeConventions(d);
  expect(readFileSync(join(d, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  cleanup();
  expect(existsSync(join(d, "CLAUDE.md"))).toBe(false);
  rmSync(d, { recursive: true, force: true });
});

test("surfaceClaudeConventions: no AGENTS.md -> no CLAUDE.md created, cleanup is a no-op", () => {
  const d = mkdtempSync(join(tmpdir(), "surf-"));
  const cleanup = surfaceClaudeConventions(d);
  expect(existsSync(join(d, "CLAUDE.md"))).toBe(false);
  cleanup();
  expect(existsSync(join(d, "CLAUDE.md"))).toBe(false);
  rmSync(d, { recursive: true, force: true });
});

test("surfaceClaudeConventions: repo-owned CLAUDE.md -> untouched, cleanup does not delete it", () => {
  const d = mkdtempSync(join(tmpdir(), "surf-"));
  writeFileSync(join(d, "AGENTS.md"), "x", "utf8");
  writeFileSync(join(d, "CLAUDE.md"), "repo-owned", "utf8");
  const cleanup = surfaceClaudeConventions(d);
  expect(readFileSync(join(d, "CLAUDE.md"), "utf8")).toBe("repo-owned");
  cleanup();
  expect(existsSync(join(d, "CLAUDE.md"))).toBe(true);
  expect(readFileSync(join(d, "CLAUDE.md"), "utf8")).toBe("repo-owned");
  rmSync(d, { recursive: true, force: true });
});
