// tests/deps.test.ts — parse cross-repo stake declarations from an issue body (P0: `Depends-on: owner/repo#N`).
import { expect, test } from "vitest";
import { parseDeps } from "../src/engine/deps.js";

test("parses `Depends-on: owner/repo#N` lines (case-insensitive), dedups", () => {
  const body = [
    "We need the upstream fix first.",
    "Depends-on: xforce-io/monastery#42",
    "depends-on: owner/other#7",
    "Depends-on: xforce-io/monastery#42", // duplicate
  ].join("\n");
  expect(parseDeps(body)).toEqual([
    { repo: "xforce-io/monastery", num: 42 },
    { repo: "owner/other", num: 7 },
  ]);
});

test("returns [] when there are no dependency declarations", () => {
  expect(parseDeps("just a normal issue body, mentions #5 but no Depends-on")).toEqual([]);
  expect(parseDeps("")).toEqual([]);
});

test("ignores malformed refs (missing owner, no number)", () => {
  expect(parseDeps("Depends-on: monastery#42")).toEqual([]); // no owner/
  expect(parseDeps("Depends-on: owner/repo")).toEqual([]);   // no #num
});
