# #131 · 支持 Codex provider 与 provider 健康检测 / fallback

> Issue: #131 · Branch: `feat/131-codex-provider-fallback` · 状态：已实现，待 review
> 本文档为该 issue 的真相源；issue body 仅保留一行摘要 + 本文链接。

## 1. 问题

当前 `monastery step` 的主 agent provider 在 CLI 入口硬编码为 `ClaudeCodeProvider`。这带来两个实际问题：

- `claude` CLI 不在 PATH、未登录、额度 / 服务异常、模型不可用时，整个 step 直接不可用。
- v0 设计曾把 provider 定义为可插拔，但运行时没有 provider 选择，也没有 Codex provider。

同时，Claude 与 Codex 的模型命名体系不同。如果只保留一个 `MONASTERY_MODEL` 字符串，切 provider 时会把模型配置污染到另一个 provider。

## 2. 目标 / 非目标

目标：

- 新增 `CodexProvider`，满足现有 `AgentProvider.run()` 契约。
- 启动时做 provider 健康检测，`auto` 模式下优先 Claude，Claude 不可用时使用 Codex。
- 引入模型 level：`fast` / `standard` / `strong`，支持 provider-specific model 配置。
- 保持现有 Claude 路径默认行为不变。

非目标：

- 不做运行中无缝切换。一个 `step` 进程启动时选定 provider；执行中 provider 挂了，按当前失败路径处理。
- 不引入 OpenAI / Anthropic SDK。Codex 与 Claude 一样通过本地 CLI 复用本机鉴权。
- 不改变 artifact 协议。agent 仍通过在 `artifactDir` 写文件与 shell 通信。
- 不要求所有 agent 立刻逐个配置模型。第一版只把既有 per-role override 映射到 level 默认值。

## 3. 设计：Provider 选择

新增 provider 选择模块：

`src/provider/select.ts`

```ts
export type ProviderName = "claude" | "codex";
export type ProviderMode = ProviderName | "auto";

export interface ProviderSelection {
  name: ProviderName;
  provider: AgentProvider;
  health: ProviderHealth;
}
```

环境变量：

- `MONASTERY_PROVIDER=auto|claude|codex`
- 默认：`auto`

选择规则：

1. `MONASTERY_PROVIDER=claude`：只检测 Claude；不可用则 preflight 失败。
2. `MONASTERY_PROVIDER=codex`：只检测 Codex；不可用则 preflight 失败。
3. `MONASTERY_PROVIDER=auto`：先检测 Claude；Claude 健康则使用 Claude；否则检测 Codex；Codex 健康则使用 Codex；两者都不可用才失败。

`src/cli/index.ts` 不再直接 `new ClaudeCodeProvider()`，而是：

```ts
const selection = await selectAgentProvider({ mode, modelLevel: "fast" });
const provider = selection.provider;
```

在非 JSON 模式下，如果 auto fallback 到 Codex，打印一行 stderr：

```text
[monastery] claude unavailable; using codex provider
```

JSON 模式下不得污染 stdout；如需要，写 stderr 或 phase event。

## 4. 健康检测

健康检测分两层：

### 4.1 CLI presence check

- Claude：`claude --version`
- Codex：`codex --version`
- GitHub：保持现有 `gh --version` + `gh auth status`

### 4.2 Smoke test

仅 provider 被选中或作为 fallback 候选时运行一次低成本 smoke test：

- 在临时目录创建 `AGENTS.md`（可选，验证无副作用）。
- 用 fast 模型请求 agent 写 `health.json`：

```json
{"ok": true}
```

- shell 读取并校验 JSON。
- timeout 建议 30 秒。

Smoke test 走真实 provider 的 `run()`，避免只测到 CLI 存在但认证 / 模型调用不可用。

失败处理：

- 指定 provider 模式：报该 provider 的具体失败原因。
- auto 模式：Claude smoke 失败不直接终止，继续尝试 Codex；两者都失败时汇总错误。

## 5. CodexProvider

新增文件：

`src/provider/codex.ts`

核心命令：

```bash
codex exec \
  -C "$artifactDir" \
  --sandbox workspace-write \
  --skip-git-repo-check \
  --ephemeral \
  --output-last-message "$artifactDir/_codex_last_message.txt" \
  -
```

实现要点：

- prompt 从 stdin 传入，内容与 Claude provider 一致：`persona + --- + context`。
- `cwd` / `-C` 都指向 `artifactDir`。
- 只有配置了非空模型时才传 `-m`；Codex 未配置模型时使用本机 Codex CLI 默认模型。
- `AGENTS.md` 不需要额外处理；Codex 原生读取。
- `reject: false`，保持与 Claude provider 一致：退出码不直接作为业务判定，shell 以 artifacts 为准。
- stdout / stderr scratch 文件以 `_` 开头，避免 `scanArtifacts()` 误收。
- 返回 `resultText` 时读取 `_codex_last_message.txt`。

`src/workspace/git-workspace.ts` 的 scratch 清理列表增加：

