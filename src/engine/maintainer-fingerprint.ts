// src/engine/maintainer-fingerprint.ts — #192: a content fingerprint over the EXACT input the maintainer
// agent sees this tick. Same input → same proposal → identical (idempotent) writes, so assess may skip the
// ~2-min LLM pass when the fingerprint is unchanged. This is a PURE COST cache: a cold/lost/mismatched
// fingerprint only ever costs one full re-assess — it never changes correctness or any terminal state. That
// is the line that separates it from #184's failure-count (a truth state whose loss wedges an item).
import { createHash } from "node:crypto";
import type { MaintainerInput } from "../agents/maintainer.js";

export function maintainerInputFingerprint(input: MaintainerInput): string {
  // monastery's own comments (sticky panels, marker replies) change every tick assess acts. Hashing them
  // would make the cache self-invalidate after the very write that should let it rest — so exclude self.
  const self = input.self;
  const external = (c: { author: string }) => c.author !== self;
  const salient = {
    thesis: input.thesis,
    issue: {
      number: input.issue.number,
      title: input.issue.title,
      body: input.issue.body,
      labels: [...input.issue.labels].sort(),
      state: input.issue.state,
    },
    comments: input.comments.filter(external).map((c) => ({ id: c.id, body: c.body, author: c.author })),
    pr: input.pr && {
      branch: input.pr.branch,
      state: input.pr.state,
      title: input.pr.title,
      body: input.pr.body,
      isDraft: input.pr.isDraft,
      checks: input.pr.checks,
      // same self-exclusion as the issue thread: monastery's own gatelink/marker PR comments must not churn.
      comments: (input.pr.comments ?? []).filter(external).map((c) => ({ id: c.id, body: c.body, author: c.author })),
      reviews: (input.pr.reviews ?? []).filter(external),
    },
    deps: input.deps,
    consensus: input.consensus,
    language: input.language,
  };
  return createHash("sha256").update(JSON.stringify(salient)).digest("hex");
}
