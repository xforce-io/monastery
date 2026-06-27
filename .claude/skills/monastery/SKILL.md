---
name: monastery
description: Use when the user wants to operate the monastery repo-maintainer CLI in a session — phrases like 巡检/治理一下仓库, monastery 现在什么情况, 有没有待我批的/pending/等放行的, backlog/排了什么, 跑一个 tick/推进一下/reconcile/step. Not for one-off init/repos config.
---

# monastery operator

把会话里的仓库治理意图翻译成正确的 `monastery` CLI 调用,并按协议把输出解读成人话。这是 CLI 之上的**薄壳**:不重实现治理逻辑,不代替人审批。

## 前置自检

首次调用前确认 CLI 可用:`monastery --version`。失败 → 转述 README 的 Prerequisites(`gh auth login`、`claude` CLI、Node ≥ 20),不硬闯、不贴裸 stack trace。monastery 自带 preflight 会说"该修什么",照转即可。

## 命令映射(只读优先)

| 用户意图 | 跑什么 |
|---|---|
| 状态 / 现在什么情况 | `monastery status --repo <o/r>` |
| 待批 / 等我放行 | `monastery pending --repo <o/r>` → 逐项给 GitHub 直链 |
| backlog / 排队 | `monastery backlog --repo <o/r>` |
| 跑 tick / 推进 | **先** `monastery step --repo <o/r> --dry-run --json` 预览 → 问"去掉 --dry-run 真执行?" → 确认后 `monastery step --repo <o/r>` |
| 推进某个 issue | 同上,加 `--issue <N>` |

`<o/r>` 从当前仓库的 git remote 推断(`gh repo view --json nameWithOwner -q .nameWithOwner`)。

## 铁律

1. **默认限定当前仓库**:总是带 `--repo <o/r>`。**不带 `--repo` 会作用于所有 tracked 仓库**——可能是几十个 issue、十几分钟的运行,且会误触别的仓库。只有用户明确说"所有仓库"时才省略。
2. **`step` 默认 `--dry-run` 先看**:除非用户本轮明确说"直接真执行",否则先预览再问。
3. **串行,不并发 step**:同一仓库同一时刻只跑一个 `step`。撞锁(`already being stepped by pid ...`)→ 先 `ps` 查该 pid 是否存活;**活着就等,别 `--force-stale-lock` 强抢**(会破坏正在运行的进程)。只有进程确已死透才用 `--force-stale-lock`。
4. **审批永远在人手里**:close/merge/implement/rework 的放行由人在 GitHub 完成(issue 提议 👍、PR 点 Merge)。skill 只用 `pending` 展示 + 给直链,**绝不**模拟 👍 或调 `gh` 去点赞/合并。
5. **不碰配置**:不替用户跑 `init` / `repos add/remove`;用户要配置就说明这是一次性设置,交回普通流程。

## 输出解读

一律优先 `--json`(`step --json` 是 NDJSON 事件流)。按 `docs/PROTOCOL.md` 归纳成人话,别贴原始 JSON:
- 粗状态:`active` / `awaiting-gate` / `terminal`
- `status` 闭集:`awaiting-approval` · `blocked` · `done` · `note`(字形 ⏳/✅/⚠️)

命令报错 / JSON 非预期 → 如实呈现 stderr,不臆造结论。

## Common mistakes

- 省略 `--repo` → 全量扫所有 tracked 仓库,慢且越界。**默认带 `--repo`。**
- 并发跑多个 `step` → 互相抢锁、留 stale 锁。**一次一个。**
- 撞锁就 `--force-stale-lock` → 破坏活着的进程。**先 `ps` 确认死透。**
- 替用户 👍 / merge → 越过人的放行权。**只展示,不代批。**
- 把原始 JSON 糊给用户 → 解读成状态摘要。
