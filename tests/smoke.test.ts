import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../src/index.js";

test("package loads and VERSION matches package.json (no drift)", () => {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  expect(VERSION).toBe(pkg.version);
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/); // a real, publishable semver — not 0.0.0
});
