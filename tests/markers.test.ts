// tests/markers.test.ts — the single source of truth for "machine vs human" comment identity (#97).
import { expect, test } from "vitest";
import { isHumanComment, isMonasteryComment, renderMarker, parseMarkers, hasMarker } from "../src/shell/markers.js";
import { approvalKind, approvalSpecVersion, isStateMessage, parseStateMessage, renderStateMessage, stripStateMessage } from "../src/shell/messages.js";

test("#154 class-B render→parse round-trips fields", () => {
  expect(renderMarker("reply", { to: "C_123" })).toBe("<!--monastery-reply to=C_123-->");
  expect(renderMarker("rework", { round: 2, committed: "true" })).toBe("<!--monastery-rework round=2 committed=true-->");
  expect(renderMarker("impl-rejected")).toBe("<!--monastery-impl-rejected-->");
  expect(parseMarkers("ack\n\n<!--monastery-reply to=C_123-->", "reply")).toEqual([{ to: "C_123" }]);
});

test("#154 class-B hasMarker matches by EXACT field — to=C_123 does not misfire on to=C_1234", () => {
  const body = "<!--monastery-reply to=C_1234-->";
  expect(hasMarker(body, "reply", { to: "C_123" })).toBe(false); // the headline substring misfire is gone
  expect(hasMarker(body, "reply", { to: "C_1234" })).toBe(true);
  // numeric ids are coerced to their string form for the comparison
  expect(hasMarker("<!--monastery-impl-rejected pr=12-->", "impl-rejected", { pr: 120 })).toBe(false);
  expect(hasMarker("<!--monastery-impl-rejected pr=12-->", "impl-rejected", { pr: 12 })).toBe(true);
});

test("#154 class-B reads `committed` by field, not the `committed=true` substring", () => {
  const committed = "<!--monastery-rework round=1 committed=true-->\npushed but summary failed";
  const plain = "<!--monastery-rework round=1-->\n🔁 round 1";
  expect(parseMarkers(committed, "rework")[0]).toEqual({ round: "1", committed: "true" });
  expect(parseMarkers(plain, "rework")[0]).toEqual({ round: "1" });
  expect(parseMarkers(plain, "rework")[0].committed).toBeUndefined(); // no false `committed=true` hit
});

test("#154 class-B hasMarker without fields just tests presence; counts via parseMarkers", () => {
  const thread = "<!--monastery-rework round=1-->\n<!--monastery-rework round=2-->";
  expect(hasMarker(thread, "rework")).toBe(true);
  expect(hasMarker("no markers here", "rework")).toBe(false);
  expect(parseMarkers(thread, "rework").length).toBe(2);
});

test("#149 `rework-gatelink` and `rework` never collide (a longer name can't bleed into a shorter one)", () => {
  // Load-bearing: the PR cross-link pointer (rework-gatelink) must NOT be counted by runRework's per-PR round
  // budget, which scans hasMarker(body, "rework"). And a real rework round must not look like a gatelink.
  const gatelink = renderMarker("rework-gatelink");
  const round = renderMarker("rework", { round: 2 });
  expect(hasMarker(gatelink, "rework")).toBe(false);
  expect(hasMarker(gatelink, "rework-gatelink")).toBe(true);
  expect(hasMarker(round, "rework-gatelink")).toBe(false);
  expect(hasMarker(round, "rework")).toBe(true);
});

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
