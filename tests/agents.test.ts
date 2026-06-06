// tests/agents.test.ts — the agent registry: every agent's definition must declare the §3 boundary.
import { expect, test } from "vitest";
import { maintainerSpec } from "../src/agents/maintainer.js";
import { reviewerSpec } from "../src/agents/reviewer.js";
import { patcherSpec } from "../src/agents/patcher.js";
import type { AgentSpec } from "../src/agents/spec.js";

const registry: AgentSpec[] = [maintainerSpec, reviewerSpec, patcherSpec];

test("every agent has an identity + a non-empty persona (the maintainable definition)", () => {
  for (const a of registry) {
    expect(a.name).toBeTruthy();
    expect(a.role).toBeTruthy();
    expect(a.persona.length).toBeGreaterThan(0);
  }
  expect(registry.map((a) => a.name)).toEqual(["maintainer", "reviewer", "patcher"]);
});

test("the no-git/gh boundary (CONSTITUTION §3) is declared in every agent's persona", () => {
  // maintainer: "NO git/gh access"; reviewer: "no GitHub access"; patcher: "Do NOT touch git or gh"
  for (const a of registry) {
    expect(a.persona).toMatch(/no\s+git\/gh|no\s+GitHub\s+access|NOT\s+touch\s+git\s+or\s+gh/i);
  }
});

test("sandboxes are declared explicitly: structured agents are artifact-only; the patcher gets a clone", () => {
  expect(maintainerSpec.sandbox).toBe("artifact-only");
  expect(reviewerSpec.sandbox).toBe("artifact-only");
  expect(patcherSpec.sandbox).toBe("workspace-clone");
});

test("operational policy lives on the spec (the single home for the SLA-ish knobs)", () => {
  expect(maintainerSpec.policy.failThreshold).toBe(3);
  expect(patcherSpec.policy.failThreshold).toBe(3);
  expect(patcherSpec.policy.maxIters).toBe(3);
});
