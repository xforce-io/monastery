# 176 · 评估/执行两动词命令模型

> 状态:设计评审中
> 关联:epic #34(薄治理外壳 + 一个 agent)、#140(解耦 backlog triage 与 step 决策)、#82(backlog snapshot)
> 分支:`feat/176-assess-run-command-model`

## 1. 背景与问题

`step` 把**评估**(该不该做、根因、标签、优先级)与**动手**(relabel/propose/implement)绑在一起,评完即动手。由此产生四处耦合:

1. **数据流成环 `step → backlog → step`。** 深评埋在 step 里,其结果喂 backlog,backlog 又用来调度 step 做谁。#140 切断了"动手决策反推优先级"(`sanitizeRationale`、`deriveEntry` 仅留作 step heavy-slot 调度),但**没动评估的归属**,所以环还在。
2. **深评评完即弃。** maintainer 的根因/该不该做判断不持久化、不单独给人 review、不进 backlog。
3. **两个评估器重复。** `monastery backlog` 跑一个轻量 triage LLM(`src/agents/backlog.ts`),`step` 里 maintainer(`src/agents/maintainer.ts`)又深评一遍,各看各的,结论可能不一致。
4. **废止无处表达。** agent 没有 decline 能力(动作词表里没有),"该不该废"这个评估结论只能靠人 👎;agent 连"建议废止"都说不出口。

根因:**评估和动手是两个主体(agent 想 / 人放行后 agent 做)的不同动作,却被塞进同一个命令。**

## 2. 目标与非目标

### 目标
- 命令模型收敛为**两个动词 + 一张带状态清单**,数据流单向、评估单源。
- **想 / 算 / 做** 各归其位:评估 = 想 + 排序(算)+ 落轻动作;执行 = 做人已放行的重动作。
- **看永远便宜**(零 LLM/零 token),**算/做永远显式**(仅人触发)。
- 深评产物持久化、可被人 review、参与排序。
- decline 成为评估的**建议**,人确认才落地。

### 非目标
- 不改变"放行权在人"的宪法红线;人闸仍在 GitHub(👍/👎),不是 CLI 命令。
- 不改 patcher / reviewer agent 的职责。
- 不引入新的外部依赖。

## 3. 概念模型

```
assess(评估)  →  〔人在 GitHub 👍/👎〕  →  run(执行)
   agent 想          人放行(非 CLI)         agent 做已放行的
```

**两个动作命令:**

- **`assess`(评估)** —— 唯一"想"的地方。逐 issue 深评,产出结构化评估:scope 判定、类型、根因初判、优先级、标签建议、**是否建议废止**、rationale。随即:
  - 落**无需放行**的轻动作(relabel / reply / panel);
  - 把**需放行**的重动作(implement / rework / propose close|merge / decline)写成**提案**进清单,并在 GitHub 开 gate(`monastery:needs-approval`);
  - 确定性排序(`sortEntries`)→ 产出清单。
- **`run`(执行)** —— 只"做"。读清单,只消费**人已放行**的项(交 patcher / merge / 落 `monastery:declined`)。无已放行项即 no-op。

**一张带状态的清单(`backlog.json`):** 每行 `status ∈ {ready, pending, blocked, terminal}`。它同时是评估的产物、人 review 的纸、执行的输入。

**纯读视图(零成本):** `status`(默认入口)= 读清单 + 进度;`pending` / `blocked` 是同一张清单的过滤 lens,不是独立评估。

## 4. 语义分层:想 / 算 / 做

| 段 | 命令 | 干什么 | 性质 | 是否写 GitHub |
|---|---|---|---|---|
| 评估 | `assess` | 深评每 issue + 落轻动作 + 出重动作提案 | 想 | 是(仅轻动作 + 开 gate) |
| 排序 | (评估内收尾) | `sortEntries` 把带档 entries 排稳定序 | 算 | 否 |
| 执行 | `run` | 做人已放行的重动作 | 做 | 是 |
| 查看 | `status` | 读清单 + 进度 | 看 | 否 |
| 放行 | —(GitHub 👍/👎) | 人批准/废止提案 | 判 | 人手动 |

**排序只属于评估**;执行不排序。这要消掉现状里 `reconcile.ts` 复用 `sortEntries` 选 heavy-slot winner 的"执行段排序"。

## 5. 命令面变化

