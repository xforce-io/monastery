# monastery 协议

> 人、agent、外壳三方共享的 **GitHub-可观测契约**(宪法 §7)。外壳强制它,agent 被告知它,人遵循它。
> 引擎按本协议实现。变更协议前先改本文。配套:`CONSTITUTION.md`(原则)、v2 架构(`ARCHITECTURE.md`)。

## 1. 粗状态(外壳要用的,只有三档)

一个 item(issue 或 PR)在以下之一,**全部从 GitHub 可观测**:

| 状态 | 含义 | GitHub 编码 |
|---|---|---|
| **active** | open、不在等放行 | open 且无未决 gate → 外壳调 agent |
| **awaiting-gate** | 有 gated 提议,等人放行 | `monastery:needs-approval` + 最新审批评论(`action: <kind>`) |
| **terminal** | 完结 | issue closed / `monastery:declined` / PR merged |

**富语义状态(in/out、bug/feature、设计/开发到哪了)外壳不存**——agent 每 tick 看 GitHub 现推(宪法 §8)。

## 2. 标签:控制 vs 展示

- **控制标签(外壳路由用,极少)**:`monastery:needs-approval`(等放行)、`monastery:declined`(终结)。**外壳只认这两个。**
- **展示标签(agent 维护、给人看、外壳不路由)**:`type:bug` / `thesis:in` 等。agent 可经 `relabel` 安全动作维护它们供人一眼看,但**外壳不据此分流**。

> v0 的 `monastery/state:*` 富生命周期标签 **废弃**——它是被模型吃掉的路由脚手架。

## 3. Marker(单账号下区分人/bot 的根基)

| marker | 用途 |
|---|---|
| `<!--monastery-state ...-->` | monastery 的 marker；note 用单条 sticky panel，approval gate 用新评论 |
| `<!--monastery-reply to=<id>-->` | 对某条人类评论的回复 |
| 审批评论:`protocol: approval` + `action: close\|merge\|implement\|rework` | 一个待放行的 gated 提议 |

`monastery-state` 由 `src/shell/messages.ts` 统一渲染/解析。v1 块包含 `v: 1`、`kind: note|approval`，并保留 `protocol: note|approval` 以兼容旧读者；approval 还带 `action` 和 gate 绑定的 `spec` 版本。agent 产生的 note/approval 可带 `agent`、`model` provenance。解析器必须继续读取历史 v0 块（只有 `protocol`/`action`/`spec`）。

**铁律:monastery 发的每条评论都带 marker。人类评论 = 无 marker。** 外壳/agent 据此排除自己,绝不自问自答。

### 3.1 机器消息信封(class-A v1,字段契约)

class-A 机器消息(`<!--monastery-state ...-->`)的「信封」是一组 `key: value` 行,由 `src/shell/messages.ts` 单一渲染(`renderStateMessage`)/解析(`parseStateMessage`)。这是机器之间的**唯一线格式**,人也可直接从评论读懂。

**v1 字段**

