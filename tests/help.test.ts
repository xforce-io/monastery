// tests/help.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wantsHelp, wantsVersion, usage, readPackageVersion } from "../src/cli/help.js";

test("wantsHelp: bare invocation (no args) wants help", () => {
  expect(wantsHelp([])).toBe(true);
});

test("wantsHelp: top-level --help / -h / help", () => {
  expect(wantsHelp(["--help"])).toBe(true);
  expect(wantsHelp(["-h"])).toBe(true);
  expect(wantsHelp(["help"])).toBe(true);
});

test("wantsHelp: `step --help` short-circuits (regression — must NOT run reconcile)", () => {
  // The #70 high-priority bug: `step` swallowed --help as an unknown flag and ran a full
  // reconcile (hung + held the step lock). Any subcommand's --help/-h must route to help.
  expect(wantsHelp(["step", "--help"])).toBe(true);
  expect(wantsHelp(["step", "-h"])).toBe(true);
  expect(wantsHelp(["status", "--help"])).toBe(true);
});

test("wantsHelp: a real command with real flags does NOT want help", () => {
  expect(wantsHelp(["step"])).toBe(false);
  expect(wantsHelp(["step", "--repo", "o/r", "--dry-run"])).toBe(false);
  expect(wantsHelp(["status", "--json"])).toBe(false);
});

test("wantsVersion: --version / -v / version", () => {
  expect(wantsVersion(["--version"])).toBe(true);
  expect(wantsVersion(["-v"])).toBe(true);
  expect(wantsVersion(["version"])).toBe(true);
  expect(wantsVersion(["step"])).toBe(false);
});

test("usage lists every dispatchable command (single source of truth with README)", () => {
  const out = usage();
  for (const cmd of ["repos", "init", "status", "backlog", "pending", "step"]) {
    expect(out).toContain(cmd);
  }
});

test("usage documents the cross-cutting flags and env vars", () => {
  const out = usage();
  expect(out).toContain("--dry-run");
  expect(out).toContain("--json");
  expect(out).toContain("MONASTERY_MODEL");
  expect(out).toContain("MONASTERY_REVIEW_MODEL");
});

test("readPackageVersion: reads version from the nearest package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-pkg-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "monastery", version: "1.2.3" }));
  // simulate dist/index.js → package.json one level up
  const dist = join(dir, "dist");
  mkdirSync(dist);
  expect(readPackageVersion(dist)).toBe("1.2.3");
  rmSync(dir, { recursive: true, force: true });
});

test("readPackageVersion: falls back to 0.0.0 when no package.json is found", () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-nopkg-"));
  expect(readPackageVersion(dir)).toBe("0.0.0");
  rmSync(dir, { recursive: true, force: true });
});
