# monastery

> Where repositories learn to govern themselves.

**monastery** is an AI repo maintainer. It runs as a per-repo *reconciler*: each tick it reads
your repo's open issues and PRs from GitHub, lets one governed agent decide the next step, and
proposes or takes actions — with GitHub as the single source of truth. Risky actions (closing an
issue, merging a PR) are never taken unilaterally; they wait for your 👍.

You point it at a repo and run `monastery step`. A cron job or bot calls that same command on a
schedule. That's the whole loop.

## Prerequisites

monastery drives two CLIs on your `PATH` — it does not bundle them:

- **[`gh`](https://cli.github.com)** — the GitHub CLI, **logged in** (`gh auth login`). This is how
  monastery reads and writes issues/PRs.
- **[`claude`](https://docs.claude.com/claude-code)** — the Claude Code CLI, the default agent provider.
- **Node.js ≥ 20**.

monastery runs a **preflight check** on startup: if either tool is missing or `gh` is not
authenticated, it prints exactly what to fix and exits — no raw stack traces.

## Install

```bash
npm install -g monastery
# or run without installing:
npx monastery --help
```

Verify:

```bash
monastery --version
monastery --help
```

## Quick start

```bash
# 1. Prepare a repo: ensure governance labels exist + scaffold the thesis.
monastery init <owner>/<repo>

# 2. Track it (optionally pin a per-repo agent model).
monastery repos add <owner>/<repo>

# 3. Dry-run one reconcile tick — computes what it *would* do, writes nothing.
monastery step --repo <owner>/<repo> --dry-run
```

When the dry-run looks right, drop `--dry-run` to let it act. A 👍 on the approval comment is how
you approve a gated action (close/merge); see [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Commands

| Command | What it does |
|---------|--------------|
| `monastery init <owner>/<repo>` | Ensure governance labels + scaffold the thesis on a repo. |
| `monastery repos add <owner>/<repo> [model]` | Track a repo (optional per-repo model override). |
| `monastery repos remove <owner>/<repo>` | Stop tracking a repo. |
| `monastery status [--repo o/r]` | Open issues + live phase progress of any in-flight step. |
| `monastery backlog [--repo o/r]` | The last ranked backlog snapshot. |
| `monastery pending [--repo o/r]` | Items awaiting your 👍 approval, with a direct link. |
| `monastery step [--repo o/r]` | Run one reconcile tick (cron/bot invokes this). |

Run `monastery --help` or `monastery <command> --help` any time. With no `--repo`, commands act on
**all** tracked repos.

## Flags & environment

| Flag | Applies to | Effect |
|------|-----------|--------|
| `--dry-run` | `step` | Compute actions but write nothing to GitHub. |
| `--json` | `step`, `status`, `backlog`, `pending` | Machine-readable output; `step` emits an NDJSON event stream on stdout. |
| `--repo <owner>/<repo>` | most | Target one tracked repo instead of all. |
| `--issue <N>` | `step` | Reconcile a single issue. |
| `--force-stale-lock` | `step` | Reclaim a lock only if the prior process is gone. |

| Env var | Effect |
|---------|--------|
| `MONASTERY_MODEL` | Default agent model. A per-repo override (`repos add … <model>`) wins; default `sonnet`. |
| `MONASTERY_REVIEW_MODEL` | Model for the reviewer role (defaults to `MONASTERY_MODEL`). |

## How it works

monastery is a thin **governance shell** around one capable agent: the shell owns durable state,
invariants, idempotency, mandatory gates, the human protocol, and a safety-graded action
vocabulary; the agent owns all the reasoning and only *proposes* actions — it never touches `git`
or `gh` directly.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components and data flow.
- [`docs/CONSTITUTION.md`](docs/CONSTITUTION.md) — the invariants the shell enforces.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the human ⇄ monastery interaction protocol (labels, 👍).
- [`docs/AGENTS.md`](docs/AGENTS.md) — agent roles and conventions.
- [`docs/LOCAL-LAYOUT.md`](docs/LOCAL-LAYOUT.md) — on-disk layout under `~/.monastery`.

## License

[MIT](LICENSE)
