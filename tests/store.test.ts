// tests/store.test.ts
import { expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "monastery-"));
  return { store: new Store(dir), dir };
}

// --- config.json: repos { "<owner>/<repo>": { model } } (non-disposable) ---

test("repos: add, list, default empty; addRepo is idempotent", () => {
  const { store, dir } = tmpStore();
  expect(store.listRepos()).toEqual([]);
  store.addRepo("owner/monastery");
  store.addRepo("owner/monastery"); // idempotent
  expect(store.listRepos()).toEqual(["owner/monastery"]);
  store.removeRepo("owner/monastery");
  expect(store.listRepos()).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("repos: persisted to config.json at root, survives a fresh Store", () => {
  const { store, dir } = tmpStore();
  store.addRepo("owner/monastery", { model: "opus" });
  expect(existsSync(join(dir, "config.json"))).toBe(true);
  expect(new Store(dir).listRepos()).toEqual(["owner/monastery"]);
  rmSync(dir, { recursive: true, force: true });
});

test("repoModel: returns configured per-repo model, undefined when unset", () => {
  const { store, dir } = tmpStore();
  expect(store.repoModel("owner/monastery")).toBeUndefined();
  store.addRepo("owner/monastery", { model: "opus" });
  expect(store.repoModel("owner/monastery")).toBe("opus");
  // adding again without policy keeps the existing model
  store.addRepo("owner/monastery");
  expect(store.repoModel("owner/monastery")).toBe("opus");
  // adding again with a new policy overrides
  store.addRepo("owner/monastery", { model: "sonnet" });
  expect(store.repoModel("owner/monastery")).toBe("sonnet");
  rmSync(dir, { recursive: true, force: true });
});

// --- per-repo cache.json under repos/<owner>__<repo>/ (disposable) ---

test("cursor: read missing returns 0, write then read round-trips, persists per-repo", () => {
  const { store, dir } = tmpStore();
  expect(store.getCursor("owner/monastery")).toBe(0);
  store.setCursor("owner/monastery", 123);
  expect(store.getCursor("owner/monastery")).toBe(123);
  expect(existsSync(join(dir, "repos", "owner__monastery", "cache.json"))).toBe(true);
  expect(new Store(dir).getCursor("owner/monastery")).toBe(123);
  rmSync(dir, { recursive: true, force: true });
});

test("fail counter: record increments, failCount reads, clear resets, persists per-repo", () => {
  const { store, dir } = tmpStore();
  expect(store.failCount("o/r", 1)).toBe(0);
  expect(store.recordFail("o/r", 1)).toBe(1);
  expect(store.recordFail("o/r", 1)).toBe(2);
  expect(store.failCount("o/r", 1)).toBe(2);
  expect(new Store(dir).failCount("o/r", 1)).toBe(2); // persisted
  store.clearFail("o/r", 1);
  expect(store.failCount("o/r", 1)).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("cursor and fails are isolated per repo", () => {
  const { store, dir } = tmpStore();
  store.setCursor("a/x", 10);
  store.setCursor("b/y", 20);
  store.recordFail("a/x", 1);
  expect(store.getCursor("a/x")).toBe(10);
  expect(store.getCursor("b/y")).toBe(20);
  expect(store.failCount("a/x", 1)).toBe(1);
  expect(store.failCount("b/y", 1)).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("cache is disposable: deleting a repo's cache dir resets it but keeps config", () => {
  const { store, dir } = tmpStore();
  store.addRepo("owner/monastery", { model: "opus" });
  store.setCursor("owner/monastery", 99);
  rmSync(join(dir, "repos", "owner__monastery"), { recursive: true, force: true });
  const fresh = new Store(dir);
  expect(fresh.getCursor("owner/monastery")).toBe(0); // cache gone → rebuilt empty
  expect(fresh.repoModel("owner/monastery")).toBe("opus"); // config intact
  rmSync(dir, { recursive: true, force: true });
});
