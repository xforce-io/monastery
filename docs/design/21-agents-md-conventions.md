# #21 · 规范驱动：AGENTS.md 作为 per-repo 约定真相源

> Issue: #21 · Branch: `feat/21-agents-md-conventions` · 状态：设计已批准，待实现
> 本文档为该 issue 的真相源；issue body 仅保留一行摘要 + 本文链接。

## 1. 问题

monastery 是 per-repo 维护者，却把"每个被管仓库自己的约定"焊死在引擎里：`src/engine/patch.ts` 硬编码分支 `monastery/fix-{n}`（line 53）、commit `fix: address #{n}`（line 107）、PR 标题 `monastery: fix #{n}`（line 135）。同时编辑 agent 在"零仓库规范"下跑（目标仓库 root 既无 AGENTS.md 也无 CLAUDE.md）。约定应属于每个被管仓库，以 `AGENTS.md`（跨工具标准）为单一真相源。

## 2. 两个独立组件（同源于目标仓库 AGENTS.md）

| 组件 | 消费者 | 机制 |
|---|---|---|
| **A** | 编辑 agent（散文规范） | provider 把 AGENTS.md surface 给底层 CLI |
| **B** | shell（命名规范，需确定性+幂等） | shell 从 AGENTS.md 约定块渲染分支/commit/PR |

## 3. 设计（已定稿）

### 决定汇总
- **A 映射落点**：provider 自包含（`run()` 内 write-then-delete CLAUDE.md），零 workspace 耦合、不污染 patch、codex no-op。
- **B 约定块形式**：AGENTS.md 里**可见**的 ```yaml fenced 块（在 `## monastery` 标题下），扁平 `key: value`，shell **手解析免 YAML 依赖**。
- **fallback**：AGENTS.md 缺失/无块/格式坏 → 逐键回落内置默认（= 现行为，向后兼容）。
- **placeholders**：仅 `{issue}` / `{slug}`（YAGNI，不做 {type}/{summary}）。

### 组件 A — Provider surface AGENTS.md

为可单测（`run()` 会 spawn 真实 `claude`，不能在单测里启），把注入抽成**导出的纯 helper**，`run()` 只调用它：

`src/provider/claude-code.ts`：
```ts
/** 若 cwd 有 AGENTS.md 且无 CLAUDE.md，写一行 `@AGENTS.md` 的 CLAUDE.md；返回清理函数。 */
export function surfaceClaudeConventions(cwd: string): () => void {
  const claudeMd = join(cwd, "CLAUDE.md");
  const inject = existsSync(join(cwd, "AGENTS.md")) && !existsSync(claudeMd);
  if (inject) writeFileSync(claudeMd, "@AGENTS.md\n", "utf8");
  return () => { if (inject) rmSync(claudeMd, { force: true }); };  // 只删我们建的
}
```
`run()` 包裹 spawn：
```ts
const cleanup = surfaceClaudeConventions(config.artifactDir);
try {
  ... existing spawn + artifact read ...
} finally {
  cleanup();   // 删除发生在任何 stagedDiff 前 -> 不污染 patch
}
```
- 只在 `cwd` 有 AGENTS.md 且无 CLAUDE.md 时触发；judge 临时目录无 AGENTS.md → 自然 no-op；fix-run（也走 run()）每次自洽建删。
- `inject` 守卫保证只删我们建的（仓库自带 CLAUDE.md 不动）。
- claude 启动时把 `@AGENTS.md` import 进上下文；monastery 走 `--dangerously-skip-permissions`，import 批准框不挡。
- codex provider 原生读 AGENTS.md → 未来其 `run()` 不调此 helper（当前无 codex provider，留空）。

### 组件 B — Shell 命名从 AGENTS.md 渲染

**`src/config/conventions.ts`（纯函数，无 IO）**
```ts
export interface Conventions { branch: string; commit: string; prTitle: string; }

const DEFAULTS: Conventions = {
  branch: "monastery/fix-{issue}",
  commit: "fix: address #{issue}",
  prTitle: "monastery: fix #{issue}",
};

// 找第一个 ```yaml fenced 块，逐行解析 `key: value`（剥引号），逐键覆盖 DEFAULTS。
export function parseConventions(agentsMd: string | null): Conventions;

// kebab：小写、非 [a-z0-9] 转 '-'、合并连续 '-'、裁剪首尾 '-'、限长 40。
export function slugify(title: string): string;

