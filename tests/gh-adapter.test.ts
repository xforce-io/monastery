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

test("labelEventTime reads the timeline and returns the labeled timestamp in ms", async () => {
  const captured: string[][] = [];
  const gh = new GhAdapter(async (args) => { captured.push(args); return "2026-06-06T00:00:00Z\n"; });
  const t = await gh.labelEventTime("o/r", 7, "monastery:needs-approval");
  expect(captured[0]).toEqual([
    "api", "repos/o/r/issues/7/timeline", "-f", "per_page=100",
    "--jq", `[.[] | select(.event=="labeled" and .label.name=="monastery:needs-approval") | .created_at] | last // ""`,
  ]);
  expect(t).toBe(Date.parse("2026-06-06T00:00:00Z"));
});

test("labelEventTime returns null when the label was never applied or the api fails", async () => {
  const never = new GhAdapter(async () => "");
  expect(await never.labelEventTime("o/r", 7, "x")).toBeNull();
  const failed = new GhAdapter(async () => { throw new Error("404"); });
  expect(await failed.labelEventTime("o/r", 7, "x")).toBeNull();
});

test("openDraftPR returns the existing PR url when create fails (already exists)", async () => {
  const gh = new GhAdapter(async (args) => {
    if (args[0] === "pr" && args[1] === "create") throw new Error("a pull request for branch already exists");
    if (args[0] === "pr" && args[1] === "view") return "https://github.com/o/r/pull/9\n";
    return "";
  });
  const url = await gh.openDraftPR("o/r", "monastery/fix-1", "t", "b");
  expect(url).toBe("https://github.com/o/r/pull/9");
});

test("prState returns the lowercased PR state, null when absent", async () => {
  const captured: string[][] = [];
  const merged = new GhAdapter(async (args) => { captured.push(args); return "MERGED"; });
  expect(await merged.prState("o/r", "feat/28-x")).toBe("merged");
  expect(captured[0]).toEqual(["pr", "list", "--repo", "o/r", "--head", "feat/28-x", "--state", "all", "--json", "state", "--jq", '.[0].state // ""']);
  expect(await new GhAdapter(async () => "OPEN").prState("o/r", "x")).toBe("open");
  expect(await new GhAdapter(async () => "CLOSED").prState("o/r", "x")).toBe("closed");
  expect(await new GhAdapter(async () => "").prState("o/r", "nope")).toBeNull();
});

test("listComments parses id+body json", async () => {
  const json = JSON.stringify([{ id: "10", body: "hello" }, { id: "11", body: "world" }]);
  const gh = new GhAdapter(async () => json);
  expect(await gh.listComments("o/r", 7)).toEqual([{ id: "10", body: "hello" }, { id: "11", body: "world" }]);
});

test("reactions reads a comment's reaction contents (record/replay)", async () => {
  const captured: string[][] = [];
  const gh = new GhAdapter(async (args) => { captured.push(args); return JSON.stringify(["+1", "-1", "rocket"]); });
  const got = await gh.reactions("o/r", "12345");
  expect(captured[0]).toEqual([
    "api", "repos/o/r/issues/comments/12345/reactions", "--jq", "[.[].content]",
  ]);
  expect(got).toEqual(["+1", "-1", "rocket"]);
});

test("reactions returns [] when none / api fails", async () => {
  expect(await new GhAdapter(async () => "[]").reactions("o/r", "1")).toEqual([]);
  expect(await new GhAdapter(async () => { throw new Error("404"); }).reactions("o/r", "1")).toEqual([]);
});

test("mergePR issues the correct gh argv", async () => {
  const captured: string[][] = [];
  const gh = new GhAdapter(async (args) => { captured.push(args); return ""; });
  await gh.mergePR("o/r", "feat/6-x");
  expect(captured[0]).toEqual(["pr", "merge", "feat/6-x", "--repo", "o/r", "--merge"]);
});
