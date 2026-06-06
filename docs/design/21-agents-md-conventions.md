# #21 · provider 把 AGENTS.md surface 给编辑 agent

> Issue: #21 · Branch: `feat/21-agents-md-conventions` · 状态：设计已批准，待实现
> 本文档为该 issue 的真相源；issue body 仅保留一行摘要 + 本文链接。

## 1. 问题

patcher 的编辑 agent 在"零仓库规范"下跑。目标仓库 root 可能带 `AGENTS.md`（跨工具的 agent 约定标准：代码风格、测试命令、约定等），但 `claude_code` provider spawn 的 `claude -p` **只读 `CLAUDE.md`，不读 `AGENTS.md`**（官方文档："Claude Code reads CLAUDE.md, not AGENTS.md"）。于是 agent 看不到仓库自己的规范。

## 2. 设计：AGENTS.md = 纯 agent 数据，provider 自行 surface

**核心原则**：AGENTS.md 是**给 agent 的数据层**。框架（shell）**不解析**它。把它 surface 给 agent 是各 provider 的事——provider 甚至不读其内容，只让 agent 看到。

**抽象层定位**：surface AGENTS.md 是 `AgentProvider` 的**契约**，但机制**因 provider 而异**（这正是它归 provider 而非引擎的原因）。因此**不加共享接口方法**（否则 codex 的实现是空方法，别扭），改为：

- `src/provider/interface.ts` 的 `AgentProvider.run()` 加**契约注释**：
  > `run()` 负责把 `artifactDir`（cwd）下目标仓库的 AGENTS.md 规范 surface 给底层 agent（各 provider 各自的方式）。
- 各 provider 的 `run()` 内部各自履行：`claude_code` → 写 `CLAUDE.md`（下述 helper）；`codex` → 无需动作（原生读 AGENTS.md）；未来 provider → 它自己的方式。

### claude_code 的实现

为可单测（`run()` 会 spawn 真实 `claude`，不能在单测里启），把注入抽成**导出的纯 helper**：

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
- **不污染 patch**：CLAUDE.md 在 `finally` 删除，发生在 patcher 任何 `stagedDiff` 之前。

## 3. 范围外（明确划清）

- **分支 / commit / PR 命名**：这些是 **shell 的对外 git/gh 操作**。monastery 的核心命题是确定性 shell 独占所有 GitHub 写（保幂等 `findPrForBranch` 收敛、保审批治理、保状态机确定性），agent **不碰 git/gh**（PERSONA 明令）。所以命名是**框架事，与 AGENTS.md 无关**——agent 根本不创建分支，没有可 follow 的命名对象。
  - 当前保持 bot 默认 `monastery/fix-N`。若日后要 per-repo 可配，应放进 monastery **自己的框架配置**（如 `repos.json` per-repo policy），**另开 issue**，不在本 issue、不经 AGENTS.md。
- **框架解析 AGENTS.md**（原 component B：`conventions.ts` / `readConventions` / shell 渲染命名）→ **不做**，属分层错误（框架去解析 agent 的数据层）。
- **codex provider**：不存在，本 issue 不建。

## 4. 测试

- **`tests/provider.test.ts`**：直接测导出的 `surfaceClaudeConventions(cwd)`（不启 claude）——
  - cwd 有 AGENTS.md、无 CLAUDE.md → 调用后 `CLAUDE.md` 内容为 `@AGENTS.md\n`；调 cleanup() 后被删。
  - cwd 无 AGENTS.md → 不创建 CLAUDE.md；cleanup() no-op。
  - cwd 自带 CLAUDE.md → 内容不变；cleanup() 不删它。

## 5. 验收

- 目标仓库有 AGENTS.md 时，patcher 的编辑 agent 能看到其规范（经注入的 `@AGENTS.md` CLAUDE.md），且该文件不进 patch。
- 无 AGENTS.md → 现行为完全不变（零回归）。
- 仓库自带 CLAUDE.md → 不被覆盖、不被删。

## 6. 实现顺序（TDD）

1. `surfaceClaudeConventions` helper + 测试（纯，不启 claude）
2. `run()` 用 `try/finally` 包裹调用
3. `AgentProvider.run()` 接口加契约注释

## 关联
- Issue: #21；公共讨论见 issue 评论。
- 缘起 & 决策：dogfood #6/#24 引出"分支命名"讨论，最终厘清——命名归 shell（框架），AGENTS.md 仅供 agent；本 issue 只做 provider surfacing。
