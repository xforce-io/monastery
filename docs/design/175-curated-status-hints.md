# 175 · 策展式只读视图:每行确定性下一步提示

> 状态:设计已定,待写实现计划
> 关联:#90(awaiting-gate 直链)、#176(命令模型:status 成 backlog.json 只读视图)
> Issue:https://github.com/xforce-io/monastery/issues/175
> 分支:`feat/175-curated-status-hints`

## 1. 背景与问题

只读视图(`status` 及其 lens `pending`/`blocked`)是**平铺清单**:每行 `[优先级] #N 标题 — rationale`,不提示"这一行接下来该做什么"。于是"看"与"该做什么"脱节,靠 agent/人临场记得去拼下一步(👍 直链、`ps` 命令)。实跑中 agent 看到 `#191` 进度陈旧 47h,却把它降格成四选一菜单第四项、也没给直链——正是这个脱节。

根因:**提示靠话术(agent 记得加)而非结构(输出自带)**。话术不可靠;结构可靠。

### 顺带暴露的现状缺陷

`status` 在 backlog 快照存在时走 `formatBacklog(snapshot)` 即 `continue`,**不叠加 progress/stale**;只有"无快照"兜底分支才 `readProgress` + `enrichWithProgress`。即:新模型正常快照路径下,**stale 锁根本不显示**。本 issue 一并修。

## 2. 目标与非目标

### 目标
- 由 **CLI 确定性**(零 LLM)给只读视图每行补一条**终止式下一步提示**,让"看"自带"该做什么"。
- 提示**轻**(一短语 + 可选链接/命令),不细致。
- awaiting-gate 行的提示自带可点 👍 直链——"链接 action"做进数据,不靠话术。

### 非目标
- 不碰 `assess` / `run`(动作命令)。
- 不为提示新增任何持久化字段、不多打一次 GitHub。
- 不改命令模型(那是 #176)。

## 3. 概念模型

```
只读视图每行 = 现有行 + rowHint(entry, progressOverlay)
                          确定性 · 零 LLM · 仅用已有字段
```

`status` / `pending` / `blocked` 共用同一 `rowHint`。提示是**终止式**的:看完即知下一步,不再把决定原样丢回给人。

## 4. 提示词表(确定性映射)

| 行状态 | 判据(已有字段) | 提示 |
|---|---|---|
| awaiting-gate | `approvalCommentId` + `approvalKind`(#90) | `→ 等你 👍(<kind>) <gate 直链>` |
| 进度 stale | progress 叠加(`stale` / `pid` / `elapsed`) | `→ 进度陈旧 <Hh>,先 ps <pid>` |
| blocked | `blockedBy`(非空) | `→ 等 #X` |
| 连续失败 | `fails ≥ 阈值` | `→ 连败 N 次,可能要你看看` |
| 整仓无快照 | 无 `backlog.json` | `→ 还没评估,跑 assess`(已存在,保留) |
| 普通排队 | 其余 | (不提示) |

gate 直链复用 `pending` 同款:`https://github.com/<repo>/issues/<N>#issuecomment-<approvalCommentId>`。

提示优先级(同一行命中多条时):stale > awaiting-gate > blocked > fails。

## 5. 接线点(全在呈现层)

1. 新增纯函数 `rowHint(entry, progressOverlay) → { text, url? }`。
2. `formatBacklog` 每行尾追加 `→ <text>`(human);`--json` 每行加 `nextHint`(string)/ `nextHintUrl`(string?)。
3. `status` 快照路径补回 progress 叠加(修 stale 不可见),把叠加结果喂给 `rowHint`。
4. `pending` / `blocked` lens 复用同一 `rowHint`。

## 6. 关键不变量

- 只读视图**零 LLM、零额外 GitHub 调用**(progress 来自本地 sidecar)。
- 提示**只读已有字段**,不新增持久化。
- `rowHint` 是纯函数:同输入同输出,可单测,不触网。
- 不改动作命令面;与 #176 解耦。

## 7. 受影响模块

- `src/cli/backlog.ts` —— `formatBacklog` 行渲染 + 新增 `rowHint`;`--json` 行加字段。
- `src/cli/index.ts` —— `status` 快照路径补 progress 叠加并传入 `rowHint`。
- (lens)`pending`/`blocked` 渲染复用 `rowHint`。
- `src/types.ts` —— 若 `--json` 行字段需类型,补 `nextHint`/`nextHintUrl`(可选)。

## 8. 已定决议

1. 提示由 **CLI 生成**(非 skill 话术)。
2. **全量词表**(5 类)一次做齐——数据都白送、模板仅几行,分批不划算。
3. 提示**轻**:一短语 + 可选链接/命令,不展开。
4. 独立于 #176,自带 issue + 分支。

## 9. 验收标准

- `status`(human + `--json`)每行带 next-hint;awaiting-gate 行含可点 👍 直链。
- 快照路径下 stale 进度可见。
- 全程零 LLM、零额外 GitHub 调用(断言不触发 provider / 不新增 gh 调用)。
- `pending`/`blocked` 与 `status` 复用同一 hint 逻辑(同行同提示)。

## 10. 测试策略

- 单测 `rowHint`:每类状态 → 期望提示;多命中按优先级;无命中为空。
- 单测 gate 直链拼装正确(repo/number/commentId)。
- 回归:快照路径 stale 行现在可见且带 `ps` 提示。
- 数据流断言:只读路径不触发 provider 调用、不新增 GitHub 调用。
