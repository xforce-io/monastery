// src/engine/deps.ts — cross-repo stake links (P0 read-only, see docs/design/48-multi-party-consensus.md).
// An issue declares an upstream dependency with a GitHub-observable line: `Depends-on: owner/repo#N`.

export interface DepRef { repo: string; num: number }

const DEPENDS_ON = /Depends-on:\s*([\w.-]+\/[\w.-]+)#(\d+)/gi;

/** Parse `Depends-on: owner/repo#N` declarations out of an issue body (dedup, order-preserving). */
export function parseDeps(body: string): DepRef[] {
  const seen = new Set<string>();
  const out: DepRef[] = [];
  for (const m of body.matchAll(DEPENDS_ON)) {
    const repo = m[1];
    const num = Number(m[2]);
    const key = `${repo}#${num}`;
    if (!seen.has(key)) { seen.add(key); out.push({ repo, num }); }
  }
  return out;
}