// 替换 {issue} / {slug}。
export function render(template: string, vars: { issue: number; slug: string }): string;
```
键名映射：yaml `branch`/`commit`/`pr_title` → `Conventions.branch`/`commit`/`prTitle`。未知键忽略；缺键用默认。

**`GitHubAdapter.readConventions(repo): Promise<string | null>`**
仿 `readThesis`，clone 前用 gh api 读 root 的 `AGENTS.md`：
```ts
// gh-adapter
async readConventions(repo: string): Promise<string | null> {
  return this.run(["api", `repos/${repo}/contents/AGENTS.md`, "--jq", ".content"])
    .then((b64) => Buffer.from(b64.trim(), "base64").toString("utf8"))
    .catch(() => null);   // 文件不存在 -> null
}
```
加到 `adapter.ts` 接口、`dry-run.ts`（透传 inner）、`fake.ts`（`return this.files["AGENTS.md"] ?? null`，复用现有 `files` map）。

**`runPatch`（patch.ts）接线**
```
const agentsMd = await ctx.gh.readConventions(ctx.repo);
const conv = parseConventions(agentsMd);
const slug = slugify(issue.title);
const branch = render(conv.branch, { issue: issue.number, slug });
// findPrForBranch(branch) 收敛 -> clone(repo, branch) -> ...（分支名仍在 clone 前算出，幂等不破）
// commitPush 用 render(conv.commit, ...)；openDraftPR 用 render(conv.prTitle, ...)
```
替换 line 53/107/135 三处 hardcode。

## 4. 数据流

AGENTS.md 被读两次、两个消费者：① shell 经 gh api（命名，**clone 前**）② provider 从 worktree 文件系统（喂 agent，**run 时**）。同源不同途，互不耦合。

## 5. 错误处理

- AGENTS.md 缺失 → `readConventions` 返回 null → `parseConventions(null)` = DEFAULTS（现行为）。
- 有 AGENTS.md 无 ```yaml 块 / 块里无 monastery 键 → 逐键回落默认。
- provider 注入：仅当有 AGENTS.md 且无 CLAUDE.md；`finally` 保证 claude 崩了也删除注入文件。

## 6. 测试

- **`tests/conventions.test.ts`（纯）**：parse 有块/无块/null/部分键/带引号；slugify 边界（空格、符号、超长、全符号）；render 占位符。
- **`tests/provider.test.ts`**：直接测导出的 `surfaceClaudeConventions(cwd)`（不启 claude）——cwd 有 AGENTS.md 无 CLAUDE.md → 调用后 CLAUDE.md 内容为 `@AGENTS.md`，cleanup() 后被删；cwd 无 AGENTS.md → 不创建、cleanup no-op；cwd 自带 CLAUDE.md → 内容不变、cleanup 不删它。
- **`tests/gh-adapter.test.ts`**：readConventions record/replay（有/无文件）。
- **`tests/issue-step.test.ts`**：fake `readConventions` 返回自定义块 → branch/commit/prTitle 随之变（断言 `ws.cloned[0].branch`、`ws.committed[0].message`、`gh.prs[0].title`）；无 AGENTS.md（null）→ 现有 `monastery/fix-N` 默认（**现有 try-fix 测试保持绿**）。

## 7. 验收

- 目标仓库带 `## monastery` ```yaml 块定义 `branch: feat/{issue}-{slug}` → patcher 开的分支变成 `feat/6-operational-polish` 形态；commit/PR 标题同理。
- 无 AGENTS.md → 一切维持 `monastery/fix-N` 现行为（零回归）。
- 编辑 agent 在有 AGENTS.md 的仓库里跑时能看到其规范（经注入的 CLAUDE.md），且该文件不进 patch。

## 8. 实现顺序（TDD）

1. `conventions.ts`：parse + slugify + render + DEFAULTS（纯单测）
2. `GitHubAdapter.readConventions` + interface/gh/fake/dry-run（record/replay 测试）
3. provider AGENTS.md→CLAUDE.md 注入（write-then-delete，测试不残留）
4. patch.ts 接线，去三处 hardcode（fake readConventions 验证渲染 + 默认回归）

## 9. 范围外（YAGNI）
- codex provider（不存在）；`{type}`/`{summary}` 占位符；YAML 解析库；reviewer(#22) 读 AGENTS.md。

## 关联
- Issue: #21；公共讨论见 issue 评论的设计提案。
- 缘起：dogfood #6/#24 暴露 `monastery/fix-N` 不符合 `feat/{n}-{slug}` 规范。
