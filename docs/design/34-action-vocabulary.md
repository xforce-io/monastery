# #34 · 动作词表 + 安全分级（薄壳第一块地基）

> Epic: #34（v2 薄治理外壳）· Branch: `feat/34-v2-thin-shell` · 状态：设计已批准，待实现
> 北极星见 `docs/superpowers/specs/2026-06-06-monastery-v2-thin-shell.md`。本模块是 agent↔外壳的**接口**。孵化期，不顾向后兼容。

## 1. 目标

把"agent 提议什么、外壳怎么执行、哪些必须人放行、怎么不重复做"收敛成一个**小而确定、可测**的模块——薄壳的接口层。**不含** agent 推理、不含引擎重写（后续）。

## 2. 动作集

### 2.1 agent 能提议的
```ts
type Action =
  | { kind: "reply";       num: number; toCommentId: string; body: string }
  | { kind: "relabel";     num: number; add: string[]; remove: string[] }
  | { kind: "panel";       num: number; body: string }                     // 单条 sticky 状态/草稿
  | { kind: "openDraftPR"; num: number; branch: string; title: string; body: string }
  | { kind: "propose";     num: number; proposal: GatedKind; draft: string } // 摆一个待人放行的提议
  | { kind: "implement";   num: number };                                   // 交外壳 patcher 写码、开 draft PR（#43）

type GatedKind = "close" | "merge";
```
- `propose` 是 agent 请求 gated 动作的**唯一**途径——它只能"摆出提议"，碰不到执行。
- `implement` 不写码本身，它是 agent **请求外壳跑 patcher** 的途径：外壳在沙箱 clone 里跑写码 agent、自审（#22）、开**人合的 draft PR**。agent 始终不碰 git/gh（§3），产物经人 Merge 才进 main（§4）。

### 2.2 安全分级
`reply`/`relabel`/`panel`/`openDraftPR`/`propose` 都是 **SAFE**（外壳 `executeSafe` 当场执行的廉价幂等 GitHub 写）。`implement` 是**外壳独占的重执行器**——引擎路由到 `runImplement`（`src/engine/patch.ts`），**不**走 `executeSafe`（给它会抛错）；其产物 draft PR 仍受 §4 人闸。gated 执行（doClose/doMerge）**不在 Action 里**——见 §4。

## 3. `executeSafe`：执行 + 幂等

```ts
async function executeSafe(gh: GitHubAdapter, repo: string, a: Action): Promise<void>
```
逐 kind 的幂等：

| kind | 幂等做法 |
|---|---|
| `reply` | body 带 `<!--monastery-reply to=<toCommentId>-->`；先查该 issue 评论里有无引用此 id 的回复，有则跳过 |
| `relabel` | addLabel/removeLabel 天然幂等（adapter 已去重） |
| `panel` | `upsertPanel`（find-or-edit 单条 sticky，天然幂等） |
| `openDraftPR` | 先 `findPrForBranch`，有则不重开 |
| `propose` | `upsertPanel(marker(proposal) + draft)` + `addLabel needs-approval`（panel marker 幂等） |

**所有外壳发出的评论都带 `<!--monastery...-->` marker**（reply 带 reply-marker，panel 带 panel-marker），因此"人类评论 = 无 marker"这条恒成立（单账号下区分人/bot 的根基）。

## 4. gated 执行器（外壳独有，人类信号触发，agent 碰不到）

```ts
async function doClose(gh, repo, num, reason): Promise<void>  // close-first 幂等 + 发理由
async function doMerge(gh, repo, pr): Promise<void>          // prState 查已合则跳过
```
- **不导出给 agent，不在 Action union 里**——这就是"强制 gate"：代码层面**没有**让 agent 触发它的路径。
- **何时调**由引擎按人类信号决定（§5），不在本模块。

## 5. 人类信号检测（本模块只定义读接口，触发逻辑属引擎）

- **PR Merge** → `gh.prState(branch) === "merged"`（#31 已有）。
- **issue 👍** → 新增 `gh.reactions(repo, commentId) → string[]`，读 monastery propose 评论的 reaction，含 `+1` 即放行。
- 引擎：见到 `needs-approval` 的 item，按其 propose 的 `GatedKind` + 对应信号 → 调 `doClose`/`doMerge`。**本模块只提供 `doClose`/`doMerge`/`reactions` 读接口；连线在引擎重构那块。**

## 6. 范围外（后续 #34 子块）
- maintainer agent（产 Action 的推理）。
- 引擎重写（发现 item → 调 agent → executeSafe / 信号→gated）。
- 删除老 judge（thesis-gate/triager）与 DISPATCH 状态机。

## 7. 测试
- `executeSafe` 各 kind × 幂等：fake gh，断言重复调不产生重复副作用（reply 不重发、openDraftPR 不重开、propose 的 panel upsert 一次）。
- `doClose`/`doMerge` 幂等（已合/已关 → 跳过）。
- `reply` marker：body 含 `to=<id>`；存在引用同 id 的回复时跳过。

## 8. 文件
- 新增 `src/shell/actions.ts`（Action 类型、SAFETY、executeSafe、doClose、doMerge）。
- `GitHubAdapter` 新增 `reactions`（+ gh/fake/dry-run）；`prState` 复用 #31。
- 测试 `tests/actions.test.ts`。

## 关联
- 北极星 #34 文档；泛化自 #23（闸门）+ #31（PR 检测）；marker 幂等承自现有 panel 机制。
