// tests/markers.test.ts — the single source of truth for "machine vs human" comment identity (#97).
import { expect, test } from "vitest";
import { isHumanComment, isMonasteryComment } from "../src/shell/markers.js";

test("isMonasteryComment: true for any monastery-marked comment body", () => {
  expect(isMonasteryComment("<!--monastery-state\nprotocol: note\n-->\nx")).toBe(true);
  expect(isMonasteryComment("<!--monastery-spec version=1 parties=a-->\nplan")).toBe(true);
  expect(isMonasteryComment("ack\n\n<!--monastery-reply to=ext0-->")).toBe(true);
});

test("isMonasteryComment: false for plain human text (no marker)", () => {
  expect(isMonasteryComment("just a human comment")).toBe(false);
  expect(isMonasteryComment("ApiProvider 配置在哪里进行")).toBe(false);
});

test("isHumanComment: inverse of isMonasteryComment", () => {
  expect(isHumanComment({ body: "hi there" })).toBe(true);
  expect(isHumanComment({ body: "<!--monastery-reply to=5-->" })).toBe(false);
});
