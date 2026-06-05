# monastery M1 (thesis-gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship monastery milestone 1 — a single-repo, thesis-gate-only closed loop that triages a repo's open issues against its `.monastery/thesis.md`, proposes a close+reason draft for out-of-scope issues, and executes the close only after a human applies `monastery:approved` — all driven by an externally-invoked `monastery step`.

**Architecture:** A deterministic TypeScript/Node "shell" owns all GitHub writes, state, and the reconcile loop; the only LLM call (thesis-gate) goes through an injectable `AgentProvider` (default = spawn `claude -p`) that communicates by writing a `verdict.json` artifact the shell reads and zod-validates. Every external edge (`gh`, `claude`) is behind an interface, so the engine/judge/approval are unit-tested against in-memory fakes. Macro state lives entirely in GitHub labels (`monastery/state:*`); local files hold only disposable config + cursor.

**Tech Stack:** TypeScript + Node, `execa` (gh + claude subprocess), `zod` (artifact validation), `vitest` (tests), `tsup` (build). Mirrors the provider shape from `~/dev/github/petri`.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `tsup.config.ts`
- Create: `src/index.ts`, `tests/smoke.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "monastery",
  "version": "0.0.0",
  "type": "module",
  "bin": { "monastery": "./dist/cli/index.js" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "execa": "^9.5.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Write `vitest.config.ts` and `tsup.config.ts`**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
```

```ts
// tsup.config.ts
import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/cli/index.ts"], format: ["esm"], target: "node20", clean: true });
```

- [ ] **Step 4: Write `src/index.ts` and the smoke test**

```ts
// src/index.ts
export const VERSION = "0.0.0";
```

```ts
// tests/smoke.test.ts
import { expect, test } from "vitest";
import { VERSION } from "../src/index.js";
test("package loads", () => { expect(VERSION).toBe("0.0.0"); });
```

- [ ] **Step 5: Install, run, commit**

Run: `npm install && npm test`
Expected: 1 passed.

```bash
git add -A
git commit -m "chore: scaffold TypeScript/Node project (vitest, tsup)"
```

---

### Task 2: Core types + label vocabulary

**Files:**
- Create: `src/types.ts`, `src/github/labels.ts`
- Test: `tests/labels.test.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
// src/types.ts

// Outcome of any step level (issue step / reconcile item).
export type WaitReason = "human" | "peer" | "ci";
export type Outcome =
  | { kind: "progressed"; note?: string }
  | { kind: "waiting"; on: WaitReason }
  | { kind: "done" }
  | { kind: "noop" };

// Per-repo reconcile tick result (L0).
export interface ReconcileResult {
  repo: string;
  advanced: number;
  waiting: { on: WaitReason; count: number }[];
  idle: boolean;
  nextPollMs: number;
}

// Macro state machine (encoded as the single-value monastery/state:<x> label).
export type MacroState = "new" | "triaged" | "needs-approval" | "approved" | "done";

// thesis-gate verdict.
export type Verdict = "in" | "out" | "unclear";

// An issue as the shell sees it (subset of GitHub's issue).
export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}
```

- [ ] **Step 2: Write the failing test for label helpers**

```ts
// tests/labels.test.ts
import { expect, test } from "vitest";
import { STATE_PREFIX, stateLabel, macroStateOf, THESIS, NEEDS_APPROVAL, APPROVED } from "../src/github/labels.js";

test("stateLabel builds the namespaced single-value label", () => {
  expect(stateLabel("new")).toBe("monastery/state:new");
  expect(STATE_PREFIX).toBe("monastery/state:");
});

test("macroStateOf reads the state label, or 'new' when absent (virtual new)", () => {
  expect(macroStateOf(["monastery/state:triaged", "thesis:in"])).toBe("triaged");
  expect(macroStateOf(["thesis:out"])).toBe("new"); // no state label => virtual new
});

test("action label constants", () => {
  expect(THESIS.out).toBe("thesis:out");
  expect(NEEDS_APPROVAL).toBe("monastery:needs-approval");
  expect(APPROVED).toBe("monastery:approved");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/labels.test.ts`
Expected: FAIL — cannot find module `../src/github/labels.js`.

- [ ] **Step 4: Write `src/github/labels.ts`**

```ts
// src/github/labels.ts
import type { MacroState } from "../types.js";

export const STATE_PREFIX = "monastery/state:";
export const stateLabel = (s: MacroState | string): string => `${STATE_PREFIX}${s}`;

/** Macro state = the single monastery/state:* label; absent => "new" (virtual new). */
export function macroStateOf(labels: string[]): MacroState {
  const hit = labels.find((l) => l.startsWith(STATE_PREFIX));
  return (hit ? hit.slice(STATE_PREFIX.length) : "new") as MacroState;
}

export const THESIS = { in: "thesis:in", out: "thesis:out", unclear: "thesis:unclear" } as const;
export const NEEDS_APPROVAL = "monastery:needs-approval";
export const APPROVED = "monastery:approved";
export const DECLINED = "monastery:declined";
export const HOLD = "monastery:hold";
```

