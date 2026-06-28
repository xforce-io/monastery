# monastery

> Where repositories learn to govern themselves.

**monastery** is an AI repo maintainer. It runs as a per-repo *reconciler*: each tick it reads
your repo's open issues and PRs from GitHub, lets one governed agent decide the next step, and
proposes or takes actions — with GitHub as the single source of truth. Risky actions (closing an
issue, merging a PR) are never taken unilaterally; they wait for your 👍.

You point it at a repo, then drive it from either front door:

- **In a Claude Code session** — the bundled `monastery` skill turns plain-language intent ("巡检一下
  / what's waiting on me / run a tick") into the right CLI calls and reads the output back as prose.
  This is the everyday, human-in-the-loop way to operate it.
- **Unattended** — a cron job or bot runs `monastery step` on a schedule. This is the autonomous
  loop that lets a repo govern itself with no one watching.

Same reconcile loop underneath; the skill is just a thin conversational shell over the same CLI.

## Prerequisites

monastery drives local CLIs on your `PATH` — it does not bundle them:

- **[`gh`](https://cli.github.com)** — the GitHub CLI, **logged in** (`gh auth login`). This is how
  monastery reads and writes issues/PRs.
- **[`claude`](https://docs.claude.com/claude-code)** — the Claude Code CLI, the default agent provider.
- **`codex`** — optional fallback agent provider. Set `MONASTERY_PROVIDER=codex` to force it, or
  leave `MONASTERY_PROVIDER=auto` to use it when Claude is unavailable.
- **Node.js ≥ 20**.

monastery runs a **preflight check** on startup: if `gh` is missing / unauthenticated or no agent
provider CLI is available, it prints exactly what to fix and exits — no raw stack traces. For
`step`, it also health-checks the selected agent provider before touching GitHub.

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

**One-time setup** (CLI — the skill deliberately doesn't do config):

```bash
# Prepare a repo: ensure governance labels exist + scaffold the thesis.
monastery init <owner>/<repo>

# Track it (optionally pin a per-repo agent model).
monastery repos add <owner>/<repo>
```

Then drive it either way.

### A. In a Claude Code session — the everyday way

The repo ships a `monastery` skill at [`.claude/skills/monastery/`](.claude/skills/monastery/SKILL.md).
Make it available in every session by symlinking it into your global skills directory (run from a
clone of this repo):

```bash
ln -s "$(pwd)/.claude/skills/monastery" ~/.claude/skills/monastery
```

Now just talk to it — the skill maps intent to the right read-only-first call and reads the result
back as prose:

| You say | It runs |
|---------|---------|
| 巡检一下 / what's the state | `monastery status` |
| what's waiting on me / pending | `monastery pending` → each item with a direct GitHub link |
| what's queued / backlog | `monastery backlog` |
| run a tick / advance it | `monastery step --dry-run` → asks before the real run |

The skill is a **thin shell**: it previews writes before acting, never approves or merges on your
behalf (that stays a human 👍 / Merge on GitHub), and never touches `init` / `repos` config.

### B. Unattended — the autonomous loop

```bash
# Dry-run one tick — computes what it *would* do, writes nothing.
monastery step --repo <owner>/<repo> --dry-run
```

When the dry-run looks right, drop `--dry-run` and put `monastery step` on a cron/bot schedule. A 👍
on the approval comment is how you approve a gated action (close/merge); see
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

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
| `--dry-run` | `step` | Compute actions but write nothing to GitHub; local lock/progress cache may still refresh. |
| `--json` | `step`, `status`, `backlog`, `pending` | Machine-readable output; `step` emits an NDJSON event stream on stdout. |
| `--repo <owner>/<repo>` | most | Target one tracked repo instead of all. |
| `--issue <N>` | `step` | Reconcile a single issue. |
| `--force-stale-lock` | `step` | Reclaim a lock only if the prior process is gone. |

| Env var | Effect |
|---------|--------|
| `MONASTERY_PROVIDER` | Agent provider selection: `auto`, `claude`, or `codex`; default `auto`. |
| `MONASTERY_MODEL_FAST` / `STANDARD` / `STRONG` | Generic model levels used when provider-specific values are unset. |
| `MONASTERY_CLAUDE_MODEL_FAST` / `STANDARD` / `STRONG` | Claude-specific model levels; defaults are `haiku` / `sonnet` / `sonnet`. |
| `MONASTERY_CODEX_MODEL_FAST` / `STANDARD` / `STRONG` | Codex-specific model levels; unset means use the Codex CLI default model. |
| `MONASTERY_MODEL` | Legacy default model fallback. A per-repo override (`repos add … <model>`) still wins for the repo default. |
| `MONASTERY_REVIEW_MODEL` | Legacy reviewer model override. |

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
- [`.claude/skills/monastery/SKILL.md`](.claude/skills/monastery/SKILL.md) — the conversational operator shell.

## License

[MIT](LICENSE)
