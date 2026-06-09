// src/shell/consensus.ts — consensus computed from GitHub-observable comments (see design #48).
// The shared spec is append-only versioned comments (no edit-in-place, so endorsements bind to a version
// unambiguously). Endorser identity = the comment's author (reuses listComments author, #51).

export interface Spec { version: number; parties: string[]; body: string; id: string }
export interface Endorsement { version: number; by: string }
export type Comment = { id: string; body: string; author: string };

const SPEC_RE = /<!--monastery-spec version=(\d+) parties=([^>]*?)-->\n?([\s\S]*)/;
const ENDORSE_RE = /<!--monastery-endorse version=(\d+)(?: source=shell)?-->/;

export const SPEC_MARKER = (version: number, parties: string[]): string =>
  `<!--monastery-spec version=${version} parties=${parties.join(",")}-->`;
export const ENDORSE_MARKER = (version: number): string => `<!--monastery-endorse version=${version} source=shell-->`;

/** All spec revisions found in the comments (append-only; each is one version). */
export function parseSpecs(comments: Comment[]): Spec[] {
  const out: Spec[] = [];
  for (const c of comments) {
    const m = c.body.match(SPEC_RE);
    if (!m) continue;
    const parties = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    out.push({ version: Number(m[1]), parties, body: m[3].trim(), id: c.id });
  }
  return out;
}

/** The current spec = the highest-version revision, or null if none. */
export function currentSpec(comments: Comment[]): Spec | null {
  const specs = parseSpecs(comments);
  return specs.length ? specs.reduce((a, b) => (b.version > a.version ? b : a)) : null;
}

/** All endorsements; `by` is the comment's author (identity, #51). */
export function parseEndorsements(comments: Comment[]): Endorsement[] {
  const out: Endorsement[] = [];
  for (const c of comments) {
    const m = c.body.match(ENDORSE_RE);
    if (m) out.push({ version: Number(m[1]), by: c.author });
  }
  return out;
}

/**
 * Consensus = every party of the spec has endorsed it. `endorsers` are the logins who reacted 👍 on the
 * spec comment — the ONLY endorsement signal an agent can't forge (a comment's author == owner is forgeable
 * when monastery runs as the owner, #92). The shell never writes reactions and the action vocabulary has no
 * "react", so a 👍 on the spec is necessarily a real human/party.
 */
export function consensusReached(spec: Spec | null, endorsers: string[]): boolean {
  if (!spec || spec.parties.length === 0) return false;
  const set = new Set(endorsers);
  return spec.parties.every((p) => set.has(p));
}
