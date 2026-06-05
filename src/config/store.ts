// src/config/store.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ReposFile { repos: string[]; }
interface CursorFile { cursors: Record<string, number>; }
interface FailFile { fails: Record<string, number>; }

/** Per-issue consecutive judge-failure counter (operational; disposable — losing it just resets escalation). */
export interface FailTracker {
  recordFail(repo: string, num: number): number; // increment, return new consecutive count
  failCount(repo: string, num: number): number;
  clearFail(repo: string, num: number): void;
}

/** All state here is disposable: rebuildable from GitHub. Only config + perf cursor. */
export class Store implements FailTracker {
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

  recordFail(repo: string, num: number): number {
    const f = this.read<FailFile>("fails.json", { fails: {} });
    const k = `${repo}#${num}`;
    const n = (f.fails[k] ?? 0) + 1;
    f.fails[k] = n; this.write("fails.json", f); return n;
  }
  failCount(repo: string, num: number): number {
    return this.read<FailFile>("fails.json", { fails: {} }).fails[`${repo}#${num}`] ?? 0;
  }
  clearFail(repo: string, num: number): void {
    const f = this.read<FailFile>("fails.json", { fails: {} });
    const k = `${repo}#${num}`;
    if (k in f.fails) { delete f.fails[k]; this.write("fails.json", f); }
  }
}
