// tests/gh-adapter.test.ts
import { expect, test } from "vitest";
import { GhAdapter } from "../src/github/gh-adapter.js";

test("addLabel issues the correct gh argv", async () => {
  const captured: string[][] = [];
  const gh = new GhAdapter(async (args) => { captured.push(args); return ""; });
  await gh.addLabel("o/r", 7, "thesis:out");
  expect(captured[0]).toEqual(["issue", "edit", "7", "--repo", "o/r", "--add-label", "thesis:out"]);
});

test("closeIssue issues the correct gh argv", async () => {
  const captured: string[][] = [];
  const gh = new GhAdapter(async (args) => { captured.push(args); return ""; });
  await gh.closeIssue("o/r", 7);
  expect(captured[0]).toEqual(["issue", "close", "7", "--repo", "o/r"]);
});

test("listOpenIssues parses gh json output", async () => {
  const json = JSON.stringify([{ number: 1, title: "t", body: "b", labels: [{ name: "x" }], state: "OPEN" }]);
  const gh = new GhAdapter(async () => json);
  const issues = await gh.listOpenIssues("o/r", 0);
  expect(issues).toEqual([{ number: 1, title: "t", body: "b", labels: ["x"], state: "open" }]);
});
