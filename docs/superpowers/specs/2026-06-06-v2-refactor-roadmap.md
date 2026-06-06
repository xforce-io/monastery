# v2 重构路线图

> 把"当前代码 → v2 薄壳"串成有序、可追踪的迁移。**实现** `PROTOCOL.md`,**遵循** `CONSTITUTION.md`,**架构**见 `v2-thin-shell.md`。
> 这是 v2 转型的执行总图。Epic #34。

## 0. 终态(v2 长什么样)

```
L_account: 遍历 config.repos
  L_repo (reconcile): 发现 open items → 分 active / awaiting-gate / terminal(协议三档)
    L_item (step):
      awaiting-gate → 查信号(Merge/👍/拒绝)→ doMerge/doClose/terminalize  [外壳,不调 agent]
      active        → 调一次 maintainer agent → executeSafe(它提议的 Action[])
      terminal      → 忽略
```
三层迭代骨架不变;只有 **L_item 的推理** 从"状态机+judge+dispatch"换成"一个 agent + executeSafe"。

## 1. 清点:KEEP / 塌缩 / 删

**KEEP(治理脊柱 + 接口):**
- `src/shell/actions.ts`(动作词表,#36)、governance(gates/marker/幂等,来自 #23/#31/#22)。
- `src/github/*`(adapter)、`src/workspace/*`、`src/provider/*`、`src/config/store.ts`(将重构)。

**塌缩(→ maintainer agent):**
- `src/judges/thesis-gate.ts` + `src/judges/triager.ts` → 一个 maintainer agent。
- `src/engine/issue-step.ts` 的 macroState switch + `DISPATCH` + typed-proposal → 薄 L_item。

**删:**
- 两个老 judge 文件、`DISPATCH`/`readProposalAction`/`reviseProposal` 等投机机制、`reconcile.ts` 的 `macroStateOf` 富状态路由、`monastery/state:*` 标签语义。

## 2. 有序步骤(依赖 / 体量 / 风险)

| # | 步骤 | 依赖 | 体量 | 风险 | 关键产出 |
|---|---|---|---|---|---|
| ✅ | 动作词表 | — | 中 | 低 | `src/shell/actions.ts`(#36 已合) |
| ✅ | 协议 spec | — | — | — | `PROTOCOL.md`(#37) |
| ✅ | 本地结构 | — | 小 | 低 | `Store` 重构:`config.json` + `repos/<o__r>/cache.json`;`docs/LOCAL-LAYOUT.md` |
| ✅ | reactions 读 | — | 小 | 低 | `gh.reactions(repo, commentId)`(👍 信号);+ fake/dry-run |
| ✅ | maintainer agent | 动作词表 | 大 | 中 | `src/judges/maintainer.ts`:读 item+上下文 → `Action[]`(zod);取代两 judge |
| 4 | **引擎重写** | 1·2·3 | 大 | 中高 | 三层 step 按协议;wire agent+executeSafe+信号→gated;删 macroState/DISPATCH |
| 5 | **删老 judge** | 3·4 | 小 | 低 | 删 thesis-gate/triager + 其测试;清理 |

> 1·2 小且独立,可先做、各自成 PR。3 是 keystone。4 最大,落地后 5 收尾。

## 3. 每步的"完成"判据

1. **本地结构**:`Store` 读写新布局;`config.repos` 带 per-repo policy(先只 `model`);per-repo `cache.json`(cursor+fails);旧扁平文件迁移或弃(孵化期可弃)。测试覆盖读写 + 缺省。
2. **reactions**:`reactions` 返回某评论的 reaction 列表;含 `+1` 即放行信号。record/replay 测试。
3. **maintainer agent**:给定 item+评论+(可选)仓库上下文,产出 schema 合法的 `Action[]`;契约测试(fixture → schema);至少能产 relabel/reply/propose/openDraftPR。
4. **引擎重写**:reconcile 按协议三档分;L_item 对 active 调 agent→executeSafe、对 awaiting-gate 查信号→gated;**现有"端到端"行为用 fake agent 注入 Action 验证**;删除 macroState/DISPATCH 后全测绿。
5. **删 judge**:thesis-gate/triager 及其测试删除;全测绿;dogfood 一轮确认 maintainer agent 接住。

## 4. 风险管理

- **每步保持全测绿、tsc 净、可单独 PR**(孵化期可破坏向后兼容,但不破坏"能跑")。
- **maintainer agent 的安全网 = #22 自审门**:它产的改动开 PR 前过自审;且**所有 risky 动作仍卡在人类闸门**(宪法:差 agent 也安全)。
- **dogfood 验证**:引擎重写后,在 monastery 自己身上跑一轮,看单 agent 端到端一次成功率(宪法 §6 的判据——够高则 v2 下注成立)。
- **可回退**:每步独立 PR,出问题回退单步。

## 5. 进度

- [x] 动作词表(#36)
- [x] 协议(#37)
- [x] 1 本地结构(`docs/LOCAL-LAYOUT.md`)
- [x] 2 reactions 读(`gh.reactions`,+1/-1 内容;信号解释留 step4)
- [x] 3 maintainer agent(`src/judges/maintainer.ts`;`ActionSchema` 同源)
- [ ] 4 引擎重写
- [ ] 5 删老 judge

## 关联
- 原则 `CONSTITUTION.md` · 合约 `PROTOCOL.md` · 架构 `v2-thin-shell.md` · 动作词表 `docs/design/34-action-vocabulary.md`。
- 复用治理:#23(闸门)、#31(PR 检测)、#22(自审)。