- [ ] **Step 5: Run test to verify it passes, then commit**

Run: `npx vitest run tests/labels.test.ts`
Expected: PASS (3 tests).

```bash
git add src/types.ts src/github/labels.ts tests/labels.test.ts
git commit -m "feat: core types and label vocabulary"
```

---

### Task 3: Local store (repos config + disposable cursor)

**Files:**
- Create: `src/config/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/store.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/config/store.js";

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "monastery-"));
  return { store: new Store(dir), dir };
}

test("repos: add, list, default empty", () => {
  const { store, dir } = tmpStore();
  expect(store.listRepos()).toEqual([]);
  store.addRepo("owner/monastery");
  store.addRepo("owner/monastery"); // idempotent
  expect(store.listRepos()).toEqual(["owner/monastery"]);
  rmSync(dir, { recursive: true, force: true });
});

test("cursor: read missing returns 0, write then read round-trips, disposable", () => {
  const { store, dir } = tmpStore();
  expect(store.getCursor("owner/monastery")).toBe(0);
  store.setCursor("owner/monastery", 123);
  expect(store.getCursor("owner/monastery")).toBe(123);
  // a fresh Store over the same dir sees the persisted cursor
  expect(new Store(dir).getCursor("owner/monastery")).toBe(123);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — cannot find module `../src/config/store.js`.

- [ ] **Step 3: Write `src/config/store.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes, then commit**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (2 tests).

```bash
git add src/config/store.ts tests/store.test.ts
git commit -m "feat: local store for repos config + disposable cursor"
```

---

### Task 4: Agent provider interface + claude_code provider + fake

**Files:**
- Create: `src/provider/interface.ts`, `src/provider/claude-code.ts`, `src/provider/fake.ts`
- Test: `tests/provider.test.ts`

- [ ] **Step 1: Write `src/provider/interface.ts`**

```ts
// src/provider/interface.ts
export interface AgentConfig {
  persona: string;       // who the agent is (system-level)
  context: string;       // the task input
  artifactDir: string;   // cwd; the agent communicates by writing files here
  model: string;         // passed verbatim to the underlying agent (e.g. "haiku")
  timeoutMs?: number;
}
export interface AgentResult { artifacts: string[]; }

/** Runs one agent to completion. Output is the files it wrote into artifactDir. */
export interface AgentProvider {
  run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult>;
}
```

- [ ] **Step 2: Write the failing test (using the fake, which is the contract)**

```ts
// tests/provider.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider/fake.js";

test("FakeProvider writes the preset files into artifactDir and returns them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monastery-agent-"));
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"off-thesis"}' });
  const result = await provider.run({ persona: "p", context: "c", artifactDir: dir, model: "haiku" });
  expect(result.artifacts.map((a) => a.split("/").pop())).toContain("verdict.json");
  expect(JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")).verdict).toBe("out");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/provider.test.ts`
Expected: FAIL — cannot find module `../src/provider/fake.js`.

- [ ] **Step 4: Write `src/provider/fake.ts`**

```ts
// src/provider/fake.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentProvider, AgentResult } from "./interface.js";

/** Test double: writes a fixed set of files (name -> contents) into artifactDir. */
export class FakeProvider implements AgentProvider {
  public calls: AgentConfig[] = [];
  constructor(private files: Record<string, string>) {}
  async run(config: AgentConfig): Promise<AgentResult> {
    this.calls.push(config);
    mkdirSync(config.artifactDir, { recursive: true });
    const artifacts: string[] = [];
    for (const [name, body] of Object.entries(this.files)) {
      const p = join(config.artifactDir, name);
      writeFileSync(p, body, "utf8");
      artifacts.push(p);
    }
    return { artifacts };
  }
}
```

- [ ] **Step 5: Write `src/provider/claude-code.ts`** (real provider; mirrors petri)

```ts
// src/provider/claude-code.ts
import { execa } from "execa";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentProvider, AgentResult } from "./interface.js";

/** Spawns `claude -p` in artifactDir; the agent communicates by writing files. */
export class ClaudeCodeProvider implements AgentProvider {
  async run(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult> {
    mkdirSync(config.artifactDir, { recursive: true });
    const promptFile = join(config.artifactDir, "_prompt.md");
    writeFileSync(promptFile, `${config.persona}\n\n---\n\n${config.context}`, "utf8");

    await execa("claude", ["-p", "--model", config.model, "--output-format", "json"], {
      cwd: config.artifactDir,
      inputFile: promptFile,
      stdout: { file: join(config.artifactDir, "_claude_stdout.json") },
      stderr: "inherit",
      timeout: config.timeoutMs ?? 30 * 60_000,
      cancelSignal: signal,
      reject: false, // an exit code is not a throw; the shell judges by artifacts
    });

    return { artifacts: scanArtifacts(config.artifactDir) };
  }
}

function scanArtifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith("_") && !n.startsWith("."))
    .map((n) => join(dir, n))
    .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
}
```

