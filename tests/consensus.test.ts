// tests/consensus.test.ts — consensus is computed from append-only versioned spec + endorse comments.
import { expect, test } from "vitest";
import { currentSpec, parseEndorsements, consensusReached } from "../src/shell/consensus.js";

const specComment = (version: number, parties: string[], body: string, author = "a-bot") =>
  ({ body: `<!--monastery-spec version=${version} parties=${parties.join(",")}-->\n${body}`, author });
const endorseComment = (version: number, author: string) =>
  ({ body: `looks good\n<!--monastery-endorse version=${version}-->`, author });

test("currentSpec = the highest-version spec comment (parsed: version, parties, body)", () => {
  const comments = [
    specComment(1, ["a-bot", "b-bot"], "first draft"),
    { body: "a human comment", author: "alice" },
    specComment(2, ["a-bot", "b-bot"], "revised draft"),
  ];
  expect(currentSpec(comments)).toEqual({ version: 2, parties: ["a-bot", "b-bot"], body: "revised draft" });
  expect(currentSpec([{ body: "no spec here", author: "x" }])).toBeNull();
});

test("parseEndorsements: endorser identity is the comment AUTHOR (reuses #51), version from the marker", () => {
  const comments = [
    endorseComment(2, "a-bot"),
    endorseComment(1, "b-bot"), // stale version
    { body: "no marker", author: "alice" },
  ];
  expect(parseEndorsements(comments)).toEqual([
    { version: 2, by: "a-bot" },
    { version: 1, by: "b-bot" },
  ]);
});

test("consensusReached = every party of the CURRENT spec has endorsed its version", () => {
  const base = [specComment(2, ["a-bot", "b-bot"], "agreed plan")];
  expect(consensusReached(base)).toBe(false);                                   // nobody endorsed
  expect(consensusReached([...base, endorseComment(2, "a-bot")])).toBe(false);  // only one party
  expect(consensusReached([...base, endorseComment(2, "a-bot"), endorseComment(2, "b-bot")])).toBe(true);
  // an endorsement of an OLD version doesn't count toward the current one
  expect(consensusReached([...base, endorseComment(2, "a-bot"), endorseComment(1, "b-bot")])).toBe(false);
});

test("consensusReached is false when there is no spec, or the spec lists no parties", () => {
  expect(consensusReached([endorseComment(1, "a-bot")])).toBe(false);            // no spec
  expect(consensusReached([specComment(1, [], "plan"), endorseComment(1, "a-bot")])).toBe(false); // no parties
});
