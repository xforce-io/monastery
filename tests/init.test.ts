import { expect, test } from "vitest";
import { FakeGitHub } from "../src/github/fake.js";
import { initRepo, THESIS_PATH } from "../src/engine/init.js";
import { LABEL_DEFS } from "../src/github/labels.js";

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