- [ ] **Step 6: Run test, then commit**

Run: `npx vitest run tests/provider.test.ts`
Expected: PASS (1 test).

```bash
git add src/provider/ tests/provider.test.ts
git commit -m "feat: agent provider interface, claude_code provider, fake"
```

---

### Task 5: thesis-gate judge (run agent, read + zod-validate verdict)

**Files:**
- Create: `src/judges/thesis-gate.ts`
- Test: `tests/thesis-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/thesis-gate.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../src/provider/fake.js";
import { thesisGate } from "../src/judges/thesis-gate.js";

const issue = { number: 1, title: "add chat", body: "social chat?", labels: [], state: "open" as const };
const newDir = () => mkdtempSync(join(tmpdir(), "monastery-gate-"));

test("valid verdict.json parses to the typed verdict", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"off thesis"}' });
  const v = await thesisGate(provider, "haiku", "thesis text", issue, dir);
  expect(v).toEqual({ verdict: "out", reason: "off thesis" });
  rmSync(dir, { recursive: true, force: true });
});

test("missing verdict.json => null (treated as skip+alert upstream)", async () => {
  const dir = newDir();
  const v = await thesisGate(new FakeProvider({}), "haiku", "t", issue, dir);
  expect(v).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("invalid schema => null", async () => {
  const dir = newDir();
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"maybe"}' });
  const v = await thesisGate(provider, "haiku", "t", issue, dir);
  expect(v).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/thesis-gate.test.ts`
Expected: FAIL — cannot find module `../src/judges/thesis-gate.js`.

- [ ] **Step 3: Write `src/judges/thesis-gate.ts`**

```ts
// src/judges/thesis-gate.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue } from "../types.js";

const VerdictSchema = z.object({
  verdict: z.enum(["in", "out", "unclear"]),
  reason: z.string().min(1),
});
export type ThesisVerdict = z.infer<typeof VerdictSchema>;

const PERSONA = [
  "You are monastery's thesis gate.",
  "Decide whether a GitHub issue is in-scope for this repo, judged ONLY against its thesis.",
  "You have no GitHub access; you only read the input and write one file.",
].join(" ");

/** Runs the gate agent and returns the validated verdict, or null on missing/invalid output. */
export async function thesisGate(
  provider: AgentProvider,
  model: string,
  thesis: string,
  issue: Issue,
  artifactDir: string,
): Promise<ThesisVerdict | null> {
  const context = [
    `<thesis>\n${thesis}\n</thesis>`,
    `<issue number="${issue.number}">\ntitle: ${issue.title}\n\n${issue.body}\n</issue>`,
    `Write ONLY the file verdict.json with this exact shape and nothing else:`,
    `{ "verdict": "in" | "out" | "unclear", "reason": "<=2 sentences citing the thesis" }`,
    `"in" = clearly within the thesis. "out" = conflicts with / outside it. "unclear" = the thesis does not decide.`,
  ].join("\n\n");

  await provider.run({ persona: PERSONA, context, artifactDir, model });

  const p = join(artifactDir, "verdict.json");
  if (!existsSync(p)) return null;
  const parsed = VerdictSchema.safeParse(safeJson(readFileSync(p, "utf8")));
  return parsed.success ? parsed.data : null;
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }
```

- [ ] **Step 4: Run test to verify it passes, then commit**

Run: `npx vitest run tests/thesis-gate.test.ts`
Expected: PASS (3 tests).

```bash
git add src/judges/thesis-gate.ts tests/thesis-gate.test.ts
git commit -m "feat: thesis-gate judge with zod-validated file output"
```

---

### Task 6: GitHub adapter interface + in-memory fake

**Files:**
- Create: `src/github/adapter.ts`, `src/github/fake.ts`
- Test: `tests/github-fake.test.ts`

- [ ] **Step 1: Write `src/github/adapter.ts`** (interface only)

```ts
// src/github/adapter.ts
import type { Issue } from "../types.js";

/** The ONLY surface that writes to GitHub. M1 needs exactly these operations. */
export interface GitHubAdapter {
  listOpenIssues(repo: string, sinceMs: number): Promise<Issue[]>;
  addLabel(repo: string, num: number, label: string): Promise<void>;
  removeLabel(repo: string, num: number, label: string): Promise<void>;
  /** Find-or-create monastery's single sticky panel comment; edit in place. */
  upsertPanel(repo: string, num: number, body: string): Promise<void>;
  /** An official, outward comment (gated action). */
  postComment(repo: string, num: number, body: string): Promise<void>;
  closeIssue(repo: string, num: number): Promise<void>;
  readThesis(repo: string): Promise<string>;
}
```

- [ ] **Step 2: Write the failing test for the fake**

