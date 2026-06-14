// tests/gh-adapter.test.ts
import { expect, test } from "vitest";
import { GhAdapter } from "../src/github/gh-adapter.js";
import { TransientGitHubError } from "../src/github/transient.js";
import { renderStateMessage } from "../src/shell/messages.js";

const GATE = renderStateMessage({ status: "awaiting-approval", action: "implement", spec: 1, body: "请批准" });
const PANEL = renderStateMessage({ status: "note", body: "fyi" });

// A fake `gh` that replays a comments list for the issue-comments endpoint and captures every write argv.
function commentsFake(comments: { id: string; body: string }[]) {
  const captured: { args: string[]; input?: string }[] = [];
  const run = async (args: string[], input?: string): Promise<string> => {
    captured.push({ args, input });
    const isList = args[0] === "api" && /\/issues\/\d+\/comments$/.test(args[1] ?? "");
    if (isList) return JSON.stringify(comments);
    return "";
  };
  return { gh: new GhAdapter(run), captured };
}

test("#154 upsertPanel rewrites the sticky panel, NEVER the approval gate at [0]", async () => {
  // gate is the FIRST monastery-state comment; the sticky panel is second. The old bare-[0] selection would
  // PATCH the gate (dropping the approval門). By-field selection must target the panel's id (200).
  const { gh, captured } = commentsFake([
    { id: "100", body: GATE },
    { id: "200", body: PANEL },
  ]);
  await gh.upsertPanel("o/r", 7, renderStateMessage({ status: "note", body: "updated" }));
  const patch = captured.find((c) => c.args.includes("PATCH"));
  expect(patch).toBeDefined();
  expect(patch!.args.join(" ")).toContain("repos/o/r/issues/comments/200");
  expect(patch!.args.join(" ")).not.toContain("/comments/100"); // the gate is untouched
});

test("#154 upsertPanel posts a NEW panel when only a gate exists (does not patch the gate)", async () => {
  const { gh, captured } = commentsFake([{ id: "100", body: GATE }]);
  await gh.upsertPanel("o/r", 7, renderStateMessage({ status: "note", body: "first panel" }));
  expect(captured.some((c) => c.args.includes("PATCH"))).toBe(false);     // never patches the gate
  const post = captured.find((c) => c.args[0] === "issue" && c.args[1] === "comment");
  expect(post).toBeDefined();
});

test("#154 readPanel returns the sticky panel body, skipping the gate at [0]", async () => {
  const { gh } = commentsFake([
    { id: "100", body: GATE },
    { id: "200", body: PANEL },
  ]);
  expect(await gh.readPanel("o/r", 7)).toBe(PANEL);
});

test("#154 readPanel returns empty string when only a gate exists (no sticky panel)", async () => {
  const { gh } = commentsFake([{ id: "100", body: GATE }]);
  expect(await gh.readPanel("o/r", 7)).toBe("");
});

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

test("listComments parses id+body+author+updatedAt json (identity + newest gate ordering)", async () => {
  const captured: string[][] = [];
  const json = JSON.stringify([
    { id: "10", body: "hello", author: "alice", updatedAt: "2020-01-01T00:00:00.000Z" },
    { id: "11", body: "world", author: "monastery-bot", updatedAt: "2020-01-02T00:00:00.000Z" },
  ]);
  const gh = new GhAdapter(async (args) => { captured.push(args); return json; });
  expect(await gh.listComments("o/r", 7)).toEqual([
    { id: "10", body: "hello", author: "alice", updatedAt: Date.parse("2020-01-01T00:00:00.000Z") },
    { id: "11", body: "world", author: "monastery-bot", updatedAt: Date.parse("2020-01-02T00:00:00.000Z") },
  ]);
  expect(captured[0]).toContain("[.[] | {id: (.id|tostring), body, author: .user.login, updatedAt: .updated_at}]");
});

