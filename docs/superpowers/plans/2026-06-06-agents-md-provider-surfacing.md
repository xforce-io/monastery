# AGENTS.md Provider Surfacing (#21) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `claude_code`'s editor agent see the target repo's `AGENTS.md` by surfacing it as a `@AGENTS.md` CLAUDE.md during the run, removed afterward so it never lands in a patch.

**Architecture:** A pure exported helper `surfaceClaudeConventions(cwd)` writes a one-line `@AGENTS.md` CLAUDE.md iff the cwd has AGENTS.md and no CLAUDE.md, and returns a cleanup fn. `ClaudeCodeProvider.run()` calls it, wrapping the claude spawn in try/finally so cleanup runs before artifacts are scanned. The "surface AGENTS.md" responsibility is documented as an `AgentProvider.run()` contract (mechanism is per-provider; codex reads AGENTS.md natively — no shared interface method).

**Tech Stack:** TypeScript (ESM, NodeNext), vitest. Design source: `docs/design/21-agents-md-conventions.md`.

---

## File Structure

- **Modify** `src/provider/claude-code.ts` — add exported `surfaceClaudeConventions(cwd)`; wrap `run()`'s spawn in try/finally with the cleanup (cleanup before `scanArtifacts`).
- **Modify** `src/provider/interface.ts` — add a contract doc comment to `AgentProvider.run()`.
- **Modify** `tests/provider.test.ts` — add 3 tests for `surfaceClaudeConventions`.