```ts
// tests/github-fake.test.ts
import { expect, test } from "vitest";
import { FakeGitHub } from "../src/github/fake.js";
import { stateLabel } from "../src/github/labels.js";

test("labels add/remove are reflected on the issue", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await gh.addLabel("o/r", 1, stateLabel("triaged"));
  await gh.addLabel("o/r", 1, "thesis:out");
  await gh.removeLabel("o/r", 1, "thesis:out");
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toEqual(["monastery/state:triaged"]);
});

test("close removes the issue from open list and records the close", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await gh.postComment("o/r", 1, "reason");
  await gh.closeIssue("o/r", 1);
  expect(await gh.listOpenIssues("o/r", 0)).toEqual([]);
  expect(gh.comments[1]).toContain("reason");
  expect(gh.closed).toContain(1);
});

test("upsertPanel writes once then edits in place (single panel)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 1, title: "x", body: "y", labels: [], state: "open" }] });
  await gh.upsertPanel("o/r", 1, "v1");
  await gh.upsertPanel("o/r", 1, "v2");
  expect(gh.panels[1]).toBe("v2");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/github-fake.test.ts`
Expected: FAIL — cannot find module `../src/github/fake.js`.

- [ ] **Step 4: Write `src/github/fake.ts`**

```ts
// src/github/fake.ts
import type { GitHubAdapter } from "./adapter.js";
import type { Issue } from "../types.js";

/** In-memory GitHub for deterministic engine tests. */
export class FakeGitHub implements GitHubAdapter {
  private issues: Map<number, Issue> = new Map();
  public panels: Record<number, string> = {};
  public comments: Record<number, string[]> = {};
  public closed: number[] = [];
  constructor(private opts: { thesis: string; issues: Issue[] }) {
    for (const i of opts.issues) this.issues.set(i.number, { ...i, labels: [...i.labels] });
  }
  async listOpenIssues(): Promise<Issue[]> {
    return [...this.issues.values()].filter((i) => i.state === "open").map((i) => ({ ...i, labels: [...i.labels] }));
  }
  async addLabel(_r: string, n: number, label: string): Promise<void> {
    const i = this.must(n); if (!i.labels.includes(label)) i.labels.push(label);
  }
  async removeLabel(_r: string, n: number, label: string): Promise<void> {
    const i = this.must(n); i.labels = i.labels.filter((l) => l !== label);
  }
  async upsertPanel(_r: string, n: number, body: string): Promise<void> { this.panels[n] = body; }
  async postComment(_r: string, n: number, body: string): Promise<void> {
    (this.comments[n] ??= []).push(body);
  }
  async closeIssue(_r: string, n: number): Promise<void> { this.must(n).state = "closed"; this.closed.push(n); }
  async readThesis(): Promise<string> { return this.opts.thesis; }
  private must(n: number): Issue { const i = this.issues.get(n); if (!i) throw new Error(`no issue ${n}`); return i; }
}
```

- [ ] **Step 5: Run test, then commit**

Run: `npx vitest run tests/github-fake.test.ts`
Expected: PASS (3 tests). (`comments[1]` is an array; `toContain("reason")` matches the element.)

```bash
git add src/github/adapter.ts src/github/fake.ts tests/github-fake.test.ts
git commit -m "feat: GitHub adapter interface + in-memory fake"
```

---

### Task 7: issueStep (L1) macro state machine

**Files:**
- Create: `src/engine/issue-step.ts`
- Test: `tests/issue-step.test.ts`

