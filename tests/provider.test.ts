// tests/provider.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider/fake.js";

test("FakeProvider writes the preset files into artifactDir and returns them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-agent-"));
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"off-thesis"}' });
  const result = await provider.run({ persona: "p", context: "c", artifactDir: dir, model: "haiku" });
  expect(result.artifacts.map((a) => a.split("/").pop())).toContain("verdict.json");
  expect(JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")).verdict).toBe("out");
  rmSync(dir, { recursive: true, force: true });
});
