// tests/consensus.test.ts — consensus: versioned spec comments + endorsement via 👍 reaction (#92).
import { expect, test } from "vitest";
import { currentSpec, parseEndorsements, consensusReached } from "../src/shell/consensus.js";

const specComment = (version: number, parties: string[], body: string, author = "a-bot", id = `spec${version}`) =>
  ({ id, body: `<!--monastery-spec version=${version} parties=${parties.join(",")}-->\n${body}`, author });
const endorseComment = (version: number, author: string, id = `end${version}-${author}`) =>
  ({ id, body: `looks good\n<!--monastery-endorse version=${version}-->`, author });

test("currentSpec = the highest-version spec comment (version, parties, body, id)", () => {
  const comments = [
    specComment(1, ["a-bot", "b-bot"], "first draft", "a-bot", "s1"),
    { id: "h1", body: "a human comment", author: "alice" },
    specComment(2, ["a-bot", "b-bot"], "revised draft", "a-bot", "s2"),
  ];
  expect(currentSpec(comments)).toEqual({ version: 2, parties: ["a-bot", "b-bot"], body: "revised draft", id: "s2" });
  expect(currentSpec([{ id: "x", body: "no spec here", author: "x" }])).toBeNull();
});

test("parseEndorsements (still used by the endorse action's dedup): identity is the comment author", () => {
  const comments = [
    endorseComment(2, "a-bot"),
    endorseComment(1, "b-bot"),
    { id: "h", body: "no marker", author: "alice" },
  ];
  expect(parseEndorsements(comments)).toEqual([
    { version: 2, by: "a-bot" },
    { version: 1, by: "b-bot" },
  ]);
});

test("consensusReached = every party of the spec is among the endorsers (from spec 👍 reactions, #92)", () => {
  const spec = currentSpec([specComment(2, ["a-bot", "b-bot"], "agreed plan")]);
  expect(consensusReached(spec, [])).toBe(false);                    // nobody endorsed
  expect(consensusReached(spec, ["a-bot"])).toBe(false);             // only one party
  expect(consensusReached(spec, ["a-bot", "b-bot"])).toBe(true);     // both parties 👍'd the spec
  expect(consensusReached(spec, ["a-bot", "b-bot", "x"])).toBe(true); // extra endorsers are harmless
});

test("consensusReached is false when there is no spec, or the spec lists no parties", () => {
  expect(consensusReached(null, ["a-bot"])).toBe(false);                          // no spec
  const noParties = currentSpec([specComment(1, [], "plan")]);
  expect(consensusReached(noParties, ["a-bot"])).toBe(false);                     // no parties
});
