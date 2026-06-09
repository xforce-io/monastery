// tests/phase-logger.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhaseLogger } from "../src/phase-logger.js";

test("phase() then done() emit :start and :done human lines with elapsed to stderr", () => {
  const err: string[] = [];
  let t = 1000;
  const log = new PhaseLogger({ repo: "owner/repo", issue: 73, json: false, now: () => t, err: (l) => err.push(l) });
  const p = log.phase("review", { attempt: "2/3", model: "sonnet" });
  t = 5500; // 4.5s later
  p.done();
  expect(err[0]).toBe("[monastery] owner/repo#73 review:start attempt=2/3 model=sonnet");
  expect(err[1]).toBe("[monastery] owner/repo#73 review:done 4.5s");
});

test("fail() emits a :fail human line with elapsed and reason", () => {
  const err: string[] = [];
  let t = 0;
  const log = new PhaseLogger({ repo: "o/r", issue: 5, json: false, now: () => t, err: (l) => err.push(l) });
  const p = log.phase("patch");
  t = 2000;
  p.fail("timeout");
  expect(err[1]).toBe("[monastery] o/r#5 patch:fail 2.0s reason=timeout");
});

test("json mode emits NDJSON events to stdout, human lines still on stderr", () => {
  const out: string[] = [];
  const err: string[] = [];
  let t = 1000;
  const log = new PhaseLogger({ repo: "owner/repo", issue: 73, json: true, now: () => t,
    out: (l) => out.push(l), err: (l) => err.push(l) });
  const p = log.phase("review", { attempt: "2/3" });
  t = 5500;
  p.done({ findings: 0 });
  expect(err.length).toBe(2); // human start+done still go to stderr
  expect(JSON.parse(out[0])).toMatchObject({ ts: 1000, repo: "owner/repo", issue: 73, phase: "review", status: "start", attempt: "2/3" });
  expect(JSON.parse(out[1])).toMatchObject({ ts: 5500, phase: "review", status: "done", durationMs: 4500, findings: 0 });
});

test("non-json mode emits no NDJSON to stdout", () => {
  const out: string[] = [];
  const log = new PhaseLogger({ repo: "o/r", issue: 1, json: false, now: () => 0, out: (l) => out.push(l), err: () => {} });
  log.phase("clone").done();
  expect(out).toEqual([]);
});

test("writes a snapshot on each phase boundary; fail leaves a tombstone", () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-progress-"));
  const path = join(dir, "step.progress");
  let t = 1000;
  const log = new PhaseLogger({ repo: "owner/repo", issue: 73, json: false, now: () => t, progressPath: path, err: () => {} });
  const p = log.phase("patch", { attempt: "1/3" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    issue: 73, phase: "patch", status: "start", attempt: "1/3", since: 1000, pid: process.pid,
  });
  t = 3000;
  p.fail("timeout");
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ phase: "patch", status: "fail", reason: "timeout", since: 1000 });
  rmSync(dir, { recursive: true, force: true });
});

test("done() does not delete the snapshot (next phase overwrites it)", () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-progress-"));
  const path = join(dir, "step.progress");
  const log = new PhaseLogger({ repo: "o/r", issue: 2, json: false, now: () => 0, progressPath: path, err: () => {} });
  log.phase("clone").done();
  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ phase: "clone", status: "done" });
  rmSync(dir, { recursive: true, force: true });
});

test("a snapshot write failure never throws (observability must not crash the step)", () => {
  const log = new PhaseLogger({ repo: "o/r", issue: 1, json: false, now: () => 0,
    progressPath: "/nonexistent-dir-xyz-123/step.progress", err: () => {} });
  expect(() => log.phase("clone").done()).not.toThrow();
});
