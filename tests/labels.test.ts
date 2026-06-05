// tests/labels.test.ts
import { expect, test } from "vitest";
import { STATE_PREFIX, stateLabel, macroStateOf, THESIS, NEEDS_APPROVAL, APPROVED } from "../src/github/labels.js";

test("stateLabel builds the namespaced single-value label", () => {
  expect(stateLabel("new")).toBe("monastery/state:new");
  expect(STATE_PREFIX).toBe("monastery/state:");
});

test("macroStateOf reads the state label, or 'new' when absent (virtual new)", () => {
  expect(macroStateOf(["monastery/state:triaged", "thesis:in"])).toBe("triaged");
  expect(macroStateOf(["thesis:out"])).toBe("new"); // no state label => virtual new
});

test("action label constants", () => {
  expect(THESIS.out).toBe("thesis:out");
  expect(NEEDS_APPROVAL).toBe("monastery:needs-approval");
  expect(APPROVED).toBe("monastery:approved");
});
