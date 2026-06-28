// tests/cli.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, stepRepos, summarize } from "../src/cli/index.js";
import { prepareRepoForStep, stepExitCode } from "../src/cli/index.js";
import { StepLock } from "../src/config/step-lock.js";
import { FakeGitHub } from "../src/github/fake.js";
import { DryRunAdapter } from "../src/github/dry-run.js";
import { Store } from "../src/config/store.js";
import { LABEL_DEFS, labelsFingerprint } from "../src/github/labels.js";
import { THESIS_PATH } from "../src/engine/init.js";

test("parses `step --repo o/r --dry-run --json`", () => {
  expect(parseArgs(["step", "--repo", "o/r", "--dry-run", "--json"]))
    .toEqual({ cmd: "step", repo: "o/r", dryRun: true, json: true, forceStaleLock: false });
});

test("parses `assess --repo o/r --dry-run --json` (#176 think half)", () => {
  expect(parseArgs(["assess", "--repo", "o/r", "--dry-run", "--json"]))
    .toEqual({ cmd: "assess", repo: "o/r", dryRun: true, json: true, forceStaleLock: false });
});

test("parses `run --repo o/r` (#176 do half)", () => {
  expect(parseArgs(["run", "--repo", "o/r"]))
    .toEqual({ cmd: "run", repo: "o/r", dryRun: false, json: false, forceStaleLock: false });
});

test("parses `repos add o/r`", () => {
  expect(parseArgs(["repos", "add", "o/r"])).toEqual({ cmd: "repos", sub: "add", repo: "o/r" });
});

test("parses `repos add o/r opus` (optional per-repo model)", () => {
  expect(parseArgs(["repos", "add", "o/r", "opus"]))
    .toEqual({ cmd: "repos", sub: "add", repo: "o/r", model: "opus" });
});

test("parses bare `step`", () => {
  expect(parseArgs(["step"])).toEqual({ cmd: "step", dryRun: false, json: false, forceStaleLock: false });
});

test("parses `step --repo o/r --issue 5` (single-issue target)", () => {
  expect(parseArgs(["step", "--repo", "o/r", "--issue", "5"]))
    .toEqual({ cmd: "step", repo: "o/r", issue: "5", dryRun: false, json: false, forceStaleLock: false });
});

test("parses `init o/r`", () => {
  expect(parseArgs(["init", "o/r"])).toEqual({ cmd: "init", repo: "o/r" });
});

test("parses bare `status`", () => {
  expect(parseArgs(["status"])).toEqual({ cmd: "status", json: false });
});

test("parses `status --repo o/r --json`", () => {
  expect(parseArgs(["status", "--repo", "o/r", "--json"])).toEqual({ cmd: "status", repo: "o/r", json: true });
});

test("parses `step --repo o/r --force-stale-lock`", () => {
  expect(parseArgs(["step", "--repo", "o/r", "--force-stale-lock"]))
    .toEqual({ cmd: "step", repo: "o/r", dryRun: false, json: false, forceStaleLock: true });
});

test("stepRepos skips a locked repo, runs the rest, and reports exit code 4 (lock conflict)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-steprepos-"));
  const lock = new StepLock(dir);
  // Hold the lock on o/a with a live pid so acquire() fails fast for it.
  const held = lock.acquire("o/a");

  const ran: string[] = [];
  const errs: string[] = [];
  const exitCode = await stepRepos({
    repos: ["o/a", "o/b"],
    lock,
    rawCmd: "step",
    json: true,
    runOne: async (repo) => { ran.push(repo); },
    err: (m) => errs.push(m),
  });

  // o/a is locked → skipped; o/b still runs.
  expect(ran).toEqual(["o/b"]);
  // structured repo_locked error emitted for the locked repo.
  expect(errs.some((e) => e.includes("repo_locked") && e.includes("o/a"))).toBe(true);
  // a lock conflict surfaces as exit code 4 (distinct from runtime/usage/agent errors).
  expect(exitCode).toBe(4);

  held();
  rmSync(dir, { recursive: true, force: true });
});

test("stepRepos releases the lock after a repo finishes so it can re-run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-steprepos-"));
  const lock = new StepLock(dir);

  const ran: string[] = [];
  const code1 = await stepRepos({ repos: ["o/a"], lock, rawCmd: "step", runOne: async (r) => { ran.push(r); } });
  // lock must be free now — a second run acquires cleanly.
  const code2 = await stepRepos({ repos: ["o/a"], lock, rawCmd: "step", runOne: async (r) => { ran.push(r); } });

  expect(ran).toEqual(["o/a", "o/a"]);
  expect(code1).toBe(0);
  expect(code2).toBe(0);

  rmSync(dir, { recursive: true, force: true });
});

import { formatBacklog, formatMissingBacklog, missingBacklog } from "../src/cli/backlog.js";
import type { BacklogSnapshot } from "../src/types.js";