The M1 transitions (from spec §5.2):
- `new` (virtual new = no state label) → run thesis-gate → set `thesis:*` + `monastery/state:triaged`. For `out`, also write the close+reason draft into the panel and add `needs-approval`. Returns `progressed`.
- `triaged` + `needs-approval` + no `approved` → `waiting: human`.
- `triaged` + no proposal (thesis in/unclear) → parked: `noop` (L0 won't even select it; see Task 8).
- `approved` (i.e. `needs-approval` removed and `monastery:approved` added) → post official reason comment + close + set `monastery/state:done` → `done`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/issue-step.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { issueStep } from "../src/engine/issue-step.js";

const ctx = (gh: FakeGitHub, provider: FakeProvider) => ({
  repo: "o/r", gh, provider, model: "haiku",
  artifactRoot: mkdtempSync(join(tmpdir(), "monastery-step-")),
});

test("virtual new + thesis:out -> triaged, panel draft, needs-approval", async () => {
  const gh = new FakeGitHub({ thesis: "AI maintainer only", issues: [{ number: 1, title: "chat", body: "social chat", labels: [], state: "open" }] });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"social chat is off-thesis"}' });
  const c = ctx(gh, provider);
  const out = await issueStep(c, 1);
  expect(out).toEqual({ kind: "progressed" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("thesis:out");
  expect(i.labels).toContain("monastery/state:needs-approval"); // out skips triaged -> straight to needs-approval
  expect(i.labels).toContain("monastery:needs-approval");
  expect(gh.panels[1]).toContain("off-thesis"); // draft reason rendered as a `> ` line in panel
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("virtual new + thesis:in -> triaged parked (no proposal, no approval)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 2, title: "bug", body: "x", labels: [], state: "open" }] });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"within scope"}' });
  const c = ctx(gh, provider);
  await issueStep(c, 2);
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("thesis:in");
  expect(i.labels).toContain("monastery/state:triaged");
  expect(i.labels).not.toContain("monastery:needs-approval");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("needs-approval without approved -> waiting:human (idempotent, no re-propose)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 3, title: "x", body: "y", labels: ["monastery/state:triaged", "thesis:out", "monastery:needs-approval"], state: "open" }] });
  const provider = new FakeProvider({}); // must NOT be called
  const c = ctx(gh, provider);
  const out = await issueStep(c, 3);
  expect(out).toEqual({ kind: "waiting", on: "human" });
  expect(provider.calls.length).toBe(0);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("approved -> post reason + close + state:done", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 4, title: "x", body: "y", labels: ["monastery/state:needs-approval", "thesis:out", "monastery:approved"], state: "open" }] });
  // panel holds the approved draft reason as a `> ` quoted line (same shape gateNewIssue writes)
  await gh.upsertPanel("o/r", 4, "<!--monastery-state\nprotocol: gate\n-->\n**待审提议**\n\n> thanks, but out of scope");
  const c = ctx(gh, new FakeProvider({}));
  const out = await issueStep(c, 4);
  expect(out).toEqual({ kind: "done" });
  expect(gh.closed).toContain(4);
  expect(gh.comments[4]?.join("\n")).toContain("out of scope");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/issue-step.test.ts`
Expected: FAIL — cannot find module `../src/engine/issue-step.js`.

- [ ] **Step 3: Write `src/engine/issue-step.ts`**

```ts
// src/engine/issue-step.ts
import { join } from "node:path";
import type { GitHubAdapter } from "../github/adapter.js";
import type { AgentProvider } from "../provider/interface.js";
import type { Issue, Outcome } from "../types.js";
import { macroStateOf, stateLabel, THESIS, NEEDS_APPROVAL, APPROVED } from "../github/labels.js";
import { thesisGate } from "../judges/thesis-gate.js";

export interface StepCtx {
  repo: string;
  gh: GitHubAdapter;
  provider: AgentProvider;
  model: string;
  artifactRoot: string;
}

const PANEL_PREFIX = "<!--monastery-state\nprotocol: gate\n-->";

export async function issueStep(ctx: StepCtx, num: number): Promise<Outcome> {
  const issue = (await ctx.gh.listOpenIssues(ctx.repo, 0)).find((i) => i.number === num);
  if (!issue) return { kind: "noop" };
  const state = macroStateOf(issue.labels);

  switch (state) {
    case "new":
      return gateNewIssue(ctx, issue);
    case "needs-approval":
      return issue.labels.includes(APPROVED) ? executeClose(ctx, issue) : { kind: "waiting", on: "human" };
    case "triaged":
      // in/unclear with no pending proposal => parked; out should already be needs-approval.
      return { kind: "noop" };
    default:
      return { kind: "noop" };
  }
}

async function gateNewIssue(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const thesis = await ctx.gh.readThesis(ctx.repo);
  const dir = join(ctx.artifactRoot, `${issue.number}`);
  const v = await thesisGate(ctx.provider, ctx.model, thesis, issue, dir);
  if (!v) {
    await ctx.gh.upsertPanel(ctx.repo, issue.number, `${PANEL_PREFIX}\n⚠️ thesis-gate produced no valid verdict; skipped this tick.`);
    return { kind: "noop" };
  }

  await ctx.gh.addLabel(ctx.repo, issue.number, THESIS[v.verdict]);

  if (v.verdict === "out") {
    const draft = [
      PANEL_PREFIX,
      "**待审提议** — 关闭并回复（移除 `monastery:needs-approval` 改打 `monastery:approved` 即执行）：",
      "",
      `> ${v.reason}`,
    ].join("\n");
    await ctx.gh.upsertPanel(ctx.repo, issue.number, draft);
    await ctx.gh.addLabel(ctx.repo, issue.number, NEEDS_APPROVAL);
    await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("needs-approval"));
  } else {
    // in / unclear: park at triaged (M2 triager will pick this up).
    await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("triaged"));
  }
  return { kind: "progressed" };
}

async function executeClose(ctx: StepCtx, issue: Issue): Promise<Outcome> {
  const panel = (await ctx.gh.readPanel?.(ctx.repo, issue.number)) ?? "";
  const reason = extractDraft(panel) ?? "Closing as out of scope for this repo's thesis.";
  await ctx.gh.postComment(ctx.repo, issue.number, reason);
  await ctx.gh.closeIssue(ctx.repo, issue.number);
  await ctx.gh.removeLabel(ctx.repo, issue.number, stateLabel("needs-approval"));
  await ctx.gh.addLabel(ctx.repo, issue.number, stateLabel("done"));
  return { kind: "done" };
}

/** The draft reason is the last `> quoted` block in the panel. */
function extractDraft(panel: string): string | null {
  const quoted = panel.split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2));
  return quoted.length ? quoted.join("\n") : null;
}
```

- [ ] **Step 4: Extend the adapter + fake with `readPanel`** (needed by `executeClose`)

Add to `src/github/adapter.ts` interface:

```ts
  readPanel(repo: string, num: number): Promise<string>;
