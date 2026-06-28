// src/config/store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyOverrides } from "../agents/spec.js";
import type { BacklogSnapshot } from "../types.js";
import { DEFAULT_LANGUAGE } from "../shell/language.js";

/**
 * Per-repo policy. Non-disposable (lives in config.json). `model` is the repo-wide default model;
 * `agents` overrides individual agents' spec-default policy (the layering: spec default <- per-repo).
 * `language` is this repo's outward-text language (#76) — overrides the global `defaults.language`.
 */
export interface RepoPolicy extends PolicyOverrides { model?: string; language?: string; }
/** Global defaults applied across repos when a repo doesn't override them. */
interface ConfigDefaults { language?: string; }
interface ConfigFile { repos: Record<string, RepoPolicy>; defaults?: ConfigDefaults; }
interface LegacyReposFile { repos?: unknown }

/** Per-repo disposable cache (rebuildable from GitHub). */
interface CacheFile { cursor: number; fails: Record<number, number>; labelsEnsured?: string; }
const EMPTY_CACHE: CacheFile = { cursor: 0, fails: {} };

/** Per-issue consecutive judge-failure counter (operational; disposable — losing it just resets escalation). */
export interface FailTracker {
  recordFail(repo: string, num: number): number; // increment, return new consecutive count
  failCount(repo: string, num: number): number;
  clearFail(repo: string, num: number): void;
}

/** Reads/writes the per-repo backlog snapshot (#82/#140). Disposable — #176: refreshed by `assess`,
 *  read by `assess` (freshness skip) and the read-only views. */
export interface BacklogWriter {
  writeBacklog(repo: string, snapshot: BacklogSnapshot): void;
  readBacklog(repo: string): BacklogSnapshot | null;
}

export interface LegacyReposCleanup {
  path: string;
  archivePath: string;
  migratedRepos: string[];
}

/** `<owner>/<repo>` → a filesystem-safe per-repo dir slug. */
function repoSlug(repo: string): string { return repo.replace(/\//g, "__"); }

/**
 * Local layout (see docs/LOCAL-LAYOUT.md):
 *   <root>/config.json                       non-disposable: { defaults?: { language }, repos: { "<o>/<r>": { model, language } } }
 *   <root>/repos/<owner>__<repo>/cache.json  disposable: { cursor, fails } — rebuildable from GitHub
 * Secrets never live here — env/keychain only.
 */
export class Store implements FailTracker, BacklogWriter {
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }

  private readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
  }
  private writeJson(path: string, data: unknown): void {
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  }

  // --- config.json (non-disposable) ---

  private configPath(): string { return join(this.root, "config.json"); }
  private legacyReposPath(): string { return join(this.root, "repos.json"); }
  private readConfig(): ConfigFile { return this.readJson<ConfigFile>(this.configPath(), { repos: {} }); }
  private writeConfig(c: ConfigFile): void { this.writeJson(this.configPath(), c); }

  /**
   * One-time bridge for pre-v2 installs: the old flat repos.json is no longer a source of truth.
   * Merge any missing repo names into config.json, then archive the stale file so future commands
   * cannot appear to read two different tracking states.
   */
  cleanupLegacyReposFile(now: () => Date = () => new Date()): LegacyReposCleanup | null {
    const path = this.legacyReposPath();
    if (!existsSync(path)) return null;
    const legacy = this.readJson<LegacyReposFile>(path, {});
    const repos = Array.isArray(legacy.repos) ? legacy.repos.filter((r): r is string => typeof r === "string") : [];
    const c = this.readConfig();
    const migratedRepos: string[] = [];
    for (const repo of repos) {
      if (!(repo in c.repos)) {
        c.repos[repo] = {};
        migratedRepos.push(repo);
      }
    }
    if (migratedRepos.length) this.writeConfig(c);
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(this.root, `repos.json.legacy-${stamp}`);
    renameSync(path, archivePath);
    return { path, archivePath, migratedRepos };
  }

  listRepos(): string[] { return Object.keys(this.readConfig().repos); }

  /** Add/update a repo. Idempotent; a `policy` arg overrides, omitting it keeps the existing one. */
  addRepo(repo: string, policy?: RepoPolicy): void {
    const c = this.readConfig();
    c.repos[repo] = policy ?? c.repos[repo] ?? {};
    this.writeConfig(c);
  }
  removeRepo(repo: string): void {
    const c = this.readConfig();
    if (repo in c.repos) { delete c.repos[repo]; this.writeConfig(c); }
  }
  repoModel(repo: string): string | undefined { return this.readConfig().repos[repo]?.model; }
  /** The full per-repo policy (model + per-agent overrides), or undefined if the repo isn't configured. */
  repoPolicy(repo: string): RepoPolicy | undefined { return this.readConfig().repos[repo]; }

  /** #76: the resolved outward-text language for a repo — repo policy → global defaults → en-US. */
  repoLanguage(repo: string): string {
    const c = this.readConfig();
    return c.repos[repo]?.language ?? c.defaults?.language ?? DEFAULT_LANGUAGE;
  }

  // --- repos/<slug>/cache.json (disposable) ---

  private cachePath(repo: string): string { return join(this.root, "repos", repoSlug(repo), "cache.json"); }
  private readCache(repo: string): CacheFile { return this.readJson<CacheFile>(this.cachePath(repo), { ...EMPTY_CACHE, fails: {} }); }
  private writeCache(repo: string, c: CacheFile): void {
    const p = this.cachePath(repo);
    mkdirSync(join(this.root, "repos", repoSlug(repo)), { recursive: true });
    this.writeJson(p, c);
  }

  getCursor(repo: string): number { return this.readCache(repo).cursor; }
  setCursor(repo: string, value: number): void {
    const c = this.readCache(repo); c.cursor = value; this.writeCache(repo, c);
  }

  /**
   * #148: the fingerprint of the label set last fully ensured for this repo, or undefined.
   * initRepo skips its per-tick ensureLabel calls when this matches the current label set,
   * keeping a flaky label API off every tick's critical path.
   */
  ensuredLabelsFingerprint(repo: string): string | undefined { return this.readCache(repo).labelsEnsured; }
  setEnsuredLabelsFingerprint(repo: string, fingerprint: string): void {
    const c = this.readCache(repo); c.labelsEnsured = fingerprint; this.writeCache(repo, c);
  }

  recordFail(repo: string, num: number): number {
    const c = this.readCache(repo);
    const n = (c.fails[num] ?? 0) + 1;
    c.fails[num] = n; this.writeCache(repo, c); return n;
  }
  failCount(repo: string, num: number): number { return this.readCache(repo).fails[num] ?? 0; }
  clearFail(repo: string, num: number): void {
    const c = this.readCache(repo);
    if (num in c.fails) { delete c.fails[num]; this.writeCache(repo, c); }
  }

  // --- repos/<slug>/backlog.json (disposable, issue #82) ---

  private backlogPath(repo: string): string { return join(this.root, "repos", repoSlug(repo), "backlog.json"); }

  readBacklog(repo: string): BacklogSnapshot | null {
    return this.readJson<BacklogSnapshot | null>(this.backlogPath(repo), null);
  }
  writeBacklog(repo: string, snapshot: BacklogSnapshot): void {
    mkdirSync(join(this.root, "repos", repoSlug(repo)), { recursive: true });
    this.writeJson(this.backlogPath(repo), snapshot);
  }
}
