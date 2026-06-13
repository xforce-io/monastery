# #144 A1+A3 状态收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 monastery 类 A 机器消息(审批门/升级/完成/周知)的可见头、控制标签、`monastery-state` 机器块由同一个 `StateStatus` 经 `deriveState()` 一处派生,消灭三者漂移,并收敛散落的 marker 字面量。

**Architecture:** `src/shell/messages.ts` 新增闭集 `StateStatus` + 纯函数 `deriveState(status) → { head, kind, labels }`。`renderStateMessage` 改吃 `status`、自动前置可见头并写入 `status:` 行。`actions.ts` 新增 `applyStateLabels` 把标签名也从 `deriveState` 取。各调用点只构造状态、不再手搓头/标签常量。过渡期 `renderStateMessage` 同时支持旧 `kind` 入参,末轮移除。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀), vitest, zod(本轮不引入新依赖)。

**设计来源:** `docs/design/144-state-provenance.md`。

**三处行为修正(随收敛一并修)**:
1. `issue-step.ts:149` fail 阈值到顶:头写 "needs a human" 但漏加 `needs-human` 标签 → `blocked` 补标签。
2. `patch.ts` 未到阈值瞬态告警(made no changes N/3):去掉误导性 ⚠️ → `note`,不加标签。
3. `patch.ts:192` rework 达上限:头写 "needs a human" 但漏加标签 → `blocked` 补标签。

---

## File Structure

- `src/shell/messages.ts` — **Modify**:新增 `StateStatus`、`deriveState`、`STATE_MARKER`、`AWAITING_APPROVAL_BANNER`;改 `renderStateMessage`/`parseStateMessage`;`StateMessage` 加 `status?`。
- `src/shell/actions.ts` — **Modify**:新增 `applyStateLabels`;`proposeGate`/`executeSafe(panel)` 迁到 status。
- `src/engine/issue-step.ts` — **Modify**:`noteMessage` 帮手改用 status;6 处调用点迁移。
- `src/engine/patch.ts` — **Modify**:`patchNote`/`reviewerNote`/`panel` 帮手改用 status;升级/瞬态/rework 各点迁移。
- `src/github/gh-adapter.ts` — **Modify**:`PANEL_MARKER` 改 `import { STATE_MARKER }`。
- `tests/messages.test.ts` — **Create**:`deriveState` 一致性测试。
- `tests/markers.test.ts` / `tests/actions.test.ts` / `tests/issue-step.test.ts` / `tests/patch-implement.test.ts` — **Modify**:更新断言、补回归。

---

## Task 1: `StateStatus` + `deriveState` + `STATE_MARKER`(纯增,不改现有行为)

**Files:**
- Modify: `src/shell/messages.ts`
- Create: `tests/messages.test.ts`

- [ ] **Step 1: 写失败测试** — `tests/messages.test.ts`

```ts
import { expect, test } from "vitest";
import { deriveState, STATE_MARKER, type StateStatus } from "../src/shell/messages.js";
import { NEEDS_APPROVAL, NEEDS_HUMAN } from "../src/github/labels.js";

test("#144 deriveState is the single source for head/kind/labels", () => {
  expect(deriveState("awaiting-approval")).toMatchObject({
    kind: "approval", labels: { add: NEEDS_APPROVAL },
  });
  expect(deriveState("awaiting-approval").head).toContain("NEEDS YOUR APPROVAL");

  expect(deriveState("blocked")).toMatchObject({ kind: "note", labels: { add: NEEDS_HUMAN } });
  expect(deriveState("blocked").head).toContain("需要人工介入");

  expect(deriveState("done")).toMatchObject({ kind: "note", labels: { remove: NEEDS_APPROVAL } });
  expect(deriveState("done").head).toContain("已完成");

  expect(deriveState("note")).toMatchObject({ kind: "note", head: "", labels: {} });
});

test("#144 STATE_MARKER is the canonical machine-block prefix", () => {
  expect(STATE_MARKER).toBe("<!--monastery-state");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/messages.test.ts`
Expected: FAIL —「deriveState is not a function」/「STATE_MARKER undefined」。

- [ ] **Step 3: 最小实现** — 在 `src/shell/messages.ts` 顶部(`STATE_RE` 之前)插入:

