// tests/cli.test.ts
import { expect, test } from "vitest";
import { parseArgs } from "../src/cli/index.js";

test("parses `step --repo o/r --dry-run --json`", () => {
  expect(parseArgs(["step", "--repo", "o/r", "--dry-run", "--json"]))
    .toEqual({ cmd: "step", repo: "o/r", dryRun: true, json: true });
});

test("parses `repos add o/r`", () => {
  expect(parseArgs(["repos", "add", "o/r"])).toEqual({ cmd: "repos", sub: "add", repo: "o/r" });
});

test("parses `repos add o/r opus` (optional per-repo model)", () => {
  expect(parseArgs(["repos", "add", "o/r", "opus"]))
    .toEqual({ cmd: "repos", sub: "add", repo: "o/r", model: "opus" });
});

test("parses bare `step`", () => {
  expect(parseArgs(["step"])).toEqual({ cmd: "step", dryRun: false, json: false });
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
