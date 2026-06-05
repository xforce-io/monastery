// tests/store.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "monastery-"));
  return { store: new Store(dir), dir };
}

test("repos: add, list, default empty", () => {
  const { store, dir } = tmpStore();
  expect(store.listRepos()).toEqual([]);
  store.addRepo("owner/monastery");
  store.addRepo("owner/monastery"); // idempotent
  expect(store.listRepos()).toEqual(["owner/monastery"]);
  rmSync(dir, { recursive: true, force: true });
});

test("cursor: read missing returns 0, write then read round-trips, disposable", () => {
  const { store, dir } = tmpStore();
  expect(store.getCursor("owner/monastery")).toBe(0);
  store.setCursor("owner/monastery", 123);
  expect(store.getCursor("owner/monastery")).toBe(123);
  // a fresh Store over the same dir sees the persisted cursor
  expect(new Store(dir).getCursor("owner/monastery")).toBe(123);
  rmSync(dir, { recursive: true, force: true });
});
