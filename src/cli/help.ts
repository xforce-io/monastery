// src/cli/help.ts
// Help / version routing and the single source of truth for the command list.
// Kept free of side effects so the dispatcher can short-circuit on --help BEFORE
// any command runs — the fix for #70's `step --help` running a full reconcile.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One row per dispatchable command. The usage text and README command list derive from this. */
export const COMMANDS: ReadonlyArray<{ usage: string; desc: string }> = [
  { usage: "init <owner>/<repo>", desc: "ensure labels + scaffold the governance thesis on a repo" },
  { usage: "repos add <owner>/<repo> [model]", desc: "track a repo (optional per-repo model override)" },
  { usage: "repos remove <owner>/<repo>", desc: "stop tracking a repo" },
  { usage: "status [--repo o/r] [--json]", desc: "show open issues and the live phase progress of any in-flight step" },
  { usage: "backlog [--repo o/r] [--json]", desc: "show the last ranked backlog snapshot" },
  { usage: "pending [--repo o/r] [--json]", desc: "list items awaiting your 👍 approval" },
  { usage: "step [--repo o/r] [--issue N] [--dry-run] [--json]", desc: "run one reconcile tick (cron/bot invokes this)" },
];

const HELP_TOKENS = new Set(["--help", "-h", "help"]);
const VERSION_TOKENS = new Set(["--version", "-v", "version"]);

/**
 * True when the invocation should print help instead of executing a command:
 * a bare invocation (no args), a top-level `help`, or `--help`/`-h` anywhere in argv.
 * The "anywhere" rule is deliberate — `monastery step --help` must route to help,
 * never into the step path (#70).
 */
export function wantsHelp(argv: string[]): boolean {
  if (argv.length === 0) return true;
  return argv.some((a) => HELP_TOKENS.has(a));
}

/** True for `--version` / `-v` / `version` as the leading token. */
export function wantsVersion(argv: string[]): boolean {
  return argv.length > 0 && VERSION_TOKENS.has(argv[0]);
}

/** The full usage block printed for `--help` and bare invocation. */
export function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length));
  const lines = COMMANDS.map((c) => `  monastery ${c.usage.padEnd(width)}  ${c.desc}`);
  return [
    "monastery — an AI repo maintainer (per-repo reconciler; GitHub is the source of truth).",
    "",
    "Usage:",
    "  monastery <command> [flags]",
    "",
    "Commands:",
    ...lines,
    "",
    "Common flags:",
    "  --repo <owner>/<repo>   target a single tracked repo (default: all tracked repos)",
    "  --dry-run               compute actions but write nothing to GitHub (step only)",
    "  --json                  machine-readable output / NDJSON event stream (step)",
    "  --help, -h              show this help",
    "  --version, -v           print the version",
    "",
    "Environment:",
    "  MONASTERY_PROVIDER              agent provider: auto, claude, or codex (default: auto)",
    "  MONASTERY_MODEL                 legacy default model fallback",
    "  MONASTERY_MODEL_FAST            generic fast model level",
    "  MONASTERY_MODEL_STANDARD        generic standard model level",
    "  MONASTERY_MODEL_STRONG          generic strong model level",
    "  MONASTERY_CLAUDE_MODEL_<LEVEL>  Claude-specific model level override",
    "  MONASTERY_CODEX_MODEL_<LEVEL>   Codex-specific model level override",
    "  MONASTERY_REVIEW_MODEL          legacy reviewer model override",
    "",
    "Prerequisites: `gh` (logged in) and at least one agent provider CLI (`claude` or `codex`) on your PATH.",
    "Docs: see the docs/ directory (ARCHITECTURE.md, PROTOCOL.md, CONSTITUTION.md).",
  ].join("\n");
}

/**
 * Resolve the package version by walking up from `startDir` to the nearest package.json.
 * Works both in dev (src/cli → repo root) and when bundled (dist → package root).
 * Falls back to "0.0.0" when none is found so `--version` never crashes.
 */
export function readPackageVersion(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const v = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown }).version;
        if (typeof v === "string") return v;
      } catch { /* fall through to parent */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}