test("reactions reads a comment's reaction contents + author (record/replay)", async () => {
  const captured: string[][] = [];
  const gh = new GhAdapter(async (args) => { captured.push(args); return JSON.stringify([{ content: "+1", author: "alice" }, { content: "-1", author: "bob" }]); });
  const got = await gh.reactions("o/r", "12345");
  expect(captured[0]).toEqual([
    "api", "repos/o/r/issues/comments/12345/reactions", "--jq", "[.[] | {content, author: .user.login}]",
  ]);
  expect(got).toEqual([{ content: "+1", author: "alice" }, { content: "-1", author: "bob" }]);
});

test("reactions returns [] when none / api fails", async () => {
  expect(await new GhAdapter(async () => "[]").reactions("o/r", "1")).toEqual([]);
  expect(await new GhAdapter(async () => { throw new Error("404"); }).reactions("o/r", "1")).toEqual([]);
});

test("getIssue reads one issue (any repo, open or closed) and maps it to Issue", async () => {
  const captured: string[][] = [];
  const json = JSON.stringify({ number: 42, title: "upstream", body: "b", labels: [{ name: "type:bug" }], state: "CLOSED", updatedAt: "1970-01-01T00:00:01.000Z" });
  const gh = new GhAdapter(async (args) => { captured.push(args); return json; });
  expect(await gh.getIssue("owner/other", 42)).toEqual({ number: 42, title: "upstream", body: "b", labels: ["type:bug"], state: "closed", updatedAt: 1000 });
  expect(captured[0]).toEqual(["issue", "view", "42", "--repo", "owner/other", "--json", "number,title,body,labels,state,updatedAt"]);
});

test("getIssue returns null when the issue is missing / inaccessible", async () => {
  const gh = new GhAdapter(async () => { throw new Error("not found"); });
  expect(await gh.getIssue("owner/other", 999)).toBeNull();
});

// #148: a sustained outage (TransientGitHubError) must NOT be swallowed into a "data absent"
// fallback — it has to surface so the step fails cleanly and retryably. Only genuine
// not-found / parse errors degrade to the fallback.
test("getIssue re-throws a sustained TransientGitHubError instead of masking it as null", async () => {
  const gh = new GhAdapter(async () => { throw new TransientGitHubError("GitHub API temporarily unavailable", 4); });
  await expect(gh.getIssue("owner/other", 1)).rejects.toBeInstanceOf(TransientGitHubError);
});

test("readThesis returns '' on a genuine error but re-throws a sustained TransientGitHubError", async () => {
  const ok = new GhAdapter(async () => { throw new Error("404 not found"); });
  expect(await ok.readThesis("o/r")).toBe(""); // genuine absence → empty, as before
  const down = new GhAdapter(async () => { throw new TransientGitHubError("down", 4); });
  await expect(down.readThesis("o/r")).rejects.toBeInstanceOf(TransientGitHubError);
});

test("fileExists returns false on a genuine error but re-throws a sustained TransientGitHubError", async () => {
  const ok = new GhAdapter(async () => { throw new Error("404"); });
  expect(await ok.fileExists("o/r", "x")).toBe(false);
  const down = new GhAdapter(async () => { throw new TransientGitHubError("down", 4); });
  await expect(down.fileExists("o/r", "x")).rejects.toBeInstanceOf(TransientGitHubError);
});

test("openDraftPR re-throws a sustained TransientGitHubError on create instead of probing for an existing PR", async () => {
  const gh = new GhAdapter(async () => { throw new TransientGitHubError("down", 4); });
  await expect(gh.openDraftPR("o/r", "feat/x", "t", "b")).rejects.toBeInstanceOf(TransientGitHubError);
});

test("mergePR issues the correct gh argv", async () => {
  const captured: string[][] = [];
  const gh = new GhAdapter(async (args) => { captured.push(args); return ""; });
  await gh.mergePR("o/r", "feat/6-x");
  expect(captured[0]).toEqual(["pr", "merge", "feat/6-x", "--repo", "o/r", "--merge"]);
});
