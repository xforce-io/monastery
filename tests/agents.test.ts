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

test("the patcher is an R&D engineer: both personas carry its methodology (§12)", () => {
  // patcher=研发: smallest correct change, TDD, no gold-plating, expose assumptions.
  for (const persona of [patcherSpec.persona, patcherSpec.fixPersona]) {
    expect(persona).toMatch(/smallest/i);                 // minimal correct change
    expect(persona).toMatch(/\bTDD\b|test/i);             // think about the test first
    expect(persona).toMatch(/assumption|uncertain/i);     // surface assumptions / uncertainty
    expect(persona).toMatch(/gold-?plat|only what|scope/i); // no gold-plating: only what the issue asks
  }
});

test("the reviewer is an architect/QA: the persona carries its judgment criteria (§12)", () => {
  // reviewer=架构/QA: intent, correctness, security, simplicity — and blocking vs advisory.
  const persona = reviewerSpec.persona;
  expect(persona).toMatch(/architect|QA/i);    // the role
  expect(persona).toMatch(/intent/i);          // does it match the issue's intent
  expect(persona).toMatch(/correctness/i);     // correctness
  expect(persona).toMatch(/security/i);        // security
  expect(persona).toMatch(/simpl/i);           // simplicity
  expect(persona).toMatch(/blocking/i);        // the blocking vs advisory distinction
  expect(persona).toMatch(/advisory/i);
});
