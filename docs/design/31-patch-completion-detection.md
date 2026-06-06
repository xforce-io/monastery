# #31 · patch 完成检测：检测 PR merge/close 结局并解卡

> Issue: #31 · Branch: `feat/31-patch-completion-detection` · 状态：设计已批准，待实现
> 本文档为该 issue 的真相源；issue body 仅保留一行摘要 + 本文链接。

## 1. 问题

patcher 开 PR 后打 `patch-proposed`，issueStep 对它直接 `noop`（parked）。若人 **close PR（拒绝）**，issue 不会被 `Closes #N` 关闭，**永远卡在 patch-proposed**——monastery 以为"提议中"，其实 PR 已死。

## 2. 决定（习惯驱动）

owner 的习惯是**直接在 GitHub merge PR** = 这就是 approve（PR body 的 `Closes #N` 在 merge 时自动关 issue）。所以 **monastery 不自己 merge、不引入新 approve 手势**。monastery 只**检测 PR 结局**并收敛：

| PR 状态 | monastery |
|---|---|
| **merged** | 落 `state:done`（防御——通常 `Closes #N` 已自动关 issue，issueStep 见不到它） |
| **closed 未 merge**（拒绝） | **declined 终结**：打 `declined` + `state:done`、移 `patch-proposed`、panel 注明"PR 已关闭未合并" |
| **open** | noop（继续等，同今天） |

「请改 / 据评论回复或改」不在本 issue——见 epic #32（对话反馈环）。本 issue 只看 merge/close 状态，**无 LLM**。

## 3. 组件

### 3.1 `GitHubAdapter.prState`
```ts
prState(repo: string, branch: string): Promise<"open" | "merged" | "closed" | null>;
```
- gh 实现：`gh pr view <branch> --repo <repo> --json state -q .state` → `OPEN`/`MERGED`/`CLOSED` 映射小写；无 PR / 出错 → `null`。
- 加到 `adapter.ts` 接口、`dry-run.ts`（透传 inner）、`fake.ts`（注入 `prStates: Record<string, ...>` 按 branch 取，默认 null）。

### 3.2 reconcile：patch-proposed 变可运行
当前 `runnable` 过滤把 `patch-proposed` 排除（parked）。改为：**`patch-proposed` 的 issue 纳入 runnable**（这样每 tick 能查它 PR 结局）。`needs-human` 仍 parked。

### 3.3 issueStep：patch-proposed 分支按 PR 态收敛
当前 issueStep 顶部 `if (PATCH_PROPOSED || NEEDS_HUMAN) return noop`。拆开：`NEEDS_HUMAN` 仍 noop；`PATCH_PROPOSED` 改为：
```
const branch = branchName(issue.number, issue.title);   // #28 的确定性函数
switch (await ctx.gh.prState(ctx.repo, branch)) {
  case "merged": addLabel state:done; removeLabel patch-proposed; return { kind: "done" };
  case "closed": return terminalizePatchDeclined(ctx, issue);   // declined + state:done, 清 patch-proposed, panel 注明
  default:       return { kind: "noop" };   // open / null -> 继续等
}
```
`terminalizePatchDeclined` 复用 #23 的 declined 终结思路（add `DECLINED` + `state:done`、remove `PATCH_PROPOSED`、upsertPanel 注明），与 close 流的 `terminalizeDeclined` 同形（差别仅清的标签是 patch-proposed）。

## 4. 幂等

- `merged`/`closed` 收敛后 issue 落 `state:done`（+ 清 patch-proposed）。下个 tick：state 为 done、无 patch-proposed → 不再 runnable、不再处理。
- `closed→declined` 不关闭 issue 本身（与 #6/#23 的 declined 一致：终结但 issue 可留 open）。
- `prState` 读失败 → null → noop（不因读不到就误终结）。

## 5. 测试

- **`tests/gh-adapter.test.ts`**：`prState` record/replay（OPEN/MERGED/CLOSED/无 PR→null）。
- **`tests/issue-step.test.ts`**：patch-proposed + fake `prState`：
  - `open`/`null` → noop（issue 不变）
  - `merged` → `state:done`、无 `patch-proposed`、`kind:"done"`
  - `closed` → `declined` + `state:done`、无 `patch-proposed`、panel 含拒绝注明
- **`tests/reconcile.test.ts`**：patch-proposed 的 issue 现在进 runnable（被 issueStep 处理）。

## 6. 验收

- 人 close 一个 monastery 的 PR 未合并 → 下个 tick issue 从 patch-proposed 解卡 → `declined`/`state:done`，不再悬挂。
- 人 merge PR → `Closes #N` 自动关 issue（monastery 无需动作）；若 issue 仍 open（防御），下个 tick 落 done。
- PR 仍 open → issue 继续 parked 等你（行为同今天）。

## 7. 实现顺序（TDD）
1. `GitHubAdapter.prState` + interface/gh/fake/dry-run（record/replay 测试）
2. reconcile：patch-proposed 纳入 runnable
3. issueStep：patch-proposed 按 prState 收敛 + `terminalizePatchDeclined`

## 关联
- 习惯 = 直接 merge（owner）；对话反馈（评论→回复/改）= epic #32。
- 复用 #28 的 `branchName`、#23 的 declined 终结。
