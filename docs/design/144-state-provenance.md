# #144 机器消息信封 —— A1 收敛 + A3 单一状态源派生(本轮实现设计)

> 父提案:[#144](https://github.com/xforce-io/monastery/issues/144)(issue body 为信封总设计的单一真理源)。
> 本文件只覆盖 #144 的**一个切片**:A1(markers 收敛)+ A3(可见头/标签/机器块由同一状态对象派生)。
> 上一轮(`35a9afd` / `9988764`)已落 provenance 的 `agent`/`model` 字段;本轮在其之上做状态收敛。

## 范围

**做**:A1 markers 收敛 + A3 单一状态源派生 + 一致性测试。
**不做(留后续 issue)**:`provider` 字段、`run`/`attempt`/`correlationId` 幂等键、zod schema 化解析、`kind` 富分类(失败子类)、PROTOCOL「机器消息信封」专节扩写、类 B backlog 视图字形统一。

「类 A vs 类 B」区分(本轮只动类 A):
- **类 A —— 真·GitHub 机器消息**:可见头 + 标签 + `<!--monastery-state-->` 机器块三者并存、会互相漂移。这是提案硬约束的标的。
- **类 B —— 内部 backlog 视图字形**:`reconcile.ts`、`issue-step.ts` 的 `rationale` 串、`cli/backlog.ts` 的 CLI 行。不发 GitHub、不带机器块、无标签,无漂移风险。本轮不动。

## 1. 契约:`StateStatus` 闭集 + 派生表

`src/shell/messages.ts` 新增闭集类型与纯派生函数,作为可见头/标签/机器块的**唯一真理源**:

```ts
export type StateStatus = "awaiting-approval" | "blocked" | "done" | "note";
export function deriveState(status: StateStatus): {
  head: string;                                   // 通用可见头前缀
  kind: StateMessageKind;                          // 机器块 kind,兼容旧读者
  labels: { add?: string; remove?: string };       // 标签调和操作
};
```

| status | head(可见头常量) | kind | labels |
|---|---|---|---|
| `awaiting-approval` | 沿用 #90 banner 原文:`⏳ **NEEDS YOUR APPROVAL** — 👍 this comment to approve · 👎 to decline · 👀 to send back for revision` | `approval` | add `monastery:needs-approval` |
| `blocked` | `⚠️ **需要人工介入 / needs a human**` | `note` | add `monastery:needs-human` |
| `done` | `✅ **已完成 / done**` | `note` | remove `monastery:needs-approval` |
| `note` | 无横幅前缀(空 head) | `note` | 无 |

`head` 是通用前缀;消息的具体细节(blocked 的哪几条 blocking / 第几轮、done 的 PR 链接等)仍在 `body`。`awaiting-approval` 保留 #90 操作指引原文不动。

## 2. `messages.ts` API 改造

- `renderStateMessage` 入参由 `{ kind, ... }` 改为 `{ status, action?, spec?, agent?, model?, body }`:
  - 内部 `const { head, kind } = deriveState(status)`;
  - 输出时**前置 head**(head 非空时 `${head}\n\n${body}`,否则仅 body);
  - 机器块新增 `status: <status>` 行;`kind:` / `protocol:` 仍照旧写(旧读者兼容);`v: 1` 不变(纯增字段,行解析器对未知/缺失行容忍)。
- `parseStateMessage` 增解析 `status`(存在则返回;旧块无 `status` 则 `undefined`);`kind` 仍返回,`isStateMessage` / `approvalKind` / `approvalSpecVersion` / `latestApprovalGate` 等下游不动。
- `StateMessage` 接口新增可选 `status?: StateStatus`。

**A1 markers 收敛**:`export const STATE_MARKER = "<!--monastery-state"`;`src/github/gh-adapter.ts:13` 改为 `import { STATE_MARKER }`,删除本地 `PANEL_MARKER` 字面量副本。`src/shell/markers.ts` 的 `MONASTERY_MARKER_PREFIX` 保持现状(它是更上层的「任意 monastery marker」前缀,与 `STATE_MARKER` 不冲突)。

## 3. 调用点迁移表(仅类 A)

标签一律改取 `deriveState(status).labels`,调用点不再手写 `NEEDS_APPROVAL`/`NEEDS_HUMAN` 常量;provenance(`agent`/`model`)随状态对象一起传(沿用上一轮管线)。

| 站点 | 现状 | → status | 备注 |
|---|---|---|---|
| `actions.ts` `proposeGate` | 手搓 banner + addLabel(needs-approval) + kind approval | `awaiting-approval` | |
| `actions.ts` `executeSafe` `panel` | kind note | `note` | |
| `issue-step.ts:147-149` fail 阈值到顶 | ⚠️ note,**漏 needs-human 标签** | `blocked` | **行为修正**:标签补上 |
| `issue-step.ts:312-316` missing approved spec | markNeedsHuman + ⚠️ note | `blocked` | 已加标签,仅统一渲染 |
| `issue-step.ts:285-291` 门通过后改写面板 | ✅ 串 + removeLabel(needs-approval) | `done` | |
| `issue-step.ts:340-344` declined 面板 | note | `note` | declined 标签操作**原样保留**,不入闭集 |
| `patch.ts` `markNeedsHuman` 各升级(`reviewPanel` / 无变更到顶) | ⚠️ + needs-human | `blocked` | |
| `patch.ts` 未到阈值瞬态告警(made no changes N/3) | ⚠️ note,无标签 | `note` | **行为修正**:去掉误导性 ⚠️(重试无需人工) |
| `patch.ts` `reviewerNote`/`patchNote`/`reviewSummary` FYI | note | `note` | provenance 不变 |

## 4. 错误处理 / 兼容

- 旧 v1 块(上一轮 `agent`/`model`,无 `status`):parse 正常,`status` 为 `undefined`,`kind` 照旧 —— 零破坏。
- v0 块(仅 `protocol`):路径不变。
- `done`/`blocked` 标签调和保持幂等(add/remove 在 FakeGitHub 与真 adapter 均幂等)。
- panel-vs-comment 的 posting 区别不动:`awaiting-approval` 用 `postComment`,其余 `upsertPanel`。

## 5. 测试

- **一致性测试(A3 核心,新增)**:对每个 `StateStatus`,断言 `renderStateMessage` 产出的可见头、`parseStateMessage` 回读的 `status`/`kind`、`deriveState(status).labels` 三者与派生表匹配 —— 锁死「不漂移」。
- `issue-step.ts:149` 回归:fail 到顶后断言 `needs-human` 标签**确实被加**(回归当前漏标签 bug)。
- `patch.ts` 瞬态告警:断言未到阈值的告警面板**不**加 needs-human 标签、`status` 为 `note`。
- 各迁移站点更新现有断言:面板/评论能解析出预期 `status`。
- A1:`gh-adapter` 经由 `import { STATE_MARKER }` 与 `messages.ts` 同源(类型层即可,无需运行时测试)。

## 验收

- 类 A 所有外发机器消息的可见头、标签、机器块均由 `deriveState(status)` 一处派生,存在一致性测试。
- `grep '<!--monastery-state' src/` 仅命中 `messages.ts` 的定义点(`STATE_MARKER` + `STATE_RE`),不再有散落副本。
- `issue-step.ts:149` 的漏标签漂移被修正并有回归测试。
