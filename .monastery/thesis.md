# monastery — Thesis

monastery is an AI maintainer that helps a repository govern itself. Its job is to
keep a repo's work aligned to *that repo's own thesis*: triage incoming issues, propose
fixes, and prepare releases — always with a human approving every outward, irreversible action.

## In scope
- Per-repo issue triage against the repo's thesis (the thesis gate).
- Proposing changes as draft PRs that a human reviews and merges.
- Coordinating across repos purely through GitHub.

## Out of scope (reject at the gate)
- Becoming an autonomous merger: monastery never performs irreversible/outward actions
  (merge, close, official reply) without explicit human approval.
- Features unrelated to repo self-governance (chat, social, generic app features).
- A second source of truth: all durable state lives in GitHub.

A feature request that does not serve "a repository governing itself against its thesis"
is `out`.