No new files; no framework changes; no AGENTS.md parsing (out of scope — branch naming is tracked separately in #28).

---

## Task 1: `surfaceClaudeConventions` helper

**Files:**
- Modify: `src/provider/claude-code.ts`
- Test: `tests/provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/provider.test.ts` (add these imports at the top if not already present: `existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`):

```ts
import { surfaceClaudeConventions } from "../src/provider/claude-code.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/provider.test.ts`
Expected: FAIL — `surfaceClaudeConventions` is not exported from `claude-code.js`.

- [ ] **Step 3: Implement the helper**

In `src/provider/claude-code.ts`, add `rmSync` to the existing `node:fs` import (it currently imports `existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync` — make it include `rmSync`):

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
```

Add this exported function (place it near the top, after the imports, before the class):

```ts
/**
 * If `cwd` has AGENTS.md and no CLAUDE.md, write a one-line `@AGENTS.md` CLAUDE.md so `claude -p`
 * picks up the repo's AGENTS.md (Claude Code reads CLAUDE.md, not AGENTS.md). Returns a cleanup fn
 * that removes the injected file — but only if we created it — so it never lands in a committed patch.
 */
export function surfaceClaudeConventions(cwd: string): () => void {
  const claudeMd = join(cwd, "CLAUDE.md");
  const inject = existsSync(join(cwd, "AGENTS.md")) && !existsSync(claudeMd);
  if (inject) writeFileSync(claudeMd, "@AGENTS.md\n", "utf8");
  return () => { if (inject) rmSync(claudeMd, { force: true }); };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/provider.test.ts`
Expected: PASS (the 3 new tests + existing FakeProvider tests).
Also run: `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/provider/claude-code.ts tests/provider.test.ts
git commit -m "feat(#21): surfaceClaudeConventions helper (AGENTS.md -> @import CLAUDE.md)"
```

---

## Task 2: Wire into `run()` + interface contract

**Files:**
- Modify: `src/provider/claude-code.ts` (`run()`)
- Modify: `src/provider/interface.ts` (contract comment)

`ClaudeCodeProvider.run()` spawns real `claude`, so it is not unit-tested; this task is verified by `tsc` + the full suite staying green (the helper logic is already covered by Task 1).

- [ ] **Step 1: Wrap the spawn with surface/cleanup**

In `src/provider/claude-code.ts`, the current `run()` body is:

```ts
  async run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult> {
    mkdirSync(config.artifactDir, { recursive: true });
    const promptFile = join(config.artifactDir, "_prompt.md");
    writeFileSync(promptFile, `${config.persona}\n\n---\n\n${config.context}`, "utf8");

    await execa("claude", ["-p", "--model", config.model, "--output-format", "json"], {
      cwd: config.artifactDir,
      inputFile: promptFile,
      stdout: { file: join(config.artifactDir, "_claude_stdout.json") },
      stderr: "inherit",
      timeout: config.timeoutMs ?? 30 * 60_000,
      cancelSignal: signal,
      reject: false, // an exit code is not a throw; the shell judges by artifacts
    });

    let resultText: string | undefined;
    const stdoutPath = join(config.artifactDir, "_claude_stdout.json");
    if (existsSync(stdoutPath)) {
      try {
        const j = JSON.parse(readFileSync(stdoutPath, "utf8")) as { result?: unknown };
        if (typeof j.result === "string") resultText = j.result;
      } catch { /* leave resultText undefined */ }
    }
    return { artifacts: scanArtifacts(config.artifactDir), resultText };
  }
```

Replace it with (surface before the spawn; cleanup in `finally`, which runs before `scanArtifacts` so the injected CLAUDE.md is never reported as an artifact or staged into a patch):

```ts
  async run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult> {
    mkdirSync(config.artifactDir, { recursive: true });
    const promptFile = join(config.artifactDir, "_prompt.md");
    writeFileSync(promptFile, `${config.persona}\n\n---\n\n${config.context}`, "utf8");

    // Surface the repo's AGENTS.md to `claude -p` (which reads CLAUDE.md, not AGENTS.md).
    const cleanup = surfaceClaudeConventions(config.artifactDir);
    let resultText: string | undefined;
    try {
      await execa("claude", ["-p", "--model", config.model, "--output-format", "json"], {
        cwd: config.artifactDir,
        inputFile: promptFile,
        stdout: { file: join(config.artifactDir, "_claude_stdout.json") },
        stderr: "inherit",
        timeout: config.timeoutMs ?? 30 * 60_000,
        cancelSignal: signal,
        reject: false, // an exit code is not a throw; the shell judges by artifacts
      });

      const stdoutPath = join(config.artifactDir, "_claude_stdout.json");
      if (existsSync(stdoutPath)) {
        try {
          const j = JSON.parse(readFileSync(stdoutPath, "utf8")) as { result?: unknown };
          if (typeof j.result === "string") resultText = j.result;
        } catch { /* leave resultText undefined */ }
      }
    } finally {
      cleanup(); // remove the injected CLAUDE.md BEFORE artifacts are scanned / the patch is staged
    }
    return { artifacts: scanArtifacts(config.artifactDir), resultText };
  }
```

- [ ] **Step 2: Add the interface contract comment**

In `src/provider/interface.ts`, the current declaration is:

```ts
/** Runs one agent to completion. Output is the files it wrote into artifactDir. */
export interface AgentProvider {
  run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult>;
}
```

Replace it with:

```ts
/** Runs one agent to completion. Output is the files it wrote into artifactDir. */
export interface AgentProvider {
  /**
   * Run the agent to completion in `config.artifactDir`.
   *
   * Contract: surface the target repo's AGENTS.md (when present in the cwd) to the underlying agent —
   * each provider its own way (claude_code maps it to CLAUDE.md; codex reads AGENTS.md natively).
   * The framework does NOT parse AGENTS.md; it is agent-facing data.
   */
  run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult>;
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` → clean.
Run: `npx vitest run` → all pass (no regressions; ClaudeCodeProvider isn't unit-tested, so existing tests are unaffected).
Run: `npm run build` → `ESM ⚡️ Build success`.

- [ ] **Step 4: Commit**

```bash
git add src/provider/claude-code.ts src/provider/interface.ts
git commit -m "feat(#21): run() surfaces AGENTS.md; document the provider contract"
```

---

## Final verification

- [ ] `npx vitest run` → all pass.
- [ ] `npx tsc --noEmit` → clean.
- [ ] Confirm cleanup runs before `scanArtifacts` (so an injected CLAUDE.md never appears in `artifacts`).
- [ ] Open the PR: `gh pr create --base main --head feat/21-agents-md-conventions --title "feat(#21): provider surfaces AGENTS.md to the editor agent" --body "Closes #21 — see docs/design/21-agents-md-conventions.md"`.
