// tests/entrypoint.test.ts
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isEntrypoint } from "../src/cli/index.js";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "entrypoint-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

test("direct invocation: argv1 === resolved module path → true", () => {
  const d = scratch();
  const real = join(d, "index.js");
  writeFileSync(real, "");
  expect(isEntrypoint(pathToFileURL(real).href, real)).toBe(true);
});

test("symlink invocation: argv1 is a symlink to the module → true (regression for #106)", () => {
  const d = scratch();
  const real = join(d, "index.js");
  writeFileSync(real, "");
  const link = join(d, "monastery");
  symlinkSync(real, link);
  // process.argv[1] would be the symlink path; import.meta.url resolves to the real file.
  expect(isEntrypoint(pathToFileURL(real).href, link)).toBe(true);
});

test("undefined argv1 (module imported by tests) → false", () => {
  expect(isEntrypoint(pathToFileURL("/some/index.js").href, undefined)).toBe(false);
});

test("path mismatch: argv1 is a different real file → false", () => {
  const d = scratch();
  const a = join(d, "index.js");
  const b = join(d, "other.js");
  writeFileSync(a, "");
  writeFileSync(b, "");
  expect(isEntrypoint(pathToFileURL(a).href, b)).toBe(false);
});

test("non-existent argv1: realpath throws → false (no crash)", () => {
  const d = scratch();
  const real = join(d, "index.js");
  writeFileSync(real, "");
  expect(isEntrypoint(pathToFileURL(real).href, join(d, "does-not-exist"))).toBe(false);
});