| 命令 | 现状 | 目标 |
|---|---|---|
| `assess` | —(评估埋在 step) | **新增**:评估 + 排序 → 清单 |
| `run` | `step`(评估即动手) | **改造**:纯执行人已放行项 |
| `backlog` | 会跑 LLM 的命令 | **降格**:不再是命令,是名词 `backlog.json` + 只读视图 |
| `status` | 已有 | 默认入口,纯读清单 + 进度 |
| `pending` | 已有 | 降为 `status` 的过滤 lens(便捷,可选保留) |

CLI 动作面从 `{status, backlog, pending, step}` 收敛为 `{status, assess, run}`(+ 可选 `pending` 过滤别名)。

## 6. 数据流详解

### assess
1. 触发:显式 `monastery assess`,或指纹(`backlogFingerprint`)变化时按需重算。
2. 逐 issue 深评(把 maintainer 的评估能力搬进来):产出每 issue 的评估结构。
3. 落轻动作(relabel/reply/panel)—— 无 gate,直接执行。
4. 重动作 → 写成提案进清单 + 在 GitHub 开 `monastery:needs-approval` gate。
5. `sortEntries` 排序 → 写 `backlog.json`(每行带 `status`)。

### run
1. 读 `backlog.json`。
2. 取 `status=ready`(人已 👍)的项,执行重动作:交 patcher / merge / 落 `monastery:declined`。
3. 对人已 👎 的提案:`terminalize declined`。
4. 不重排、不重评。

### status(及 pending/blocked)
- 纯读 `backlog.json` + 进度,零 LLM。
- 若从未评估(无 `backlog.json`):提示去 `assess`,**不自动重算**。

## 7. 关键不变量

- 看(status/pending/blocked)**零 LLM、零 token**。
- **排序只在评估里**;执行不排序。
- 调用图**无环**:`run` 不调 `assess`;查看不调评估。
- 宪法红线不变:agent 只 propose;放行/废止在人;decline 是评估**建议**,人确认才落地。
- `deriveEntry` / `sanitizeRationale`(#140 为 step 调度保留的投影)随 step 拆解一并清理或迁移——清单的优先级此后来自 `assess`,不再从动作反推。

## 8. 受影响模块

- `src/cli/index.ts` —— 命令面增删(assess/run/status,移除 backlog 命令)。
- `src/engine/reconcile.ts`、`src/engine/issue-step.ts` —— 拆"评估"与"执行";去掉执行段排序。
- `src/engine/backlog.ts` —— `refreshBacklog` 升级为评估产物的生成;`deriveEntry`/`sanitizeRationale` 清理。
- `src/agents/maintainer.ts`、`src/agents/backlog.ts` —— 评估器收敛为单源(见开放点 4)。
- `.claude/skills/monastery/SKILL.md` —— 命令映射表更新(默认入口 status,assess/run 显式,放行去 GitHub)。
- 可能 `docs/{CONSTITUTION,PROTOCOL,ARCHITECTURE}.md` —— 命令模型与职责分层措辞。

## 9. 待评审的开放点

1. **命令命名**:`assess`/`run` vs `evaluate`/`execute` vs 保留 `step` 作串联封装。
2. **只读别名**:保留 `backlog`/`pending` 作只读别名,还是全部并进 `status` 过滤。
3. **评估是否读代码**:决定 `assess` 成本与缓存粒度(读代码更准但更重)。
4. **agent 收敛方式**:`maintainer` 与 `backlog` 两个 agent 合并为单评估器,还是拆成"评估器 + 执行器"。
5. **迁移 UX 糖**:是否提供 `step` 兼容封装(assess → 停在人闸 → run)。

## 10. 验收标准

- `status` / `pending` / `blocked` 全程零 LLM 调用。
- 评估产物持久化为 `backlog.json` 且被 `run` 与 `status` 消费(单一真相)。
- 静态/运行期均无 `step→backlog→step` 调用环;`run` 不依赖评估路径。
- decline 可由 `assess` 产出"建议",经人确认后由 `run` 落 `monastery:declined`。
- 排序逻辑只在评估路径出现一次(执行路径无排序)。
- 命令面为 `{status, assess, run}`(+可选 pending),旧 `backlog` 命令移除或降为只读别名。

## 11. 测试策略

- 单测:`assess` 产出清单结构、状态机落点;`sortEntries` 稳定序;`run` 仅消费 ready 项、no-op 行为。
- 数据流:断言查看路径不触发 provider 调用;断言 `run` 不调用评估。
- 回归:decline 建议 → 人确认 → declined 落地的端到端路径。
