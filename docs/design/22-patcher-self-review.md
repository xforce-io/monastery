# #22 · patcher 自审闭环（agent self-review gate）

> Issue: #22 · Branch: `feat/22-patcher-self-review` · 状态：设计已批准，待实现
> 本文档为该 issue 的**真相源**；issue body 仅保留一行摘要 + 本文链接。

## 1. 问题

patcher 在把草稿 PR 交给人 review 之前，**没有对 diff 做任何语义审查**。当前唯一质量门是：跑测试 + “no-changes 三次升级 needs-human”。

实证：dogfood #6 产出的 PR（后并入 #24）测试全绿、`tsc --noEmit` 通过，但语义上偏离了既定设计——超时路径漏打 `monastery:declined` 标签。测试门拦不住这类偏差，一道 agent review 门能拦住。

## 2. 目标 / 非目标

**目标**：在 `runPatch` 中加一道**开 PR 前的本地自审闭环**——tests 通过后、`openDraftPR` 前，由独立 reviewer 审查 diff；blocking 问题回修再审，循环至干净或到迭代上限。交给人的草稿 PR 天生是“自审过”的。

**非目标（YAGNI，后置）**：
- ensemble 多 reviewer 投票
- advisory（低优）问题的自动修复——只标注，不修
- reviewer 读 AGENTS.md 规范（依赖 #21）——本期 reviewer 仅看 diff + issue

## 3. 决定汇总（设计分叉，已与 owner 拍定）

| 分叉 | 决定 |
|---|---|
| 落点形态 | **开 PR 前的本地门**：review→fix 循环跑在 worktree，干净了才 push + 开 PR；循环零外部副作用 |
| reviewer 独立性 | **独立 `provider.run`（fresh context）**，模型 `MONASTERY_REVIEW_MODEL ?? 主模型`（可单独上 opus 审 sonnet 的活） |
| blocking 阈值 | **正确性 bug / 偏离 issue 设计·验收 / 测试假绿 / 安全** = blocking；style / 命名 / 可简化 = advisory（只标注） |
| 迭代上限 | `REVIEW_MAX_ITERS = 3`（对齐 `FAIL_THRESHOLD`）；到顶仍有 blocking → `needs-human`，**不开 PR** |

## 4. 组件

### 4.1 reviewer judge（`src/judges/reviewer.ts`）
仿现有 judge（thesis-gate / triager）形状：

- **签名**：`reviewer(provider, model, { diff, issue }, dir) -> ReviewVerdict | null`
- **运行**：独立 `provider.run`（fresh context，看不到编辑 agent 的推理），model = `ctx.reviewModel ?? ctx.model`
- **产出**：agent 写 `review.json`，shell 读回 + zod 校验
- **schema**：
  ```ts
  ReviewVerdict = {
    findings: Array<{
      severity: "blocking" | "advisory";
      title: string;
      detail: string;
      file?: string;
      line?: number;
    }>;
  }
  ```
- **persona**：审查 diff 是否：① 正确实现了 issue 的设计/验收 ② 有正确性 bug ③ 测试是否“假绿”（通过但逻辑错） ④ 安全问题。按上述 blocking/advisory 分级。
- zod 失败 / 缺 `review.json` → 返回 `null`（视为本轮 reviewer 失败，见 §6）。

### 4.2 review 循环（插进 `src/engine/patch.ts` 的 `runPatch`）
位置：现有 `runTests` 之后、`openDraftPR` 之前。

```
// tests 已通过，diff 已 stage
let review = null
for (let iter = 1; iter <= REVIEW_MAX_ITERS; iter++) {
  const diff = await ctx.ws.stagedDiff(dir)
  review = await reviewer(ctx.provider, ctx.reviewModel ?? ctx.model, { diff, issue }, reviewDir(iter))
  if (!review) break                                   // reviewer 失败 -> 保守放行（§6）
  const blocking = review.findings.filter(f => f.severity === "blocking")
  if (blocking.length === 0) break                     // 干净，出门
  if (iter === REVIEW_MAX_ITERS) {                     // 到顶仍有 blocking
    await ctx.gh.addLabel(ctx.repo, issue.number, NEEDS_HUMAN)
    await ctx.gh.upsertPanel(ctx.repo, issue.number, reviewPanel(blocking))
    return { kind: "noop" }                            // 不开 PR
  }
  // 回修：让编辑 agent 针对 blocking 再改一轮
  await ctx.provider.run({ persona: FIX_PERSONA, context: fixContext(issue, blocking), artifactDir: dir, model: ctx.model })
  const tests = await ctx.ws.runTests(dir)             // re-test
  // re-stage 在循环顶部的 stagedDiff 前发生（沿用现有“tests 后 re-stage”）
}
// 干净 / reviewer 失败 -> push + 开 PR（body 附 advisory + 各轮摘要）
```