```

Add to `src/github/fake.ts`:

```ts
  async readPanel(_r: string, n: number): Promise<string> { return this.panels[n] ?? ""; }
```

Then remove the `?.` optional-call in `executeClose` (now that `readPanel` is required):

```ts
  const panel = await ctx.gh.readPanel(ctx.repo, issue.number);
```

- [ ] **Step 5: Run test to verify it passes, then commit**

Run: `npx vitest run tests/issue-step.test.ts`
Expected: PASS (4 tests).

```bash
git add src/engine/issue-step.ts src/github/adapter.ts src/github/fake.ts tests/issue-step.test.ts
git commit -m "feat: L1 issueStep macro state machine (thesis-gate path)"
```

---

### Task 8: reconcile (L0) — worklist, cap, ReconcileResult

**Files:**
- Create: `src/engine/reconcile.ts`
- Test: `tests/reconcile.test.ts`

L0 picks the worklist for one repo: **virtual-new issues** (no `monastery/state:*` label) and **approved issues** (`monastery:approved` present, state still `needs-approval`). It caps the count at `MAX_ITEMS_PER_TICK`, runs `issueStep` on each, aggregates outcomes, and derives `nextPollMs`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/reconcile.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { reconcile, MAX_ITEMS_PER_TICK } from "../src/engine/reconcile.js";

const baseCtx = (gh: FakeGitHub, provider: FakeProvider) => ({
  repo: "o/r", gh, provider, model: "haiku", artifactRoot: mkdtempSync(join(tmpdir(), "monastery-rec-")),
});

test("processes virtual-new issues and reports advanced count", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "a", body: "b", labels: [], state: "open" },
    { number: 2, title: "c", body: "d", labels: ["monastery/state:done"], state: "open" }, // not runnable
  ]});
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"ok"}' });
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(1);
  expect(provider.calls.length).toBe(1); // only the virtual-new issue
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("caps work per tick at MAX_ITEMS_PER_TICK", async () => {
  const issues = Array.from({ length: MAX_ITEMS_PER_TICK + 5 }, (_, k) => ({
    number: k + 1, title: "t", body: "b", labels: [], state: "open" as const,
  }));
  const gh = new FakeGitHub({ thesis: "T", issues });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"ok"}' });
  const c = baseCtx(gh, provider);
  const r = await reconcile(c);
  expect(r.advanced).toBe(MAX_ITEMS_PER_TICK);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("only waiting items => idle true, long backoff", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [
    { number: 1, title: "x", body: "y", labels: ["monastery/state:needs-approval", "thesis:out"], state: "open" },
  ]});
  const c = baseCtx(gh, new FakeProvider({}));
  // needs-approval but NOT approved => not in worklist; nothing advances
  const r = await reconcile(c);
  expect(r.advanced).toBe(0);
  expect(r.idle).toBe(true);
  expect(r.nextPollMs).toBeGreaterThanOrEqual(3600_000);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile.test.ts`
Expected: FAIL — cannot find module `../src/engine/reconcile.js`.

- [ ] **Step 3: Write `src/engine/reconcile.ts`**

```ts
// src/engine/reconcile.ts
import type { ReconcileResult, WaitReason } from "../types.js";
import { macroStateOf, APPROVED } from "../github/labels.js";
import { issueStep, type StepCtx } from "./issue-step.js";

export const MAX_ITEMS_PER_TICK = 20;

const HUMAN_BACKOFF_MS = 3_600_000;      // parked on a human (hours-scale per spec §5.4)
const NEW_ISSUE_BACKOFF_MS = 7_200_000;  // fully idle, only watching for new issues (longest)

export async function reconcile(ctx: StepCtx): Promise<ReconcileResult> {
  const open = await ctx.gh.listOpenIssues(ctx.repo, 0);

  // Runnable: virtual-new (no state label) OR approved-but-not-yet-executed.
  const runnable = open.filter((i) => {
    const st = macroStateOf(i.labels);
    if (st === "new") return true;
    if (st === "needs-approval" && i.labels.includes(APPROVED)) return true;
    return false;
  });

  const batch = runnable.slice(0, MAX_ITEMS_PER_TICK);
  const waiting: Record<WaitReason, number> = { human: 0, peer: 0, ci: 0 };
  let advanced = 0;

  for (const i of batch) {
    const out = await issueStep(ctx, i.number);
    if (out.kind === "progressed" || out.kind === "done") advanced++;
    else if (out.kind === "waiting") waiting[out.on]++;
  }

  // Count parked human-waiters across the whole repo (not just this batch) for backoff.
  for (const i of open) {
    const st = macroStateOf(i.labels);
    if (st === "needs-approval" && !i.labels.includes(APPROVED)) waiting.human++;
  }

  const idle = advanced === 0;
  const nextPollMs = !idle
    ? 60_000
    : waiting.human > 0
      ? HUMAN_BACKOFF_MS
      : NEW_ISSUE_BACKOFF_MS;

  return {
    repo: ctx.repo,
    advanced,
    waiting: (Object.entries(waiting) as [WaitReason, number][])
      .filter(([, n]) => n > 0).map(([on, count]) => ({ on, count })),
    idle,
    nextPollMs,
  };
}
```

