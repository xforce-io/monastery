// tests/labels.test.ts
import { expect, test } from "vitest";
import { THESIS, NEEDS_APPROVAL, DECLINED, LABEL_DEFS } from "../src/github/labels.js";

test("control + display label constants", () => {
  expect(THESIS.out).toBe("thesis:out");
  expect(NEEDS_APPROVAL).toBe("monastery:needs-approval");
  expect(DECLINED).toBe("monastery:declined");
});

test("LABEL_DEFS no longer carries the retired monastery/state:* rich-lifecycle labels (PROTOCOL §2)", () => {
  expect(LABEL_DEFS.some((d) => d.name.startsWith("monastery/state:"))).toBe(false);
  // the two control labels the shell routes on are present
  expect(LABEL_DEFS.some((d) => d.name === NEEDS_APPROVAL)).toBe(true);
  expect(LABEL_DEFS.some((d) => d.name === DECLINED)).toBe(true);
});