```ts
import { NEEDS_APPROVAL, NEEDS_HUMAN } from "../github/labels.js";

export const STATE_MARKER = "<!--monastery-state";

/** #90 approval banner — moved here so the visible head is derived, never hand-written at call sites. */
export const AWAITING_APPROVAL_BANNER =
  "⏳ **NEEDS YOUR APPROVAL** — 👍 this comment to approve · 👎 to decline · 👀 to send back for revision";

/** The closed set of states a class-A machine message can be in (#144 A3). */
export type StateStatus = "awaiting-approval" | "blocked" | "done" | "note";

/**
 * #144 A3: the SINGLE source from which a class-A message's visible head, machine-block `kind`, and
 * control-label op are all derived — so they can never drift apart. `head` is a generic prefix; the
 * caller's `body` still carries the specifics.
 */
export function deriveState(status: StateStatus): {
  head: string;
  kind: StateMessageKind;
  labels: { add?: string; remove?: string };
} {
  switch (status) {
    case "awaiting-approval":
      return { head: AWAITING_APPROVAL_BANNER, kind: "approval", labels: { add: NEEDS_APPROVAL } };
    case "blocked":
      return { head: "⚠️ **需要人工介入 / needs a human**", kind: "note", labels: { add: NEEDS_HUMAN } };
    case "done":
      return { head: "✅ **已完成 / done**", kind: "note", labels: { remove: NEEDS_APPROVAL } };
    case "note":
      return { head: "", kind: "note", labels: {} };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/messages.test.ts`
Expected: PASS (2 tests)。

- [ ] **Step 5: 全量编译 + 测试无回归**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS（现有测试不受影响,纯增)。

- [ ] **Step 6: 提交**

```bash
git add src/shell/messages.ts tests/messages.test.ts
git commit -m "feat(#144): add StateStatus + deriveState single source"
```

---

## Task 2: `renderStateMessage` 吃 `status`、前置头、写 `status:` 行;`parse` 读 `status`

过渡期同时支持旧 `kind` 入参(末轮 Task 7 移除),保证每步 build 绿。

**Files:**
- Modify: `src/shell/messages.ts`
- Modify: `tests/markers.test.ts`

- [ ] **Step 1: 写失败测试** — 在 `tests/messages.test.ts` 追加:

```ts
import { renderStateMessage, parseStateMessage } from "../src/shell/messages.js";

test("#144 render(status) prepends the head and serializes status", () => {
  const body = renderStateMessage({ status: "blocked", agent: "patcher", model: "sonnet", body: "details here" });
  expect(body).toContain("status: blocked");
  expect(body).toContain("kind: note");          // derived
  expect(body).toContain("需要人工介入");          // head prepended
  expect(body).toContain("details here");
  expect(parseStateMessage(body)).toMatchObject({ status: "blocked", kind: "note", agent: "patcher", model: "sonnet" });
});

test("#144 render(status: note) emits no head prefix", () => {
  const body = renderStateMessage({ status: "note", body: "just fyi" });
  expect(body.split("-->\n")[1]).toBe("just fyi");  // body unchanged, no banner
  expect(parseStateMessage(body)).toMatchObject({ status: "note", kind: "note" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/messages.test.ts`
Expected: FAIL —「status」未被识别(render 仍按 kind 分支,parse 无 status)。

- [ ] **Step 3: 实现** — 改 `src/shell/messages.ts`:

`StateMessage` 接口加 `status`:

```ts
export interface StateMessage {
  kind: StateMessageKind;
  body: string;
  action?: GatedKind;
  spec?: number;
  agent?: string;
  model?: string;
  status?: StateStatus;
}
```

把 `renderStateMessage` 入参改为可辨识联合(过渡):

