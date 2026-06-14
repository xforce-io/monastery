import { expect, test } from "vitest";
import { FakeGitHub } from "../src/github/fake.js";
import { initRepo, THESIS_PATH } from "../src/engine/init.js";
import { LABEL_DEFS, labelsFingerprint } from "../src/github/labels.js";

// An in-memory LabelEnsureCache for the per-tick skip path (#148).
function fakeCache(seed: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    ensuredLabelsFingerprint: (r: string) => m.get(r),
    setEnsuredLabelsFingerprint: (r: string, fp: string) => { m.set(r, fp); },
    get: (r: string) => m.get(r),
  };
}

test("init ensures the full label set and scaffolds thesis when absent", async () => {
  const gh = new FakeGitHub({ thesis: "", issues: [] });
  const r = await initRepo(gh, "o/r");
  expect(r.labels).toBe(LABEL_DEFS.length);
  expect(gh.ensuredLabels.map((l) => l.name).sort()).toEqual(LABEL_DEFS.map((l) => l.name).sort());
  expect(r.thesisCreated).toBe(true);
  expect(gh.files[THESIS_PATH]).toContain("Thesis");
});

test("init does not overwrite an existing thesis", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [], files: { ".monastery/thesis.md": "my real thesis" } });
  const r = await initRepo(gh, "o/r");
  expect(r.thesisCreated).toBe(false);
  expect(gh.files[THESIS_PATH]).toBe("my real thesis");
});

// --- #148: keep ensureLabel off the per-tick critical path via a fingerprint cache ---

test("skips the ensureLabel calls when the cached fingerprint already matches the label set", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [], files: { ".monastery/thesis.md": "t" } });
  const cache = fakeCache({ "o/r": labelsFingerprint() });
  const r = await initRepo(gh, "o/r", { cache });
  expect(gh.ensuredLabels).toEqual([]); // no label API calls hit the network this tick
  expect(r.labelsEnsured).toBe(false);
});

test("ensures all labels and records the fingerprint on the first run (empty cache)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [], files: { ".monastery/thesis.md": "t" } });
  const cache = fakeCache();
  const r = await initRepo(gh, "o/r", { cache });
  expect(gh.ensuredLabels.length).toBe(LABEL_DEFS.length);
  expect(r.labelsEnsured).toBe(true);
  expect(cache.get("o/r")).toBe(labelsFingerprint()); // marked ensured for future ticks
});

test("re-ensures when the cached fingerprint is stale (label set changed)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [], files: { ".monastery/thesis.md": "t" } });
  const cache = fakeCache({ "o/r": "stale-fingerprint" });
  const r = await initRepo(gh, "o/r", { cache });
  expect(gh.ensuredLabels.length).toBe(LABEL_DEFS.length);
  expect(r.labelsEnsured).toBe(true);
  expect(cache.get("o/r")).toBe(labelsFingerprint());
});

test("force re-ensures even when the fingerprint matches (explicit `monastery init`)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [], files: { ".monastery/thesis.md": "t" } });
  const cache = fakeCache({ "o/r": labelsFingerprint() });
  const r = await initRepo(gh, "o/r", { cache, force: true });
  expect(gh.ensuredLabels.length).toBe(LABEL_DEFS.length);
  expect(r.labelsEnsured).toBe(true);
});

test("does NOT record the fingerprint when an ensureLabel call fails (so the next tick retries)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [], files: { ".monastery/thesis.md": "t" } });
  gh.ensureLabel = async () => { throw new Error("transient boom"); };
  const cache = fakeCache();
  await expect(initRepo(gh, "o/r", { cache })).rejects.toThrow(/boom/);
  expect(cache.get("o/r")).toBeUndefined(); // not marked — a later tick will re-attempt
});

test("labelsFingerprint changes when the label set changes", () => {
  const base = labelsFingerprint();
  expect(labelsFingerprint()).toBe(base); // stable
  expect(labelsFingerprint([{ name: "x", color: "fff", description: "d" }])).not.toBe(base);
});
