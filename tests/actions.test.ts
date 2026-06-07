import { expect, test } from "vitest";
import { FakeGitHub } from "../src/github/fake.js";
import { executeSafe, doClose, doMerge, proposeGate, ActionSchema } from "../src/shell/actions.js";

const gh = () => new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });

test("reply posts a comment with a reply-marker; second call is idempotent (skips)", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "reply", num: 1, toCommentId: "99", body: "hi" });
  expect(g.comments[1]).toHaveLength(1);
  expect(g.comments[1][0]).toContain("hi");
  expect(g.comments[1][0]).toContain("<!--monastery-reply to=99-->");
  await executeSafe(g, "o/r", { kind: "reply", num: 1, toCommentId: "99", body: "hi again" });
  expect(g.comments[1]).toHaveLength(1); // already replied to comment 99 -> skipped
});

test("relabel adds and removes labels", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "relabel", num: 1, add: ["type:bug"], remove: [] });
  await executeSafe(g, "o/r", { kind: "relabel", num: 1, add: ["thesis:in"], remove: ["type:bug"] });
  const [i] = await g.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("thesis:in");
  expect(i.labels).not.toContain("type:bug");
});

test("panel upserts the single sticky panel, carrying a monastery marker", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "panel", num: 1, body: "status A" });
  await executeSafe(g, "o/r", { kind: "panel", num: 1, body: "status B" });
  expect(g.panels[1]).toContain("status B");            // upsert, not append (latest content)
  expect(g.panels[1]).not.toContain("status A");
  expect(g.panels[1]).toContain("<!--monastery-state"); // marker -> never mistaken for a human comment
});

test("openDraftPR opens once; skips when a PR already exists", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "openDraftPR", num: 1, branch: "feat/1-x", title: "t", body: "b" });
  expect(g.prs).toHaveLength(1);
  await executeSafe(g, "o/r", { kind: "openDraftPR", num: 1, branch: "feat/1-x", title: "t", body: "b" });
  expect(g.prs).toHaveLength(1); // findPrForBranch found it -> skipped
});

test("propose writes an approval panel + needs-approval label", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "propose", num: 1, proposal: "close", draft: "close because X" });
  expect(g.panels[1]).toContain("protocol: approval");
  expect(g.panels[1]).toContain("action: close");
  expect(g.panels[1]).toContain("close because X");
  const [i] = await g.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:needs-approval");
});

test("spec appends a versioned spec comment; same body is idempotent; changed body bumps the version", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "spec", num: 1, body: "draft v1", parties: ["a-bot", "b-bot"] });
  const specs1 = (await g.listComments("o/r", 1)).filter((c) => c.body.includes("monastery-spec"));
  expect(specs1).toHaveLength(1);
  expect(specs1[0].body).toContain("version=1");
  expect(specs1[0].body).toContain("parties=a-bot,b-bot");
  expect(specs1[0].body).toContain("draft v1");
  await executeSafe(g, "o/r", { kind: "spec", num: 1, body: "draft v1", parties: ["a-bot", "b-bot"] }); // same -> skip
  expect((await g.listComments("o/r", 1)).filter((c) => c.body.includes("monastery-spec"))).toHaveLength(1);
  await executeSafe(g, "o/r", { kind: "spec", num: 1, body: "draft v2", parties: ["a-bot", "b-bot"] }); // changed -> v2
  expect((await g.listComments("o/r", 1)).some((c) => c.body.includes("monastery-spec version=2"))).toBe(true);
});

test("endorse posts an endorse marker for a version; re-endorsing the same version by self is idempotent", async () => {
  const g = gh();
  await executeSafe(g, "o/r", { kind: "endorse", num: 1, version: 2 });
  expect((await g.listComments("o/r", 1)).filter((c) => c.body.includes("monastery-endorse version=2"))).toHaveLength(1);
  await executeSafe(g, "o/r", { kind: "endorse", num: 1, version: 2 }); // self already endorsed v2 -> skip
  expect((await g.listComments("o/r", 1)).filter((c) => c.body.includes("monastery-endorse version=2"))).toHaveLength(1);
});

test("doClose closes the issue and posts the reason", async () => {
  const g = gh();
  await doClose(g, "o/r", 1, "out of scope");
  expect(g.closed).toContain(1);
  expect(g.comments[1][0]).toBe("out of scope");
});

test("doMerge merges the PR; skips if already merged", async () => {
  const g = gh();
  await doMerge(g, "o/r", "feat/1-x");
  expect(g.merged).toEqual(["feat/1-x"]);
  g.prStates["feat/1-x"] = "merged";
  await doMerge(g, "o/r", "feat/1-x");
  expect(g.merged).toEqual(["feat/1-x"]); // already merged -> skipped
});

// --- #88: implement is a gated action (needs a human 👍 before runImplement) ---

test("implement action accepts an optional draft (the human-facing plan)", () => {
  expect(ActionSchema.parse({ kind: "implement", num: 1, draft: "## Plan" })).toEqual({ kind: "implement", num: 1, draft: "## Plan" });
  expect(ActionSchema.parse({ kind: "implement", num: 1 })).toEqual({ kind: "implement", num: 1 });
});

test("proposeGate(implement) opens an approval panel (action: implement) + needs-approval", async () => {
  const g = gh();
  await proposeGate(g, "o/r", 1, "implement", "## Plan: refactor X");
  expect(g.panels[1]).toContain("protocol: approval");
  expect(g.panels[1]).toContain("action: implement");
  expect(g.panels[1]).toContain("## Plan: refactor X");
  const [i] = await g.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:needs-approval");
});
