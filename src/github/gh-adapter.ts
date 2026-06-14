// src/github/gh-adapter.ts
import { execa } from "execa";
import type { GitHubAdapter } from "./adapter.js";
import type { Issue } from "../types.js";
import { isStickyPanel } from "../shell/messages.js";
import { withGhRetry, rethrowIfTransient } from "./transient.js";

export type GhRun = (args: string[], input?: string) => Promise<string>;

const rawRun: GhRun = async (args, input) => {
  const { stdout } = await execa("gh", args, input !== undefined ? { input } : undefined);
  return stdout;
};

// #148: every production gh call goes through bounded retry + backoff so a single
// transient GitHub blip is absorbed and a sustained outage surfaces cleanly.
const defaultRun: GhRun = withGhRetry(rawRun);

export class GhAdapter implements GitHubAdapter {
  constructor(private run: GhRun = defaultRun) {}

  async listOpenIssues(repo: string, _sinceMs?: number): Promise<Issue[]> {
    const out = await this.run([
      "issue", "list", "--repo", repo, "--state", "open", "--limit", "200",
      "--json", "number,title,body,labels,state,updatedAt",
    ]);
    const raw = JSON.parse(out || "[]") as Array<{ number: number; title: string; body: string; labels: { name: string }[]; state: string; updatedAt?: string }>;
    return raw.map((i) => ({
      number: i.number, title: i.title, body: i.body ?? "",
      labels: i.labels.map((l) => l.name), state: i.state.toLowerCase() as Issue["state"],
      updatedAt: i.updatedAt ? Date.parse(i.updatedAt) || 0 : undefined,
    }));
  }
  async getIssue(repo: string, num: number): Promise<Issue | null> {
    try {
      const out = await this.run([
        "issue", "view", String(num), "--repo", repo, "--json", "number,title,body,labels,state,updatedAt",
      ]);
      const i = JSON.parse(out) as { number: number; title: string; body: string; labels: { name: string }[]; state: string; updatedAt?: string };
      return {
        number: i.number, title: i.title, body: i.body ?? "",
        labels: i.labels.map((l) => l.name), state: i.state.toLowerCase() as Issue["state"],
        updatedAt: i.updatedAt ? Date.parse(i.updatedAt) || 0 : undefined,
      };
    } catch (e) {
      rethrowIfTransient(e); // a sustained outage must not look like "issue gone" (#148)
      return null;
    }
  }
  async addLabel(repo: string, num: number, label: string): Promise<void> {
    await this.run(["issue", "edit", String(num), "--repo", repo, "--add-label", label]);
  }
  async removeLabel(repo: string, num: number, label: string): Promise<void> {
    await this.run(["issue", "edit", String(num), "--repo", repo, "--remove-label", label]);
  }
  async postComment(repo: string, num: number, body: string): Promise<void> {
    await this.run(["issue", "comment", String(num), "--repo", repo, "--body-file", "-"], body);
  }
  async closeIssue(repo: string, num: number): Promise<void> {
    await this.run(["issue", "close", String(num), "--repo", repo]);
  }
  async readThesis(repo: string): Promise<string> {
    return this.run(["api", `repos/${repo}/contents/.monastery/thesis.md`, "--jq", ".content"])
      .then((b64) => Buffer.from(b64.trim(), "base64").toString("utf8"))
      .catch((e) => { rethrowIfTransient(e); return ""; });
  }
  // #154: the sticky panel is selected by FIELD (isStickyPanel), not by a bare `startswith(STATE_MARKER)`
  // [0]. The approval gate shares that prefix; selecting [0] could PATCH over a live gate (dropping the
  // approval門) when the gate is the first state comment. The field judgment lives in the schema helper, so
  // we pull the comment bodies and filter in JS rather than encoding `kind`/`status` into jq.
  private async stickyPanel(repo: string, num: number): Promise<{ id: string; body: string } | undefined> {
    const out = await this.run([
      "api", `repos/${repo}/issues/${num}/comments`, "--jq", "[.[] | {id: (.id|tostring), body}]",
    ]).catch((e) => { rethrowIfTransient(e); return "[]"; });
    const all = JSON.parse(out || "[]") as { id: string; body: string }[];
    return all.find((c) => isStickyPanel(c.body));
  }
  async readPanel(repo: string, num: number): Promise<string> {
    return (await this.stickyPanel(repo, num))?.body ?? "";
  }
  async upsertPanel(repo: string, num: number, body: string): Promise<void> {
    const panel = await this.stickyPanel(repo, num);
    if (panel) {
      await this.run(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${panel.id}`, "-F", "body=@-"], body);
    } else {
      await this.run(["issue", "comment", String(num), "--repo", repo, "--body-file", "-"], body);
    }
  }
  async ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
    await this.run(["label", "create", name, "--repo", repo, "--color", color, "--description", description, "--force"]);
  }
  async fileExists(repo: string, path: string): Promise<boolean> {
    try {
      const sha = await this.run(["api", `repos/${repo}/contents/${path}`, "--jq", ".sha"]);
      return sha.trim().length > 0;
    } catch (e) {
      rethrowIfTransient(e); // a sustained outage must not look like "file absent" (#148)
      return false;
    }
  }
  async createFile(repo: string, path: string, content: string, message: string): Promise<void> {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    await this.run(["api", "-X", "PUT", `repos/${repo}/contents/${path}`, "-f", `message=${message}`, "-f", `content=${b64}`]);
  }
  async labelEventTime(repo: string, num: number, label: string): Promise<number | null> {
    // Read the issue timeline; take the `created_at` of the latest `labeled` event for this label.
    // Timeline events are chronological, so `last` is the most recent labeling.
    const out = await this.run([
      "api", `repos/${repo}/issues/${num}/timeline`, "-f", "per_page=100",
      "--jq", `[.[] | select(.event=="labeled" and .label.name=="${label}") | .created_at] | last // ""`,
    ]).catch((e) => { rethrowIfTransient(e); return ""; });
    const s = out.trim();
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  async findPrForBranch(repo: string, branch: string): Promise<string | null> {
    const out = await this.run(
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "url", "--jq", '.[0].url // ""'],
    ).catch((e) => { rethrowIfTransient(e); return ""; });
    return out.trim() || null;
  }
  async prState(repo: string, branch: string): Promise<"open" | "merged" | "closed" | null> {
    const out = await this.run(
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "state", "--jq", '.[0].state // ""'],
    ).catch((e) => { rethrowIfTransient(e); return ""; });
    const s = out.trim().toLowerCase();
    return s === "open" || s === "merged" || s === "closed" ? s : null;
  }
  async getPrDetails(repo: string, branch: string): Promise<{ number: number; url: string; title: string; body: string; isDraft: boolean } | null> {
    const out = await this.run([
      "pr", "list", "--repo", repo, "--head", branch, "--state", "all",
      "--json", "number,url,title,body,isDraft", "--jq", ".[0] // empty",
    ]).catch((e) => { rethrowIfTransient(e); return ""; });
    if (!out.trim()) return null;
    try {
      const r = JSON.parse(out) as { number: number; url: string; title: string; body: string; isDraft: boolean };
      return { number: r.number, url: r.url, title: r.title, body: r.body ?? "", isDraft: r.isDraft ?? false };
    } catch {
      return null;
    }
  }
  async listPrComments(repo: string, prNumber: number): Promise<{ id: string; body: string; author: string }[]> {
    // PR conversation comments share the same endpoint as issue comments (a PR IS an issue in GitHub's model).
    return this.listComments(repo, prNumber);
  }
  async listPrReviews(repo: string, prNumber: number): Promise<{ author: string; state: string; body: string }[]> {
    const out = await this.run([
      "api", `repos/${repo}/pulls/${prNumber}/reviews`,
      "--jq", "[.[] | {author: .user.login, state, body}]",
    ]).catch((e) => { rethrowIfTransient(e); return "[]"; });
    return JSON.parse(out || "[]") as { author: string; state: string; body: string }[];
  }
  async getPrChecks(repo: string, prNumber: number): Promise<"pass" | "fail" | "pending"> {
    // statusCheckRollup via gh pr view; fall back to "pending" on any error.
    const out = await this.run([
      "pr", "view", String(prNumber), "--repo", repo, "--json", "statusCheckRollup",
      "--jq", '.statusCheckRollup | if . == null or length == 0 then "pending" elif any(.[]; .conclusion == "FAILURE" or .conclusion == "TIMED_OUT") then "fail" elif any(.[]; .status != "COMPLETED") then "pending" else "pass" end',
    ]).catch((e) => { rethrowIfTransient(e); return ""; });
    const s = out.trim();
    return s === "pass" || s === "fail" ? s : "pending";
  }
  async listComments(repo: string, num: number): Promise<{ id: string; body: string; author: string; updatedAt: number }[]> {
    const out = await this.run([
      "api", `repos/${repo}/issues/${num}/comments`, "--jq", "[.[] | {id: (.id|tostring), body, author: .user.login, updatedAt: .updated_at}]",
    ]).catch((e) => { rethrowIfTransient(e); return "[]"; });
    const raw = JSON.parse(out || "[]") as { id: string; body: string; author: string; updatedAt: string }[];
    return raw.map((c) => ({ id: c.id, body: c.body, author: c.author, updatedAt: Date.parse(c.updatedAt) || 0 }));
  }
  private cachedLogin?: string;
  async login(): Promise<string> {
    if (this.cachedLogin === undefined) this.cachedLogin = (await this.run(["api", "user", "--jq", ".login"]).catch((e) => { rethrowIfTransient(e); return ""; })).trim();
    return this.cachedLogin;
  }
  async reactions(repo: string, commentId: string): Promise<{ content: string; author: string }[]> {
    const out = await this.run([
      "api", `repos/${repo}/issues/comments/${commentId}/reactions`, "--jq", "[.[] | {content, author: .user.login}]",
    ]).catch((e) => { rethrowIfTransient(e); return "[]"; });
    return JSON.parse(out || "[]") as { content: string; author: string }[];
  }
  async mergePR(repo: string, branch: string): Promise<void> {
    await this.run(["pr", "merge", branch, "--repo", repo, "--merge"]);
  }

  async openDraftPR(repo: string, head: string, title: string, body: string): Promise<string> {
    try {
      const url = await this.run(
        ["pr", "create", "--repo", repo, "--head", head, "--draft", "--title", title, "--body-file", "-"],
        body,
      );
      return url.trim();
    } catch (e) {
      rethrowIfTransient(e); // a sustained outage must surface, not be read as "PR may already exist" (#148)
      // A PR for this head branch may already exist (a prior run pushed but failed before labeling).
      // Return the existing PR's url so the caller's label swap can converge — never double-create.
      const existing = await this.run(
        ["pr", "view", head, "--repo", repo, "--json", "url", "--jq", ".url"],
      ).catch((e) => { rethrowIfTransient(e); return ""; });
      if (existing.trim()) return existing.trim();
      throw new Error(`openDraftPR failed for ${repo} head=${head} and no existing PR was found`);
    }
  }
}
