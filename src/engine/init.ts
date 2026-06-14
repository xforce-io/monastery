// src/engine/init.ts
import type { GitHubAdapter } from "../github/adapter.js";
import { LABEL_DEFS, labelsFingerprint } from "../github/labels.js";

/**
 * Records which label set a repo has already had fully ensured (#148), so initRepo can skip
 * its ensureLabel calls on subsequent ticks instead of re-running the whole set every time.
 * Implemented by Store; an in-memory version is used in tests.
 */
export interface LabelEnsureCache {
  ensuredLabelsFingerprint(repo: string): string | undefined;
  setEnsuredLabelsFingerprint(repo: string, fingerprint: string): void;
}

export interface InitOptions {
  /** When provided, ensureLabel runs only if the cached fingerprint is missing/stale (or `force`). */
  cache?: LabelEnsureCache;
  /** Always ensure the full label set, ignoring the cache (explicit `monastery init`). */
  force?: boolean;
}

export const THESIS_PATH = ".monastery/thesis.md";

export const THESIS_TEMPLATE = `# Thesis

> TODO: replace this scaffold with your repo's real thesis.

One paragraph: why this repo exists and what it is for. monastery gates every
incoming issue against this statement — an issue that does not serve it is \`out\`.

## In scope
- ...

## Out of scope (reject at the gate)
- ...
`;

/**
 * Onboard a repo: ensure the label set, scaffold the thesis if absent (never overwrite).
 * With a `cache`, the ensureLabel pass is skipped while the recorded fingerprint matches the
 * current label set — so a flaky label API stays off every tick's critical path (#148). The
 * fingerprint is recorded only after all labels are ensured; a failure mid-pass leaves it unset
 * so the next tick retries (and the underlying gh retry/backoff absorbs transient blips).
 */
export async function initRepo(
  gh: GitHubAdapter,
  repo: string,
  opts: InitOptions = {},
): Promise<{ labels: number; thesisCreated: boolean; labelsEnsured: boolean }> {
  const fingerprint = labelsFingerprint();
  const upToDate = !opts.force && opts.cache?.ensuredLabelsFingerprint(repo) === fingerprint;
  let labelsEnsured = false;
  if (!upToDate) {
    for (const l of LABEL_DEFS) await gh.ensureLabel(repo, l.name, l.color, l.description);
    opts.cache?.setEnsuredLabelsFingerprint(repo, fingerprint);
    labelsEnsured = true;
  }
  let thesisCreated = false;
  if (!(await gh.fileExists(repo, THESIS_PATH))) {
    await gh.createFile(repo, THESIS_PATH, THESIS_TEMPLATE, "chore: scaffold monastery thesis");
    thesisCreated = true;
  }
  return { labels: LABEL_DEFS.length, thesisCreated, labelsEnsured };
}
