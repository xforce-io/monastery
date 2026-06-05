// src/engine/init.ts
import type { GitHubAdapter } from "../github/adapter.js";
import { LABEL_DEFS } from "../github/labels.js";

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

/** Onboard a repo: ensure the label set, scaffold the thesis if absent (never overwrite). */
export async function initRepo(gh: GitHubAdapter, repo: string): Promise<{ labels: number; thesisCreated: boolean }> {
  for (const l of LABEL_DEFS) await gh.ensureLabel(repo, l.name, l.color, l.description);
  let thesisCreated = false;
  if (!(await gh.fileExists(repo, THESIS_PATH))) {
    await gh.createFile(repo, THESIS_PATH, THESIS_TEMPLATE, "chore: scaffold monastery thesis");
    thesisCreated = true;
  }
  return { labels: LABEL_DEFS.length, thesisCreated };
}
