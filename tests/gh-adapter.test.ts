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

test("ensureLabel issues the correct gh argv (idempotent --force)", async () => {
  const captured: string[][] = [];
  const gh = new GhAdapter(async (args) => { captured.push(args); return ""; });
  await gh.ensureLabel("o/r", "thesis:in", "0E8A16", "in scope");
  expect(captured[0]).toEqual(["label", "create", "thesis:in", "--repo", "o/r", "--color", "0E8A16", "--description", "in scope", "--force"]);
});

test("createFile PUTs base64 content", async () => {
  const captured: string[][] = [];
  const gh = new GhAdapter(async (args) => { captured.push(args); return ""; });
  await gh.createFile("o/r", ".monastery/thesis.md", "hello", "scaffold");
  expect(captured[0]).toEqual(["api", "-X", "PUT", "repos/o/r/contents/.monastery/thesis.md", "-f", "message=scaffold", "-f", "content=aGVsbG8="]);
});

test("fileExists is true when api returns a sha, false when it throws", async () => {
  const present = new GhAdapter(async () => "abc123");
  expect(await present.fileExists("o/r", ".monastery/thesis.md")).toBe(true);
  const absent = new GhAdapter(async () => { throw new Error("404"); });
  expect(await absent.fileExists("o/r", ".monastery/missing.md")).toBe(false);
});

test("openDraftPR issues the correct gh argv and returns the trimmed url", async () => {
  const captured: string[][] = [];
  const inputs: (string | undefined)[] = [];
  const gh = new GhAdapter(async (args, input) => { captured.push(args); inputs.push(input); return "https://github.com/o/r/pull/5\n"; });
  const url = await gh.openDraftPR("o/r", "monastery/fix-1", "monastery: fix #1", "body text");
  expect(captured[0]).toEqual(["pr", "create", "--repo", "o/r", "--head", "monastery/fix-1", "--draft", "--title", "monastery: fix #1", "--body-file", "-"]);
  expect(inputs[0]).toBe("body text");
  expect(url).toBe("https://github.com/o/r/pull/5");
});