```ts
type RenderInput =
  | { status: StateStatus; action?: GatedKind; spec?: number; agent?: string; model?: string; body: string }
  | { kind: StateMessageKind; action?: GatedKind; spec?: number; agent?: string; model?: string; body: string }; // legacy, removed in Task 7

export function renderStateMessage(msg: RenderInput): string {
  const status: StateStatus | undefined = "status" in msg ? msg.status : undefined;
  const derived = status ? deriveState(status) : null;
  const kind = derived ? derived.kind : (msg as { kind: StateMessageKind }).kind;
  const head = derived ? derived.head : "";

  const lines = ["v: 1", `kind: ${kind}`, `protocol: ${kind}`];
  if (status) lines.push(`status: ${status}`);
  if (msg.action) lines.push(`action: ${msg.action}`);
  if (msg.spec !== undefined) lines.push(`spec: ${msg.spec}`);
  if (msg.agent) lines.push(`agent: ${msg.agent}`);
  if (msg.model) lines.push(`model: ${msg.model}`);

  const body = head ? `${head}\n\n${msg.body}` : msg.body;
  return `${STATE_MARKER}\n${lines.join("\n")}\n-->\n${body}`;
}
```

> 注:`STATE_RE` 保留不变(已匹配 `<!--monastery-state`);渲染拼接改用 `STATE_MARKER` 常量。

`parseStateMessage` 增 `status`(放在返回对象里,紧跟 model 之后):

```ts
const status = isStateStatus(meta.status) ? meta.status : undefined;
return {
  kind,
  body: body.replace(STATE_RE, "").trim(),
  ...(action ? { action } : {}),
  ...(spec !== undefined ? { spec } : {}),
  ...(meta.agent ? { agent: meta.agent } : {}),
  ...(meta.model ? { model: meta.model } : {}),
  ...(status ? { status } : {}),
};
```

文件底部加守卫:

```ts
function isStateStatus(raw: string | undefined): raw is StateStatus {
  return raw === "awaiting-approval" || raw === "blocked" || raw === "done" || raw === "note";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/messages.test.ts`
Expected: PASS。

- [ ] **Step 5: 编译 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS(旧 `kind` 入参仍工作,现有断言不变)。

- [ ] **Step 6: 提交**

```bash
git add src/shell/messages.ts tests/messages.test.ts
git commit -m "feat(#144): render(status) prepends head and serializes status"
```

---

## Task 3: `applyStateLabels`(标签名也从 `deriveState` 取)

**Files:**
- Modify: `src/shell/actions.ts`
- Modify: `tests/actions.test.ts`

- [ ] **Step 1: 写失败测试** — `tests/actions.test.ts` 追加:

```ts
import { applyStateLabels } from "../src/shell/actions.js";

test("#144 applyStateLabels derives the control label from status", async () => {
  const g = gh();
  await applyStateLabels(g, "o/r", 1, "blocked");
  let [i] = await g.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:needs-human");

  await applyStateLabels(g, "o/r", 1, "awaiting-approval");
  [i] = await g.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:needs-approval");

  await applyStateLabels(g, "o/r", 1, "done");          // removes needs-approval
  [i] = await g.listOpenIssues("o/r", 0);
  expect(i.labels).not.toContain("monastery:needs-approval");

  await applyStateLabels(g, "o/r", 1, "note");           // no-op
});
```

> 若 `gh()`/`listOpenIssues` 的零参签名不符,照搬本文件既有用法(见同文件 `listOpenIssues("o/r", 0)`)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/actions.test.ts`
Expected: FAIL —「applyStateLabels is not exported」。

- [ ] **Step 3: 实现** — `src/shell/actions.ts`,在 `ensureControlLabel` 之后新增,并 import `deriveState`/`StateStatus`:

```ts
import { renderStateMessage, deriveState, type StateStatus } from "./messages.js";
```

```ts
/** #144 A3: apply the control-label op implied by a state — the label NAME comes from deriveState,
 * never hand-picked, so head/label/block can't drift. Idempotent. */