### 4.3 PR body 透明化
最终 PR body（`openDraftPR` 的 body）在现有 diff 折叠块基础上追加：
- **review 摘要**：各轮抓到并修掉的 blocking 标题清单（补偿“人看不到驳回过程”）
- **残留 advisory**：reviewer 标注但未阻断的低优项

## 5. 接口改动

- `StepCtx` 增可选字段 `reviewModel?: string`
- `src/cli/index.ts`：构造 ctx 时注入 `reviewModel: process.env.MONASTERY_REVIEW_MODEL ?? model`
- 复用 `ws.stagedDiff` / `ws.runTests`，**不新增 workspace 能力**
- 新增 `src/judges/reviewer.ts`（judge）+ 其 zod schema

## 6. 错误处理（关键取舍）

- **reviewer 自身挂 / 输出脏（zod 失败）** → **保守放行**：不阻断，照常 push + 开 PR，但 PR body / panel 注明“⚠️ 自审未能运行”。
  - 理由：reviewer 不稳不该把整条 patch 流堵死。宁可漏一次审，不可卡死交付。
  - 与现有 judge 的“连续失败升级”不同：这里单轮失败即放行，不累计、不 needs-human（patch 本身已 tests 通过，放行风险可控）。
- **回修轮 re-test 变红** → **沿用现有行为**：测试结果只写进 PR body 的 `testLine`（“⚠️ tests FAILING”），**本身不是硬门**。门只卡 blocking findings + 迭代上限。逻辑错导致的红，reviewer 会以 blocking 形式抓出来回修；纯环境/不稳红则照常开 PR（已标注），交人判断。这样不偏离 #15 既定的“红测试也开草稿 PR、人来看”策略。
- **幂等 / 成本**：review 循环全在 push 前的本地 worktree，无外部副作用，崩溃重放安全。每轮 review + fix 各一次 LLM 调用 → `REVIEW_MAX_ITERS` 是成本闸；advisory-only 不触发回修。

## 7. 测试策略（TDD，fake provider 注入 verdict）

1. **reviewer 契约测试**：fixture diff/issue → 产出过 schema；缺 `review.json` / 脏数据 → `null`。
2. **clean verdict → 直接开 PR**（接近现状回归，确认未破坏既有 patch 流）。
3. **blocking→clean → 回修一轮后开 PR**；PR body 含被修掉的 blocking 摘要。
4. **持续 blocking → 3 轮后 `needs-human` + panel 列未解决项，不开 PR**（断言无 `openDraftPR`）。
5. **reviewer 失败（null）→ 保守放行**：照常开 PR + body 注明自审未运行。
6. **advisory-only → 不回修**，PR body 含 advisory。

## 8. 验收

- patcher 产出的草稿 PR 均已过自审；blocking 被修掉或升级 needs-human，绝不带已知 blocking 缺陷开 PR。
- 自审若早存在，会拦下 #20/#24 的 declined 漏标（属 blocking：偏离 issue 设计）。
- reviewer 不稳时交付不被堵死（保守放行 + 注明）。
- 现有“clean patch → 开 PR”路径行为不变（回归）。

## 9. 实现顺序

1. `reviewer.ts` judge + zod schema（契约测试）
2. `StepCtx.reviewModel` + CLI 注入
3. `runPatch` 插入 review 循环（fake reviewer 验证 clean / blocking→clean / 3 轮 needs-human / 失败放行）
4. PR body 附 advisory + review 摘要渲染

## 关联
- Issue: #22
- 公共地基：#23 通用审批门（已合并，main）
- 未来增强：#21 落地后 reviewer 可读 AGENTS.md 规范一并审