- [ ] **Step 4: Run test to verify it passes, then commit**

Run: `npx vitest run tests/reconcile.test.ts`
Expected: PASS (3 tests).

```bash
git add src/engine/reconcile.ts tests/reconcile.test.ts
git commit -m "feat: L0 reconcile — worklist, per-tick cap, backoff result"
```

---

### Task 9: Real gh-backed GitHubAdapter (thin execa wrapper)

**Files:**
- Create: `src/github/gh-adapter.ts`
- Test: `tests/gh-adapter.test.ts` (pure command-shape assertions; no network)

We inject the command runner so we can assert the exact `gh` argv without hitting the network.

- [ ] **Step 1: Write the failing test**

```ts
// tests/gh-adapter.test.ts
import { expect, test } from "vitest";
import { GhAdapter } from "../src/github/gh-adapter.js";

function recorder() {
  const calls: { args: string[]; stdout: string }[] = [];
  const run = async (args: string[]) => {
    const planned = calls.find((c) => JSON.stringify(c.args) === JSON.stringify(args));
    return planned?.stdout ?? "";
  };
  return { calls, run };
}

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gh-adapter.test.ts`
Expected: FAIL — cannot find module `../src/github/gh-adapter.js`.

- [ ] **Step 3: Write `src/github/gh-adapter.ts`**

