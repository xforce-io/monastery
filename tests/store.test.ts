// tests/store.test.ts
import { expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("#139 legacy repos.json is merged once then archived", () => {
  const { store, dir } = tmpStore();
  store.addRepo("owner/current", { model: "opus" });
  writeFileSync(join(dir, "repos.json"), JSON.stringify({ repos: ["owner/current", "owner/legacy"] }));

  const cleanup = store.cleanupLegacyReposFile(() => new Date("1970-01-01T00:00:00.000Z"));

  expect(cleanup?.migratedRepos).toEqual(["owner/legacy"]);
  expect(existsSync(join(dir, "repos.json"))).toBe(false);
  expect(existsSync(join(dir, "repos.json.legacy-1970-01-01T00-00-00-000Z"))).toBe(true);
  expect(new Store(dir).listRepos()).toEqual(["owner/current", "owner/legacy"]);
  expect(new Store(dir).repoModel("owner/current")).toBe("opus");
  rmSync(dir, { recursive: true, force: true });
});

test("repoPolicy: returns the full per-repo policy (incl. per-agent overrides), undefined when unset", () => {
  const { store, dir } = tmpStore();
  expect(store.repoPolicy("o/r")).toBeUndefined();
  store.addRepo("o/r", { model: "opus", agents: { maintainer: { failThreshold: 7 } } });
  expect(store.repoPolicy("o/r")).toEqual({ model: "opus", agents: { maintainer: { failThreshold: 7 } } });
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

// --- labels-ensured fingerprint (#148): keep initRepo's ensureLabel calls off the per-tick critical path ---

test("ensuredLabelsFingerprint: missing returns undefined; set then read round-trips; persists per-repo", () => {
  const { store, dir } = tmpStore();
  expect(store.ensuredLabelsFingerprint("o/r")).toBeUndefined();
  store.setEnsuredLabelsFingerprint("o/r", "fp-v1");
  expect(store.ensuredLabelsFingerprint("o/r")).toBe("fp-v1");
  expect(new Store(dir).ensuredLabelsFingerprint("o/r")).toBe("fp-v1"); // persisted across a fresh Store
  expect(store.ensuredLabelsFingerprint("other/repo")).toBeUndefined(); // isolated per repo
  rmSync(dir, { recursive: true, force: true });
});

import type { BacklogSnapshot } from "../src/types.js";

const snap = (repo: string): BacklogSnapshot => ({
  generatedAt: "1970-01-01T00:00:00.000Z",
  repo,
  rankedOf: { ranked: 1, open: 1 },
  entries: [{ number: 1, title: "a", priority: "now", rationale: "r" }],
});

test("backlog: read missing returns null; write then read round-trips; persists per-repo", () => {
  const { store, dir } = tmpStore();
  expect(store.readBacklog("o/r")).toBeNull();
  store.writeBacklog("o/r", snap("o/r"));
  expect(store.readBacklog("o/r")).toEqual(snap("o/r"));
  expect(existsSync(join(dir, "repos", "o__r", "backlog.json"))).toBe(true);
  expect(new Store(dir).readBacklog("o/r")).toEqual(snap("o/r")); // persisted
  rmSync(dir, { recursive: true, force: true });
});

test("backlog is isolated per repo", () => {
  const { store, dir } = tmpStore();
  store.writeBacklog("a/x", snap("a/x"));
  expect(store.readBacklog("a/x")).not.toBeNull();
  expect(store.readBacklog("b/y")).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

// --- repoLanguage: outward-text language policy, three-layer resolution (#76) ---

test("repoLanguage: defaults to en-US when nothing is configured", () => {
  const { store, dir } = tmpStore();
  expect(store.repoLanguage("o/r")).toBe("en-US");
  rmSync(dir, { recursive: true, force: true });
});

test("repoLanguage: per-repo policy.language wins", () => {
  const { store, dir } = tmpStore();
  store.addRepo("o/r", { language: "zh-CN" });
  expect(store.repoLanguage("o/r")).toBe("zh-CN");
  rmSync(dir, { recursive: true, force: true });
});

test("repoLanguage: falls back to defaults.language when the repo has none", () => {
  const { store, dir } = tmpStore();
  // defaults.language is the global layer (config.json top-level); write it directly.
  writeFileSync(join(dir, "config.json"), JSON.stringify({ defaults: { language: "zh-CN" }, repos: { "o/r": {} } }));
  expect(store.repoLanguage("o/r")).toBe("zh-CN");
  // and the repo layer still overrides the default
  writeFileSync(join(dir, "config.json"), JSON.stringify({ defaults: { language: "zh-CN" }, repos: { "o/r": { language: "en-US" } } }));
  expect(store.repoLanguage("o/r")).toBe("en-US");
  rmSync(dir, { recursive: true, force: true });
});
