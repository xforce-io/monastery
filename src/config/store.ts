// src/config/store.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ReposFile { repos: string[]; }
interface CursorFile { cursors: Record<string, number>; }

/** All state here is disposable: rebuildable from GitHub. Only config + perf cursor. */
export class Store {
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }

  private read<T>(name: string, fallback: T): T {
    const p = join(this.root, name);
    if (!existsSync(p)) return fallback;
    try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return fallback; }
  }
  private write(name: string, data: unknown): void {
    writeFileSync(join(this.root, name), JSON.stringify(data, null, 2), "utf8");
  }

  listRepos(): string[] { return this.read<ReposFile>("repos.json", { repos: [] }).repos; }
  addRepo(repo: string): void {
    const repos = new Set(this.listRepos()); repos.add(repo);
    this.write("repos.json", { repos: [...repos] } satisfies ReposFile);
  }
  removeRepo(repo: string): void {
    this.write("repos.json", { repos: this.listRepos().filter((r) => r !== repo) } satisfies ReposFile);
  }

  getCursor(repo: string): number { return this.read<CursorFile>("cursor.json", { cursors: {} }).cursors[repo] ?? 0; }
  setCursor(repo: string, value: number): void {
    const f = this.read<CursorFile>("cursor.json", { cursors: {} });
    f.cursors[repo] = value; this.write("cursor.json", f);
  }
}
