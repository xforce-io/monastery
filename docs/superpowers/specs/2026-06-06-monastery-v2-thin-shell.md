# monastery v2 架构北极星：薄治理外壳 + 一个 agent

> Epic: #34 · 状态：北极星已批准，重构方案待审
> 本文档**精炼并部分取代** v0 设计（`2026-06-05-monastery-v0-design.md`）中"多 judge + 富生命周期状态机"那部分的取向。v0 的治理脊柱保留；v0 的推理脚手架不再扩张。

## 0. 这份文档要回答的两个问题

1. **有没有过度工程？** 有——尤其是**投机性通用化**：在有真实 producer 之前就造通用 dispatch、typed proposal、needs-revision 路径；以及不断新增的 per-task judge。
2. **是不是会被更强模型吃掉的脚手架？** 大部分是。**给 LLM 推理搭的脚手架**（gate/triage/designer/responder judge、artifact 文件传递、dispatch 状态机）会随模型变强被吸收。**留下来的是模型不提供的东西：治理与安全。**

## 1. 北极星（一句话）

> **monastery = 一层薄的"安全/治理外壳"，套在一个有能力的 agent 外面。**

主轴：**外壳不信任 agent，它约束 agent。** 这是为什么模型变强不会侵蚀外壳——**越强的 agent 越需要约束，而不是越不需要**。monastery 的真正定位 = 把一个**强大、不被信任、还在变强**的 agent，安全地指向一个仓库的**治理层**。

## 2. 两层，泾渭分明

### 2.1 外壳（确定性、可测、耐用——下重注）

外壳拥有六样，全部是**对抗性稳健**的（哪怕 agent 错了、不确定、或将来更强但没对齐，照样兜得住）：

1. **状态（粗）**：只定义**外壳自己要用的**状态——`需 agent 看 / 等人放行(某动作) / 终结`。落在 GitHub（label + marker）。**不重建** `new→triaged→classified→done` 那套富语义生命周期——语义状态（是不是 bug、要不要设计）由 agent 现推。
2. **规则（不变量）**：安全/治理策略——`agent 只提议不执行`、`没放行不对外写`、`GitHub 是真相`、`崩溃可重放`。**不是**业务路由规则。
3. **幂等**：每种动作怎么不重复做（marker、`findPrForBranch`、`prState`、"已回复过这条评论吗"靠 reply-marker 从 GitHub 重建——不依赖可丢的本地 cursor）。
4. **强制 gate**：外壳**机械拦住** risky 动作（merge、close、以 repo 名义正式回复），**不管 agent 提不提议**，没拿到人类放行信号就是不执行。这是**强制**，不是信任。
5. **人类协议**：人怎么放行（**PR=Merge、issue=👍**）、monastery 怎么把提议摆出来（草稿 PR / panel 评论）、marker 约定。这套**人↔机的稳定契约**。
6. **动作词表 + 安全分级**：agent 能提议哪些动作、哪些安全可直接做、哪些 gated。这是 agent↔外壳的**接口**，规则与 gate 都挂在它上面。

### 2.2 agent（每个 item 一次调用、可换、随模型变强——交出去）

- 读 **item + 仓库(worktree) + 全部上下文**（issue/PR 正文、评论 thread、当前 GitHub 状态）。
- **自己判断下一步**：in/out？什么 type？要设计？要修？要回复？要开 PR？
- **从动作词表提议动作**（结构化输出 / tool calls）。
- **永远只提议、绝不碰 git/gh**。外壳执行：安全的当场做，risky 的等人放行。

## 3. 接口：动作词表 + 安全分级（外壳与 agent 的全部契约）

agent 的输出 = 一组**提议的动作**，每个动作的类型在外壳预定义的词表里，外壳知道它的安全级与幂等方式。示意（具体集合在重构时定）：

| 动作 | 安全级 | 幂等键 | 谁执行 |
|---|---|---|---|
| `reply(comment)` | 安全 | reply-marker(to=commentId) | 外壳直接发 |
| `editWorktree` | 安全 | 在隔离 worktree | 外壳/agent 在 worktree |
| `openDraftPR` | 安全（草稿不合并） | findPrForBranch | 外壳 |
| `propose(close/…)` | 安全（只摆提议） | panel marker | 外壳 |
| `merge` | **gated（人放行）** | prState | 外壳，仅 Merge 信号后 |
| `close` | **gated** | issue state | 外壳，仅 👍/approve 信号后 |
| `officialReply` | **gated** | marker | 外壳，仅放行后 |

外壳对 gated 动作：先**把提议摆出来**（开草稿 PR / 写 panel），然后**等人类协议里的放行信号**（Merge / 👍），收到才执行。

## 4. 生命周期：agent 推断，外壳只持粗状态

- **删掉**手搓的状态机路由（`reconcile` 里按 `macroStateOf` 分流那套）。
- 外壳每 tick：发现需关注的 item（不在"等人放行"档的）→ 调一次 agent → 拿到提议 → 安全的执行、gated 的摆出来并转入"等人放行"。
- 外壳的 item 状态只剩三档：`需 agent 看 / 等人放行(动作X) / 终结`。**富语义流转是 agent 每次看 GitHub 现推的**，外壳不存。

## 5. 现有代码：什么 KEEP、什么塌缩

**KEEP（治理脊柱，正是薄壳的骨头）：**
- **强制 gate + 人类协议**：#23 的 approve/decline 闸门思想、#31 的 PR 结局检测、`Merge`/`👍` 信号、`terminalizeDeclined` 等终结。
- **幂等**：marker、`findPrForBranch`、`prState`、reply-marker。
- **GitHub 适配层**（薄）、Workspace（隔离 worktree）、Provider 抽象（spawn agent）。

**塌缩（被模型吃掉的脚手架）：**
- `thesis-gate` / `triager` / 未来的 `designer` / `responder` 五个 judge → **一次 agent 调用 + 提议**。
- `DISPATCH` typed-proposal 状态机、`needs-revision` 等投机路径、artifact 文件传递的繁复 plumbing → 收敛到**动作词表**。
- `reconcile` 的 `macroStateOf` 富状态路由 → 三档粗状态。

## 6. 这个下注 + 何时它是错的

**下注**：模型能力会涨——让一个强 agent 端到端推理，外壳只做模型不会做的"安全/治理/幂等"。

**代价 / 取舍**：
- 每个 item 一次 agent 调用，比"便宜确定性路由 + 小 judge"**更贵**。
- 路由变非确定（agent 决定下一步），但**只提议**——治理/幂等仍确定、可测。我们**放弃测试"路由逻辑"**（那是被吃掉的部分），**保留测试"治理/副作用"**（耐用部分）。

**何时这个北极星是错的**：若模型长期**不够强**到端到端可靠推理一个仓库的维护，那"便宜确定性 + 小 judge"的 v0 路线反而更稳。判据：dogfood 中单 agent 调用的 design→fix→对话**一次成功率**是否够高（自审门 #22 是它的安全网）。

## 7. 非目标（明确不建）

- 富生命周期状态机（`new→triaged→classified→...` 的手搓路由）。
- 每类任务一个 judge。
- 在有真实 producer 之前的通用 dispatch / typed action / needs-revision。
- 框架解析 agent 数据（AGENTS.md 等）——AGENTS.md 是 agent 的，外壳不读。

## 8. 关联
- Epic #34（本文档 + 重构）。
- 治理脊柱来源：#23（闸门）、#31（PR 检测）、#22（自审安全网）、#28（命名）、#21（AGENTS.md 归 agent）。
- 重构方案（judge/dispatch → agent + 动作词表）待审，另立子 issue / 计划。
