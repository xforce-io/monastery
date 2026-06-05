// tests/dry-run.test.ts
import { expect, test } from "vitest";
import { DryRunAdapter } from "../src/github/dry-run.js";
import { FakeGitHub } from "../src/github/fake.js";

function makeInner() {
  return new FakeGitHub({ thesis: "# thesis", issues: [{ number: 1, title: "t", body: "", state: "open", labels: [] }] });
}

test("read methods pass through to inner adapter", async () => {
  const inner = makeInner();
  const dry = new DryRunAdapter(inner);
  const issues = await dry.listOpenIssues("r", 0);
  expect(issues).toHaveLength(1);
  expect(await dry.readThesis("r")).toBe("# thesis");
  expect(await dry.fileExists("r", "missing")).toBe(false);
  expect(await dry.findPrForBranch("r", "x")).toBeNull();
});

test("write methods record actions and do not mutate inner adapter", async () => {
  const inner = makeInner();
  const dry = new DryRunAdapter(inner);

  await dry.addLabel("r", 1, "bug");
  await dry.removeLabel("r", 1, "bug");
  await dry.upsertPanel("r", 1, "panel body");
  await dry.postComment("r", 1, "hello");
  await dry.closeIssue("r", 1);
  await dry.ensureLabel("r", "triage", "abc123", "desc");
  await dry.createFile("r", "path/to/file", "content", "commit msg");
  const pr = await dry.openDraftPR("r", "feat/branch", "PR title", "body");

  // All writes recorded
  expect(dry.actions).toHaveLength(8);
  expect(dry.actions[0]).toMatchObject({ op: "addLabel", args: { num: 1, label: "bug" } });
  expect(dry.actions[4]).toMatchObject({ op: "closeIssue", args: { num: 1 } });
  expect(dry.actions[6]).toMatchObject({ op: "createFile", args: { path: "path/to/file", contentLength: 7 } });
  expect(pr).toContain("[dry-run]");

  // Inner adapter NOT mutated by writes
  const issues = await inner.listOpenIssues("r", 0);
  expect(issues[0].labels).toHaveLength(0); // addLabel did not apply
  expect(issues[0].state).toBe("open");     // closeIssue did not apply
  expect(inner.panels).toEqual({});
  expect(inner.comments).toEqual({});
  expect(inner.prs).toHaveLength(0);
});

test("no actions recorded when no writes occur", async () => {
  const inner = makeInner();
  const dry = new DryRunAdapter(inner);
  await dry.listOpenIssues("r", 0);
  expect(dry.actions).toHaveLength(0);
});