test("formatBacklog renders header + ranked lines with priority, rationale, blockers", () => {
  const snap: BacklogSnapshot = {
    generatedAt: "1970-01-01T00:00:00.000Z",
    repo: "o/r",
    rankedOf: { ranked: 2, open: 3 },
    entries: [
      { number: 2, title: "c", priority: "soon", rationale: "advancing: panel" },
      { number: 1, title: "a", priority: "later", rationale: "no action this tick", blockedBy: ["o/r#9"], fails: 2 },
    ],
  };
  const out = formatBacklog(snap);
  expect(out).toContain("o/r");
  expect(out).toContain("ranked 2 of 3");
  expect(out).toContain("[soon] #2 c");
  expect(out).toContain("[later] #1 a");
  expect(out).toContain("blocked: o/r#9");
  expect(out).toContain("fails: 2");
});

test("#139 missing backlog snapshot renders an actionable hint", () => {
  const missing = missingBacklog("o/r", false);
  const out = formatMissingBacklog(missing);
  expect(missing).toEqual({
    repo: "o/r",
    error: "missing_backlog_snapshot",
    tracked: false,
    hint: "run monastery repos add o/r, then monastery backlog --repo o/r",
  });
  expect(out).toContain("not tracked or has no backlog snapshot");
  expect(out).toContain("monastery repos add o/r");
});

test("summarize surfaces awaiting-your-👍 count when a repo has items blocked on the human (#88)", () => {
  const r = (repo: string, awaiting: number) => ({
    repo, advanced: 0, failed: 0, idle: true, nextPollMs: 60000,
    waiting: awaiting > 0 ? [{ on: "human" as const, count: awaiting }] : [],
  });
  expect(summarize([r("o/a", 2)])).toContain("awaiting-your-👍=2");
  expect(summarize([r("o/b", 0)])).not.toContain("awaiting-your-👍");
});

test("#125 summarize surfaces failed count", () => {
  const out = summarize([{ repo: "o/r", advanced: 0, failed: 2, idle: true, nextPollMs: 60000, waiting: [] }]);
  expect(out).toContain("failed=2");
});

test("#125 step exit code is non-zero for batch and single-issue failures", () => {
  expect(stepExitCode(0, [{ repo: "o/r", advanced: 0, failed: 1, idle: true, nextPollMs: 60000, waiting: [] }])).toBe(1);
  expect(stepExitCode(0, [], { kind: "failed", error: "label not found" })).toBe(1);
  expect(stepExitCode(0, [], { kind: "partial", warning: "relabel: label not found", applied: 1, failed: 1 })).toBe(0);
  expect(stepExitCode(4, [], { kind: "noop" })).toBe(4);
});

test("#126 step preflight initializes labels and thesis for a repos-add-only repo", async () => {
  const gh = new FakeGitHub({ thesis: "", issues: [] });
  const logs: string[] = [];
  await prepareRepoForStep(gh, "o/r", { log: (line) => logs.push(line) });
  expect(gh.ensuredLabels.map((l) => l.name).sort()).toEqual(LABEL_DEFS.map((l) => l.name).sort());
  expect(gh.files[THESIS_PATH]).toContain("Thesis");
  expect(logs.join("\n")).toContain("initialized o/r");
});

test("#148 a dry-run step does NOT pollute the labels-ensured cache (dry-run never really creates labels)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-"));
  const store = new Store(dir);
  const inner = new FakeGitHub({ thesis: "T", issues: [], files: { ".monastery/thesis.md": "t" } });

  // dry-run: ensureLabel only records intent, so the cache must stay unmarked
  await prepareRepoForStep(new DryRunAdapter(inner), "o/r", { cache: store, dryRun: true });
  expect(store.ensuredLabelsFingerprint("o/r")).toBeUndefined();

  // a real step DOES record it (and a later real step can then skip)
  await prepareRepoForStep(inner, "o/r", { cache: store, dryRun: false });
  expect(store.ensuredLabelsFingerprint("o/r")).toBe(labelsFingerprint());

  rmSync(dir, { recursive: true, force: true });
});

import { formatPending } from "../src/cli/backlog.js";

test("formatPending lists awaiting-approval items with a direct 👍 link + kind (#90)", () => {
  const out = formatPending([
    { repo: "o/r", number: 7, title: "feat", approvalKind: "implement", approvalCommentId: "999" },
  ]);
  expect(out).toContain("#7 feat");
  expect(out).toContain("implement");
  expect(out).toContain("o/r/issues/7#issuecomment-999"); // direct 👍 link
});

test("formatPending: nothing awaiting → friendly message", () => {
  expect(formatPending([])).toContain("nothing awaiting");
});

test("parses `pending --repo o/r --json`", () => {
  expect(parseArgs(["pending", "--repo", "o/r", "--json"])).toEqual({ cmd: "pending", repo: "o/r", json: true });
});
