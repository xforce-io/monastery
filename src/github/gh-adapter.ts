// src/github/gh-adapter.ts
import { execa } from "execa";
import type { GitHubAdapter } from "./adapter.js";
import type { Issue } from "../types.js";

export type GhRun = (args: string[], input?: string) => Promise<string>;

const defaultRun: GhRun = async (args, input) => {
  const { stdout } = await execa("gh", args, input !== undefined ? { input } : undefined);
  return stdout;
};

const PANEL_MARKER = "<!--monastery-state";

export class GhAdapter implements GitHubAdapter {
  constructor(private run: GhRun = defaultRun) {}

  async listOpenIssues(repo: string, _sinceMs?: number): Promise<Issue[]> {
    const out = await this.run([
      "issue", "list", "--repo", repo, "--state", "open", "--limit", "200",
      "--json", "number,title,body,labels,state",
    ]);
    const raw = JSON.parse(out || "[]") as Array<{ number: number; title: string; body: string; labels: { name: string }[]; state: string }>;
    return raw.map((i) => ({
      number: i.number, title: i.title, body: i.body ?? "",
      labels: i.labels.map((l) => l.name), state: i.state.toLowerCase() as Issue["state"],
    }));
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
      .catch(() => "");
  }
  async readPanel(repo: string, num: number): Promise<string> {
    return this.run([
      "api", `repos/${repo}/issues/${num}/comments`,
      "--jq", `[.[] | select(.body | startswith("${PANEL_MARKER}"))][0].body // ""`,
    ]).catch(() => "");
  }
  async upsertPanel(repo: string, num: number, body: string): Promise<void> {
    const id = await this.run([
      "api", `repos/${repo}/issues/${num}/comments`,
      "--jq", `[.[] | select(.body | startswith("${PANEL_MARKER}"))][0].id // ""`,
    ]).catch(() => "");
    if (id.trim()) {
      await this.run(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id.trim()}`, "-F", "body=@-"], body);
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
    } catch {
      return false;
    }
  }
  async createFile(repo: string, path: string, content: string, message: string): Promise<void> {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    await this.run(["api", "-X", "PUT", `repos/${repo}/contents/${path}`, "-f", `message=${message}`, "-f", `content=${b64}`]);
  }
  async findPrForBranch(repo: string, branch: string): Promise<string | null> {
    const out = await this.run(
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "url", "--jq", '.[0].url // ""'],
    ).catch(() => "");
    return out.trim() || null;
  }

  async openDraftPR(repo: string, head: string, title: string, body: string): Promise<string> {
    try {
      const url = await this.run(
        ["pr", "create", "--repo", repo, "--head", head, "--draft", "--title", title, "--body-file", "-"],
        body,
      );
      return url.trim();
    } catch {
      // A PR for this head branch may already exist (a prior run pushed but failed before labeling).
      // Return the existing PR's url so the caller's label swap can converge — never double-create.
      const existing = await this.run(
        ["pr", "view", head, "--repo", repo, "--json", "url", "--jq", ".url"],
      ).catch(() => "");
      if (existing.trim()) return existing.trim();
      throw new Error(`openDraftPR failed for ${repo} head=${head} and no existing PR was found`);
    }
  }
}