```ts
// src/github/gh-adapter.ts
import { execa } from "execa";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

  async listOpenIssues(repo: string): Promise<Issue[]> {
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
  // Sticky panel: find monastery's marker comment id, edit it; else create.
  async readPanel(repo: string, num: number): Promise<string> {
    const out = await this.run([
      "api", `repos/${repo}/issues/${num}/comments`,
      "--jq", `[.[] | select(.body | startswith("${PANEL_MARKER}"))][0].body // ""`,
    ]).catch(() => "");
    return out;
  }
  async upsertPanel(repo: string, num: number, body: string): Promise<void> {
    const id = await this.run([
      "api", `repos/${repo}/issues/${num}/comments`,
      "--jq", `[.[] | select(.body | startswith("${PANEL_MARKER}"))][0].id // ""`,
    ]).catch(() => "");
    if (id.trim()) {
      await this.run(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id.trim()}`, "-f", `body=${body}`]);
    } else {
      await this.run(["issue", "comment", String(num), "--repo", repo, "--body-file", "-"], body);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes, then commit**

Run: `npx vitest run tests/gh-adapter.test.ts`
Expected: PASS (3 tests). (Tests assert argv for the simple cases; panel/thesis paths are exercised by manual smoke in Task 11.)

```bash
git add src/github/gh-adapter.ts tests/gh-adapter.test.ts
git commit -m "feat: thin gh-backed GitHubAdapter (injectable runner)"
```

---

### Task 10: CLI (`step` / `repos` / `init`) + `status`

**Files:**
- Create: `src/cli/index.ts`
- Test: `tests/cli.test.ts` (argument routing only; engine already tested)

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli.test.ts
import { expect, test } from "vitest";
import { parseArgs } from "../src/cli/index.js";

test("parses `step --repo o/r --dry-run --json`", () => {
  expect(parseArgs(["step", "--repo", "o/r", "--dry-run", "--json"]))
    .toEqual({ cmd: "step", repo: "o/r", dryRun: true, json: true });
});

test("parses `repos add o/r`", () => {
  expect(parseArgs(["repos", "add", "o/r"])).toEqual({ cmd: "repos", sub: "add", repo: "o/r" });
});

test("parses bare `step`", () => {
  expect(parseArgs(["step"])).toEqual({ cmd: "step", dryRun: false, json: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — cannot find module `../src/cli/index.js`.

- [ ] **Step 3: Write `src/cli/index.ts`**

```ts
#!/usr/bin/env node
// src/cli/index.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "../config/store.js";
import { GhAdapter } from "../github/gh-adapter.js";
import { ClaudeCodeProvider } from "../provider/claude-code.js";
import { reconcile } from "../engine/reconcile.js";

export interface ParsedArgs {
  cmd: string; sub?: string; repo?: string; dryRun?: boolean; json?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  if (cmd === "repos") return { cmd, sub: rest[0], repo: rest[1] };
  const flag = (name: string) => rest.includes(`--${name}`);
  const opt = (name: string) => { const k = rest.indexOf(`--${name}`); return k >= 0 ? rest[k + 1] : undefined; };
  return { cmd, repo: opt("repo"), dryRun: flag("dry-run"), json: flag("json") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new Store(join(homedir(), ".monastery"));

  if (args.cmd === "repos") {
    if (args.sub === "add" && args.repo) store.addRepo(args.repo);
    else if (args.sub === "remove" && args.repo) store.removeRepo(args.repo);
    console.log(store.listRepos().join("\n"));
    return;
  }

  if (args.cmd === "step") {
    const repos = args.repo ? [args.repo] : store.listRepos();
    const gh = new GhAdapter();
    const provider = new ClaudeCodeProvider();
    const model = process.env.MONASTERY_MODEL ?? "haiku";
    const results = [];
    for (const repo of repos) {
      const ctx = { repo, gh, provider, model, artifactRoot: mkdtempSync(join(tmpdir(), "monastery-")) };
      results.push(await reconcile(ctx)); // NOTE: --dry-run handled in a follow-up; M1 ships apply-only first
    }
    console.log(args.json ? JSON.stringify(results, null, 2) : summarize(results));
    return;
  }

  console.error(`unknown command: ${args.cmd}`);
  process.exit(1);
}

function summarize(results: { repo: string; advanced: number; idle: boolean; nextPollMs: number }[]): string {
  return results.map((r) => `${r.repo}: advanced=${r.advanced} idle=${r.idle} next=${Math.round(r.nextPollMs / 1000)}s`).join("\n");
}

// Only run when invoked as the binary (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run test, build, then commit**

Run: `npx vitest run tests/cli.test.ts && npm run build`
Expected: PASS (3 tests); build emits `dist/cli/index.js`.

```bash
git add src/cli/index.ts tests/cli.test.ts
git commit -m "feat: CLI step/repos routing (apply-only M1)"
```

---

### Task 11: CI + monastery's own thesis + README; full green

**Files:**
- Create: `.github/workflows/ci.yml`, `.monastery/thesis.md`, `README.md`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20", cache: "npm" }
      - run: npm ci
      - run: npm test
      - run: npm run build
```

- [ ] **Step 2: Write `.monastery/thesis.md`** (monastery governs itself — dogfood)

```markdown
# monastery — Thesis

monastery is an AI maintainer that helps a repository govern itself. Its job is to
keep a repo's work aligned to *that repo's own thesis*: triage incoming issues, propose
fixes, and prepare releases — always with a human approving every outward, irreversible action.

## In scope
- Per-repo issue triage against the repo's thesis (the thesis gate).
- Proposing changes as draft PRs that a human reviews and merges.
- Coordinating across repos purely through GitHub.

## Out of scope (reject at the gate)
- Becoming an autonomous merger: monastery never performs irreversible/outward actions
  (merge, close, official reply) without explicit human approval.
- Features unrelated to repo self-governance (chat, social, generic app features).
- A second source of truth: all durable state lives in GitHub.

A feature request that does not serve "a repository governing itself against its thesis"
is `out`.
```

- [ ] **Step 3: Write a minimal `README.md`**

```markdown
# monastery

> Monastery: where repositories learn to govern themselves.

An AI repo maintainer. Per-repo reconciler, GitHub as sole source of truth, agent-layer
provider abstraction (default: `claude_code`). Design: `docs/superpowers/specs/2026-06-05-monastery-v0-design.md`.

## Usage (M1)
```bash
monastery repos add <owner>/<repo>   # manage a repo
monastery step --repo <owner>/<repo> # run one reconcile tick (cron/bot invokes this)
```
Approve a proposed close on GitHub: remove `monastery:needs-approval`, add `monastery:approved`.
```

- [ ] **Step 4: Run the full suite + build**

Run: `npm test && npm run build`
Expected: all suites PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .monastery/thesis.md README.md
git commit -m "ci: GitHub Actions; add monastery's own thesis and README"
```

---

## Done criteria (M1)

- `monastery repos add <repo>` then `monastery step --repo <repo>` triages every virtual-new open issue: gates it, labels `thesis:*` + `monastery/state:triaged`, and for `out` posts a panel draft + `monastery:needs-approval`.
- Applying `monastery:approved` (removing `needs-approval`) causes the next `step` to post the official reason, close the issue, and set `monastery/state:done`.
- `in`/`unclear` issues rest at `monastery/state:triaged` (entry point for M2's triager).
- All logic is green under `npm test` against fakes; `gh`/`claude` live only behind injected adapters.
- monastery's own repo is the first managed repo (dogfood), and CI runs the suite on every PR.

## Deferred to later milestones (explicitly NOT in M1)

- `--dry-run` intended-action printing (the engine currently applies; add a `Plan`/no-op
  GitHubAdapter wrapper in a follow-up — Task in M1.1 if desired).
- `status` command detail, approval timeout, `monastery:declined` handling.
- triager (M2), patch protocol (M3), Signal/coordination (M4), full budget (M5).
```
