# monastery

> Monastery: where repositories learn to govern themselves.

An AI repo maintainer. Per-repo reconciler, GitHub as sole source of truth, agent-layer
provider abstraction (default: `claude_code`). Design: `docs/superpowers/specs/2026-06-05-monastery-v0-design.md`.

## Usage (M1)

```bash
monastery repos add <owner>/<repo>   # manage a repo
monastery step --repo <owner>/<repo> # run one reconcile tick (cron/bot invokes this)
```

Approve a proposed close on GitHub: remove `monastery:needs-approval`, add `monastery:approved`.
