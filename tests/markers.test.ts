// tests/markers.test.ts — the single source of truth for "machine vs human" comment identity (#97).
import { expect, test } from "vitest";
import { isHumanComment, isMonasteryComment } from "../src/shell/markers.js";
import { approvalKind, approvalSpecVersion, isStateMessage, parseStateMessage, renderStateMessage, stripStateMessage } from "../src/shell/messages.js";

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

test("#144 state messages render and parse the v1 envelope", () => {
  const body = renderStateMessage({ status: "awaiting-approval", action: "implement", spec: 2, agent: "maintainer", model: "opus", body: "## Plan" });

  expect(body).toContain("v: 1");
  expect(body).toContain("kind: approval");          // derived from status
  expect(body).toContain("status: awaiting-approval");
  expect(body).toContain("agent: maintainer");
  expect(body).toContain("model: opus");
  expect(body).toContain("protocol: approval"); // v0 readers stay compatible
  expect(body).toContain("NEEDS YOUR APPROVAL"); // #90 banner now auto-prepended as the visible head
  expect(isStateMessage(body, "approval")).toBe(true);
  expect(parseStateMessage(body)).toMatchObject({ kind: "approval", action: "implement", spec: 2, status: "awaiting-approval", agent: "maintainer", model: "opus" });
  expect(approvalKind(body)).toBe("implement");
  expect(approvalSpecVersion(body)).toBe(2);
  expect(stripStateMessage(body)).toContain("## Plan"); // head + body, banner prepended
});

test("#144 state parser remains compatible with v0 monastery-state comments", () => {
  const body = "<!--monastery-state\nprotocol: approval\naction: rework\nspec: 3\n-->\n⏳ old gate";

  expect(parseStateMessage(body)).toMatchObject({ kind: "approval", action: "rework", spec: 3, body: "⏳ old gate" });
  expect(isStateMessage("<!--monastery-state\nprotocol: note\n-->\nold note", "note")).toBe(true);
});
