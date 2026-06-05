// tests/github-fake.test.ts
import { expect, test } from "vitest";
import { FakeGitHub } from "../src/github/fake.js";
import { stateLabel } from "../src/github/labels.js";

test("labels add/remove are reflected on the issue", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await gh.addLabel("o/r", 1, stateLabel("triaged"));
  await gh.addLabel("o/r", 1, "thesis:out");
  await gh.removeLabel("o/r", 1, "thesis:out");
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toEqual(["monastery/state:triaged"]);
});

test("close removes the issue from open list and records the close", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await gh.postComment("o/r", 1, "reason");
  await gh.closeIssue("o/r", 1);
  expect(await gh.listOpenIssues("o/r", 0)).toEqual([]);
  expect(gh.comments[1]).toContain("reason");
  expect(gh.closed).toContain(1);
});

test("upsertPanel writes once then edits in place (single panel)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await gh.upsertPanel("o/r", 1, "v1");
  await gh.upsertPanel("o/r", 1, "v2");
  expect(gh.panels[1]).toBe("v2");
});

test("ensureLabel records the label; createFile + fileExists round-trip", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [], files: { ".monastery/thesis.md": "existing" } });
  await gh.ensureLabel("o/r", "thesis:in", "0E8A16", "in scope");
  expect(gh.ensuredLabels).toEqual([{ name: "thesis:in", color: "0E8A16", description: "in scope" }]);
  expect(await gh.fileExists("o/r", ".monastery/thesis.md")).toBe(true);
  expect(await gh.fileExists("o/r", ".monastery/missing.md")).toBe(false);
  await gh.createFile("o/r", ".monastery/new.md", "hello", "msg");
  expect(await gh.fileExists("o/r", ".monastery/new.md")).toBe(true);
  expect(gh.files[".monastery/new.md"]).toBe("hello");
});

test("FakeGitHub openDraftPR records the PR and returns a url", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [] });
  const url = await gh.openDraftPR("o/r", "monastery/fix-1", "t", "b");
  expect(gh.prs[0]).toEqual({ head: "monastery/fix-1", title: "t", body: "b" });
  expect(url).toContain("/pull/1");
});
