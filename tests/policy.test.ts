// tests/policy.test.ts — policy layering: spec defaults <- per-repo override.
import { expect, test } from "vitest";
import { resolvePolicy, effectivePolicy, type StructuredAgentSpec } from "../src/agents/spec.js";

test("resolvePolicy: per-field override wins; unset fields keep the base default", () => {
  const base = { model: "sonnet", failThreshold: 3, maxIters: 3 };
  expect(resolvePolicy(base, undefined)).toEqual(base);                       // no override -> base
  expect(resolvePolicy(base, {})).toEqual(base);                             // empty override -> base
  expect(resolvePolicy(base, { failThreshold: 5 })).toEqual({ model: "sonnet", failThreshold: 5, maxIters: 3 });
  expect(resolvePolicy(base, { model: "opus", maxIters: 1 })).toEqual({ model: "opus", failThreshold: 3, maxIters: 1 });
});

test("effectivePolicy: applies a repo's per-agent override onto the spec's defaults, by agent name", () => {
  const spec = { name: "maintainer", policy: { failThreshold: 3 } } as StructuredAgentSpec<unknown, unknown>;
  expect(effectivePolicy(spec, undefined).failThreshold).toBe(3);            // no repo policy
  expect(effectivePolicy(spec, { agents: {} }).failThreshold).toBe(3);      // no entry for this agent
  expect(effectivePolicy(spec, { agents: { maintainer: { failThreshold: 7 } } }).failThreshold).toBe(7);
  expect(effectivePolicy(spec, { agents: { patcher: { failThreshold: 9 } } }).failThreshold).toBe(3); // other agent's override doesn't apply
});