export async function applyStateLabels(gh: GitHubAdapter, repo: string, num: number, status: StateStatus): Promise<void> {
  const { labels } = deriveState(status);
  if (labels.add) { await ensureControlLabel(gh, repo, labels.add); await gh.addLabel(repo, num, labels.add); }
  if (labels.remove) await gh.removeLabel(repo, num, labels.remove);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/actions.test.ts`
Expected: PASS。

- [ ] **Step 5: 编译**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/shell/actions.ts tests/actions.test.ts
git commit -m "feat(#144): add applyStateLabels deriving control label from status"
```

---

## Task 4: 迁移 `actions.ts`(proposeGate → awaiting-approval;panel → note)

**Files:**
- Modify: `src/shell/actions.ts`
- Modify: `tests/actions.test.ts`

- [ ] **Step 1: 改实现**

`executeSafe` 的 `panel` 分支(原 `renderStateMessage({ kind: "note", body: a.body, ...provenance })`):

```ts
    case "panel":
      await gh.upsertPanel(repo, a.num, renderStateMessage({ status: "note", body: a.body, ...provenance }));
      return;
```

`proposeGate`:去掉本地 `banner` 常量与手工 `ensureControlLabel`/`addLabel`,改:

```ts
export async function proposeGate(gh: GitHubAdapter, repo: string, num: number, proposal: GatedKind, draft: string, provenance: ActionProvenance = {}): Promise<void> {
  const specVersion = currentSpec(await gh.listComments(repo, num))?.version ?? 0;
  await applyStateLabels(gh, repo, num, "awaiting-approval");
  await gh.postComment(repo, num, renderStateMessage({ status: "awaiting-approval", action: proposal, spec: specVersion, body: draft, ...provenance }));
}
```

> 可见头(#90 banner)现由 `deriveState("awaiting-approval").head` 自动前置;`draft` 不再手工拼 banner。

- [ ] **Step 2: 更新断言** — `tests/actions.test.ts` 中 propose 用例,把 `parseStateMessage(...)` 期望加 `status`:

```ts
  expect(parseStateMessage(g.comments[1][0])).toMatchObject({ kind: "approval", action: "close", status: "awaiting-approval", agent: "maintainer", model: "opus" });
```

panel 用例同理加 `status: "note"`:

```ts
  expect(parseStateMessage(g.panels[1])).toMatchObject({ kind: "note", status: "note", agent: "maintainer", model: "opus" });
```

并确认仍 `expect(g.comments[1][0]).toContain("NEEDS YOUR APPROVAL")`(banner 仍在,只是改由 render 前置)。

- [ ] **Step 3: 跑测试**

Run: `npx vitest run tests/actions.test.ts`
Expected: PASS。

- [ ] **Step 4: 编译 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shell/actions.ts tests/actions.test.ts
git commit -m "feat(#144): derive actions.ts gate/panel state from status"
```

---

## Task 5: 迁移 `issue-step.ts`(6 处)+ fail-threshold 漏标签回归

**Files:**
- Modify: `src/engine/issue-step.ts`
- Modify: `tests/issue-step.test.ts`

- [ ] **Step 1: 改帮手 + 调用点**

`noteMessage` 帮手改为按 status(默认 note):

```ts
const stateMessage = (status: StateStatus, body: string, provenance: { agent?: string; model?: string } = {}) =>
  renderStateMessage({ status, body, ...provenance });
```

import 增 `applyStateLabels`(从 actions)、`StateStatus`(从 messages)。各调用点:

- `:147-149` fail 阈值到顶 → blocked + 补标签:

```ts
    if (fails >= failThreshold) {
      await applyStateLabels(ctx.gh, ctx.repo, issue.number, "blocked");
      await ctx.gh.upsertPanel(ctx.repo, issue.number,
        stateMessage("blocked", `the maintainer agent has produced no valid actions for ${fails} consecutive ticks.`, { agent: "maintainer", model: rt.model }));
    }
```

- `:288-292` 门通过(done):把显式 `removeLabel(NEEDS_APPROVAL)` 换成 `applyStateLabels(..., "done")`,head 改由 status 派生(去掉手写 `✅`):

```ts
    if (out.kind === "progressed") {
      await applyStateLabels(ctx.gh, ctx.repo, issue.number, "done");
      const done = kind === "rework"
        ? `rework approved — the draft PR was updated${out.note ? ` (${out.note})` : ""}. Awaiting your review/merge.`
        : `implement approved — draft PR opened${out.note ? ` (${out.note})` : ""}. Awaiting your review/merge.`;
      await ctx.gh.upsertPanel(ctx.repo, issue.number, stateMessage("done", done));
    }
```

- `:312-316` missing spec → blocked(`markNeedsHuman` 已加标签,可保留或换 `applyStateLabels(...,"blocked")`;统一用后者):

```ts
  await applyStateLabels(ctx.gh, ctx.repo, issue.number, "blocked");
  const error = `approved spec v${stamped} missing; ${detail}`;
  await ctx.gh.upsertPanel(ctx.repo, issue.number, stateMessage("blocked", `${error} — refusing to run patcher without the approved task.`));
```

> 同时把 `markNeedsHuman` 函数体改为委托:`await applyStateLabels(ctx.gh, ctx.repo, issue.number, "blocked");`(保持其它调用方语义不变)。

- `:344` terminalizeDeclined 面板 → note(`declined`/`needs-approval` 标签操作**原样保留**,只换渲染):

```ts
  await ctx.gh.upsertPanel(ctx.repo, issue.number, stateMessage("note", note));
```

- `:374` demoteGate、`:397` recoverRejectedImpl 面板 → note(各自的 `removeLabel`/`postComment` 控制流原样保留):

```ts
  await ctx.gh.upsertPanel(ctx.repo, issue.number, stateMessage("note", note));
```

- [ ] **Step 2: 写回归测试** — `tests/issue-step.test.ts` 追加(fail 到顶补标签):

```ts
test("#144 fail-threshold escalation adds the needs-human label (was a drift)", async () => {
  const gh = ghWith({ number: 9, title: "x", body: "y", labels: [], state: "open" });
  const provider = new FakeProvider("not json");        // 触发 no-output 失败
  let out;
  for (let i = 0; i < 3; i++) out = await issueStep({ ...ctxWith(gh, provider) }, 9);
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("monastery:needs-human");
  expect(parseStateMessage(gh.panels[9])).toMatchObject({ status: "blocked" });
});
```

> 注:`FAIL_THRESHOLD` 默认 3;循环 3 次到顶。若 `ctxWith`/`ghWith`/`FakeProvider` 触发 no-output 的方式与本文件既有用例不同,照搬同文件 "no valid output" 用例的构造法。

- [ ] **Step 3: 跑测试确认新测失败→实现后通过**

Run: `npx vitest run tests/issue-step.test.ts`
Expected: 先 FAIL(未补标签前)→ 实现后 PASS。

- [ ] **Step 4: 更新既有断言** — 本文件已有的 `#144 active maintainer safe writes carry agent/model provenance` 用例,其 `parseStateMessage` 期望加 `status: "note"`(panel 动作走 note)。

- [ ] **Step 5: 编译 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/engine/issue-step.ts tests/issue-step.test.ts
git commit -m "feat(#144): derive issue-step state from status; fix fail-threshold label drift"
```

---

## Task 6: 迁移 `patch.ts`(升级=blocked / 瞬态=note / rework 各点)

**Files:**
- Modify: `src/engine/patch.ts`
- Modify: `tests/patch-implement.test.ts`

- [ ] **Step 1: 改帮手 + 调用点**

帮手改为按 status(默认 note,带 agent provenance):

```ts
const patcherMsg = (status: StateStatus, body: string, model?: string) =>
  renderStateMessage({ status, body, agent: "patcher", ...(model ? { model } : {}) });
const reviewerMsg = (status: StateStatus, body: string, model?: string) =>
  renderStateMessage({ status, body, agent: "reviewer", ...(model ? { model } : {}) });
```

import 增 `applyStateLabels`(actions)、`StateStatus`(messages)。

- `reviewPanel`(原 `reviewerNote(⚠️ … needs a human …)`)→ blocked:

```ts
function reviewPanel(blocking: ReviewFinding[], iters: number, model?: string): string {
  const list = blocking.map((b) => `- ${b.title}: ${b.detail}`).join("\n");
  return reviewerMsg("blocked", `自审在 ${iters} 轮后仍有未解决的 blocking：\n${list}`, model);
}
```

- `reviewSummary` PR 评论(`:142`)→ note:

```ts
      await ctx.gh.postComment(ctx.repo, prNum, reviewerMsg("note", reviewSummary(r), r.reviewerModel));
```

- `:283` 未到阈值瞬态(made no changes N/3)→ note,去 ⚠️:

```ts
      await ctx.gh.upsertPanel(ctx.repo, issue.number, patcherMsg("note", error, patcherModel));
```

- 先把本文件的 `markNeedsHuman` 函数体改为委托(标签也由 status 派生):

```ts
async function markNeedsHuman(ctx: StepCtx, issue: Issue): Promise<void> {
  await applyStateLabels(ctx.gh, ctx.repo, issue.number, "blocked");
}
```

- `:287-288` 到阈值升级 → 保留既有的 `await markNeedsHuman(ctx, issue);`(现已委托 applyStateLabels),面板改 blocked 渲染:

```ts
    await markNeedsHuman(ctx, issue);
    await ctx.gh.upsertPanel(ctx.repo, issue.number,
      patcherMsg("blocked", `patcher made no changes after ${fails} attempts.\n\nworkdir kept at ${dir}`, patcherModel));
```

> `markNeedsHuman` 的其它调用点(empty-diff 到阈值、自审不收敛前)不动,自动获得一致标签。

- `:317` 自审不收敛到顶:前面已 `markNeedsHuman` → `reviewPanel` 已是 blocked,无需再动。

- `panel` 帮手(`:163`,rework 用)加 status 形参,默认 note:

```ts
  const panel = (note: string, status: StateStatus = "note") => ctx.gh.upsertPanel(ctx.repo, issue.number, patcherMsg(status, note));
```

rework 各点(note 状态 head 为空,**body 原文保留**,含原有 emoji——只是包进 `status: note` 信封,不该摘 needs-approval):
- `:168` `panel("✅ PR 已合并（merged）——无需 rework。")` → note(body 原文不动)。
- `:171` `panel("⚠️ 没有可 rework 的 open draft PR。")` → note(body 原文不动)。
- `:186` `panel("⚠️ PR 上没有人类反馈可处理——不 rework。")` → note(body 原文不动)。
- `:192` rework 达上限(**漏标签修正**)→ blocked:

```ts
    await applyStateLabels(ctx.gh, ctx.repo, issue.number, "blocked");
    await panel(`rework 已达 ${REWORK_BUDGET} 轮上限。`, "blocked"); return { kind: "noop" };
```

- `:227` rework 总结写入失败(带 REWORK_MARKER 前缀)→ 保持 note,但该行自带特殊 marker 前缀,**不走 patcherMsg**(它需要 REWORK_MARKER 在体内),原样保留:

```ts
      await ctx.gh.upsertPanel(ctx.repo, issue.number, patcherMsg("note", `${REWORK_MARKER} round=${round} committed=true-->\n rework 第 ${round} 轮已推送,但 PR 线程总结写入失败:${(e as Error).message}`));
```

> 该 body 内嵌 REWORK_MARKER 仅作幂等识别,被 monastery-state 块包裹不影响其 `includes` 检测。

- [ ] **Step 2: 更新断言** — `tests/patch-implement.test.ts`:
  - reviewer PR 评论用例:`parseStateMessage(...)` 加 `status: "note"`(原已断言 agent reviewer/model sonnet)。
  - `#135 patcher made no changes` 用例:加 `status: "note"`(瞬态)并断言 `needs-human` 标签**未**加。
  - 若有"自审不收敛/empty-diff 到阈值"用例,加 `status: "blocked"` 与 `needs-human` 标签断言。

```ts
  // reviewer PR comment
  expect(parseStateMessage(prComments[0])).toMatchObject({ kind: "note", status: "note", agent: "reviewer", model: "sonnet" });
  // #135 transient
  expect(parseStateMessage(gh.panels[7])).toMatchObject({ kind: "note", status: "note", agent: "patcher", model: "sonnet" });
  const [i] = await gh.listOpenIssues(/* repo */ "o/r", 0);
  expect(i.labels).not.toContain("monastery:needs-human");
```

- [ ] **Step 3: 跑测试**

Run: `npx vitest run tests/patch-implement.test.ts`
Expected: PASS。

- [ ] **Step 4: 编译 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/engine/patch.ts tests/patch-implement.test.ts
git commit -m "feat(#144): derive patch.ts state from status; fix rework-limit label drift"
```

---

## Task 7: 收口 — 移除旧 `kind` 入参 + A1 marker 收敛 + grep 验收

**Files:**
- Modify: `src/shell/messages.ts`
- Modify: `src/github/gh-adapter.ts`
- Modify: `tests/markers.test.ts`

- [ ] **Step 1: 确认无残留 kind 入参**

Run: `grep -rn 'renderStateMessage({ kind' src/ tests/`
Expected: 仅 `tests/markers.test.ts` 的 #144 envelope 用例命中(下一步改它);`src/` 应为空。

- [ ] **Step 2: 改 markers.test.ts envelope 用例为 status**

```ts
test("#144 state messages render and parse the v1 envelope", () => {
  const body = renderStateMessage({ status: "awaiting-approval", action: "implement", spec: 2, agent: "maintainer", model: "opus", body: "## Plan" });
  expect(body).toContain("v: 1");
  expect(body).toContain("kind: approval");
  expect(body).toContain("status: awaiting-approval");
  expect(body).toContain("agent: maintainer");
  expect(body).toContain("model: opus");
  expect(body).toContain("protocol: approval");
  expect(body).toContain("NEEDS YOUR APPROVAL");   // banner now derived
  expect(isStateMessage(body, "approval")).toBe(true);
  expect(parseStateMessage(body)).toMatchObject({ kind: "approval", action: "implement", spec: 2, status: "awaiting-approval", agent: "maintainer", model: "opus" });
  expect(approvalKind(body)).toBe("implement");
  expect(approvalSpecVersion(body)).toBe(2);
});
```

> 该用例原断言 `stripStateMessage(body) === "⏳ approve\n\n## Plan"` 需删除/调整 —— body 现为 `${banner}\n\n## Plan`,不再等于原字符串。

- [ ] **Step 3: 移除 `RenderInput` 的 legacy `kind` 分支**

`src/shell/messages.ts`:

```ts
export function renderStateMessage(msg: { status: StateStatus; action?: GatedKind; spec?: number; agent?: string; model?: string; body: string }): string {
  const { head, kind } = deriveState(msg.status);
  const lines = ["v: 1", `kind: ${kind}`, `protocol: ${kind}`, `status: ${msg.status}`];
  if (msg.action) lines.push(`action: ${msg.action}`);
  if (msg.spec !== undefined) lines.push(`spec: ${msg.spec}`);
  if (msg.agent) lines.push(`agent: ${msg.agent}`);
  if (msg.model) lines.push(`model: ${msg.model}`);
  const body = head ? `${head}\n\n${msg.body}` : msg.body;
  return `${STATE_MARKER}\n${lines.join("\n")}\n-->\n${body}`;
}
```

- [ ] **Step 4: A1 — `gh-adapter.ts` 收敛 marker**

`src/github/gh-adapter.ts:13`:删 `const PANEL_MARKER = "<!--monastery-state";`,改:

```ts
import { STATE_MARKER } from "../shell/messages.js";
```

并把 `:65`/`:71` 的 `${PANEL_MARKER}` 改为 `${STATE_MARKER}`。

> 确认 `gh-adapter.ts` 现有 import 块里加这一行不产生循环依赖(messages.ts 不 import gh-adapter)。messages.ts 仅 import labels.ts,无环。

- [ ] **Step 5: grep 验收**

Run: `grep -rn '<!--monastery-state' src/`
Expected: 仅 `src/shell/messages.ts` 命中(`STATE_MARKER` 定义 + `STATE_RE`)。`gh-adapter.ts` 不再有字面量。

- [ ] **Step 6: 编译 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS（全绿)。

- [ ] **Step 7: 提交**

```bash
git add src/shell/messages.ts src/github/gh-adapter.ts tests/markers.test.ts
git commit -m "refactor(#144): drop legacy kind input; converge state marker to STATE_MARKER (A1)"
```

---

## 验收对照

- [ ] 类 A 消息的头/标签/块均由 `deriveState(status)` 派生;`tests/messages.test.ts` 一致性测试存在并通过。
- [ ] `grep '<!--monastery-state' src/` 仅命中 `messages.ts`。
- [ ] `issue-step.ts:149` 与 `patch.ts:192` 漏标签漂移修正,有回归断言。
- [ ] 瞬态告警不再误标 ⚠️/不加 needs-human,有断言。
- [ ] `npx tsc --noEmit && npx vitest run` 全绿。