| 字段 | 含义 | 来源 |
|---|---|---|
| `v` | 信封 schema 版本(当前 `1`)。 | #144 |
| `kind` | `note` \| `approval`——消息形态。旧读者用 `protocol` 镜像同值兼容。 | #144 |
| `status` | 粗状态闭集(见下)。`status` 经 `deriveState` 单源派生出可见 head、`kind`、控制标签;字形(⏳/✅/⚠️)再经 `STATUS_GLYPH` 单源(#155)。 | #144 A3 |
| `action` | gated 动作闭集(见下),**仅 approval gate** 携带。 | #154 |
| `spec` | gate 绑定的 spec 版本;更高版本 = 另一个逻辑 gate(#95 防陈旧)。 | #95 |
| `agent` / `model` / `provider` | provenance:发出该消息的角色、模型、以及实际运行的 provider(如 `claude`/`codex`)。 | #147 / #152 |
| `correlationId` | 稳定幂等键,由 `deriveCorrelationId`(repo#num:kind[:action][@specN])生成;同一逻辑消息跨重跑同键,扫评论即可识别「已发过」——GitHub 无事务时的根缓解。 | #153 |
| `run` / `attempt` | 可选诊断维度(非重试状态机)。 | #153 |

**`status` 闭集(`STATE_STATUSES`):** `awaiting-approval` · `blocked` · `done` · `note`。
**gated 动作闭集(`GATED_KINDS`):** `close` · `merge` · `implement` · `rework`。

**解析契约(`parseStateMessage`,#154):**
- 用 zod `safeParse` 校验信封;**有但非法**的类型字段(`status`/`action`/`spec`/`run`/`attempt`)→ 整块**拒绝**(返回 `null`),绝不静默降级成半条 note(「非法块被拒,非误判」)。
- **未知键透传**(前向兼容);**历史 v0 块**(只有 `protocol`/`action`/`spec`,无 `v`/`status`)仍被容忍,因每个类型字段都可选。
- **gate↔panel 按字段切分:** `isApprovalGate`(`kind: approval`,append-only,`upsertPanel` 绝不改写)vs `isStickyPanel`(可改写的 note/blocked/done 状态面)——靠字段而非位置选面,gate 永不被面板覆盖。

> 与 class-B 标记(`monastery-reply` / `impl-rejected` / `rework` 等子串读)区分:那是另一类 marker,见 #154。

## 4. 信号(人 → 外壳,放行 gated 动作)

| 信号 | 怎么做 | 外壳 |
|---|---|---|
| **PR 通过** | 你直接在 GitHub 点 **Merge** | merge 即动作;`Closes #N` 自动关 issue。外壳检测到 merged → 落 terminal(#31) |
| **issue 提议通过** | 在最新审批评论上加 **👍** | 外壳执行提议的 gated 动作(`doClose`/`implement`) |
| **拒绝** | close PR 未合 / issue 提议上 👎 或打 `declined` | 外壳 → terminal(declined,#31 / `terminalizeDeclined`) |

> 原生 PR Approve 用不了(owner 账号不能 approve 自己的 PR),故 issue 走 👍、PR 走 Merge。

## 5. 生命周期:propose → approve → execute

```
外壳发现 active item → 调一次 agent
  agent 提议:
    - SAFE 动作(reply/relabel/panel/openDraftPR) → 外壳当场执行
    - implement → 外壳跑 patcher(沙箱写码+自审)→ 开人合的 draft PR(#43;agent 不碰 git/gh)
    - rework → 已有 open draft PR + 人类反馈时,外壳 checkout 同分支按反馈更新同一 PR(#79;非新 PR)
    - propose(close|merge) / implement / rework → 外壳摆出提议(新审批评论 + needs-approval)→ item 转 awaiting-gate
人给信号:
    👍 / Merge → 外壳执行 gated 执行器(doClose / runImplement / runRework)→ terminal/更新
    拒绝       → terminal(declined)
```

**agent 永远只到 `propose` 为止;gated 执行器外壳独有,代码层面 agent 无路径触发(宪法 §3/§4)。**

## 6. 发现(discovery)

外壳每 tick:列 open issues + monastery 开的 PR。
- **awaiting-gate** 的:查信号(👍 / Merge / 拒绝)→ 执行或继续等。**不调 agent。**
- 其余 **active** 的:调一次 agent → 执行其提议。
- **terminal** 的:忽略。
- 上限 `MAX_ITEMS_PER_TICK` 封顶。

## 7. 幂等(宪法 §6)

每个动作的幂等键**从 GitHub 可观测**:reply-marker / panel-upsert / findPrForBranch / prState / issue closed。崩溃重放绝不重复。本地 cursor 仅性能缓存,可丢、从 GitHub 重建。

## 8. 这份协议**没有**的(宪法 §8/§9)

- 富生命周期状态机 / `monastery/state:*` 路由。
- 把分类/设计/对话判断编码进外壳——那是 agent 每 tick 现推的。
- 在有真实消费者前的通用 dispatch / 投机路径。

## 关联
- 原则:`CONSTITUTION.md`。动作词表实现:`src/shell/actions.ts`(#34)。
- 终结/检测复用:#23(闸门)、#31(PR 结局)、#22(自审安全网)。
- 引擎重写按本协议实现(下一块)。