- `_codex_stdout.jsonl`
- `_codex_last_message.txt`

## 6. 模型 level

新增模型 level：

```ts
export type ModelLevel = "fast" | "standard" | "strong";
```

默认映射：

- `fast`：健康检测、轻量 structured agent、分类 / 路由。
- `standard`：maintainer / reviewer 默认。
- `strong`：patcher、复杂 self-review、失败修复。

环境变量：

```bash
MONASTERY_MODEL_FAST=...
MONASTERY_MODEL_STANDARD=...
MONASTERY_MODEL_STRONG=...

MONASTERY_CLAUDE_MODEL_FAST=haiku
MONASTERY_CLAUDE_MODEL_STANDARD=sonnet
MONASTERY_CLAUDE_MODEL_STRONG=sonnet

MONASTERY_CODEX_MODEL_FAST=...      # 可选；未设置则不传 -m，使用 Codex CLI 默认模型
MONASTERY_CODEX_MODEL_STANDARD=...
MONASTERY_CODEX_MODEL_STRONG=...
```

解析优先级：

1. repo policy 中某个 agent 明确指定 `model`
2. provider-specific level model，例如 `MONASTERY_CODEX_MODEL_STRONG`
3. generic level model，例如 `MONASTERY_MODEL_STRONG`
4. 兼容旧配置：`MONASTERY_MODEL`
5. provider 默认 level model
6. 现有硬默认：`sonnet`

第一版 agent → level 映射：

| agent | level |
|---|---|
| provider health smoke | fast |
| maintainer | standard |
| reviewer | standard |
| patcher impl / fix | strong |
| patcher self-review | strong |

保留现有 `MONASTERY_REVIEW_MODEL` 作为兼容入口；若设置，它继续覆盖 reviewer / self-review 的模型。

## 7. Preflight 改造

现有 `Need` 中的 `claude: boolean` 改为 agent provider 需求：

```ts
export interface Need {
  gh: boolean;
  agent: boolean;
}
```

`step` 需要 `{ gh: true, agent: true }`；`status` / `pending` / `init` 不需要 agent。

Preflight 输出示例：

```text
[monastery] preflight failed - missing prerequisites:
  • `gh` is installed but not authenticated. Run: gh auth login
  • no healthy agent provider found. Tried claude, codex.
    claude: `claude` is not on your PATH
    codex: smoke test failed: ...
```

## 8. 错误处理与安全

- Provider 选择只发生在进程启动时，避免 patcher 已经修改 workspace 后切换 provider 造成上下文不一致。
- Codex 使用 `--ask-for-approval never` 和 `workspace-write`，权限边界与当前自动化场景一致：只允许在 `artifactDir` 内工作。
- 不使用 `--dangerously-bypass-approvals-and-sandbox`，除非后续实测 Codex 无法完成现有 patcher 工作；若需要另开设计讨论。
- 健康检测写入临时目录，不触碰目标 repo。
- 健康检测失败不得创建 GitHub 写入副作用。

## 9. 测试策略

1. `CodexProvider` 单测：注入 fake runner，断言命令、参数、stdin prompt、cwd、timeout、artifact 扫描。
2. `CodexProvider` 读取 `_codex_last_message.txt` 作为 `resultText`。
3. `selectAgentProvider(auto)`：Claude healthy → 选 Claude，不探测 Codex smoke。
4. `selectAgentProvider(auto)`：Claude unhealthy、Codex healthy → 选 Codex。
5. `selectAgentProvider(auto)`：两者都 unhealthy → 汇总错误。
6. `MONASTERY_PROVIDER=codex`：Claude healthy 也不使用 Claude。
7. preflight：`step` 在至少一个 provider healthy 时通过；两者都失败时报 actionable error。
8. 模型解析：provider-specific level 优先于 generic level；repo policy 显式 `model` 最高优先级；旧 `MONASTERY_MODEL` 仍生效。
9. 回归：未设置任何新 env 时，Claude 可用则行为与当前一致。

## 10. 验收

- 安装并登录 Codex 后，即使本机 `claude` 不可用，`monastery step` 也能启动并使用 Codex provider。
- Claude 可用时默认仍优先 Claude。
- `MONASTERY_PROVIDER=codex` 能强制使用 Codex。
- 健康检测能在真正跑 issue 前发现 provider 不可用，并给出可执行错误信息。
- 模型配置支持 fast / standard / strong，并且 Claude / Codex 可分别配置。
- 现有测试通过，Claude 默认路径无回归。

## 11. 实现顺序

1. 抽出 provider runner 依赖，补 `CodexProvider` 单测与实现。
2. 新增模型 level 解析模块与测试。
3. 新增 provider health smoke test 与 selector。
4. 改造 preflight 与 CLI `step` provider 初始化。
5. 更新 README / help 文案。

## 关联

- Issue: #131
- 相关设计：#21 provider surface AGENTS.md；#22 patcher self-review；v0 spec 中 provider 可插拔方向。
