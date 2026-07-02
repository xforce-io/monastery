---
name: monastery
description: Use when the user wants to operate the monastery repo-maintainer CLI in a session — phrases like 巡检/治理一下仓库, monastery 现在什么情况, 有没有待我批的/pending/等放行的, backlog/排了什么, 评估一下/assess, 执行/run, 开发/处理某个 issue, 跑一个 tick/推进一下/reconcile. Not for one-off init/repos config.
---

# monastery operator

把会话里的仓库治理意图翻译成正确的 `monastery` CLI 调用,并按协议把输出解读成人话。这是 CLI 之上的**薄壳**:不重实现治理逻辑,不代替人审批。

命令模型是两个动词 + 一张带状态的清单(`backlog.json`):**`assess`(想)→〔人在 GitHub 👍/👎〕→ `run`(做)**,`status` 是这张清单的纯读视图。看永远便宜,算/做永远显式。

## 前置自检

首次调用前确认 CLI 可用并核对命令面:`monastery --version` + `monastery --help`。失败 → 转述 README 的 Prerequisites(`gh auth login`、`claude`/`codex` CLI、Node ≥ 20),不硬闯、不贴裸 stack trace。monastery 自带 preflight 会说"该修什么",照转即可。

若本 skill、README、用户说法与 `monastery --help` 冲突,**以实际 CLI help 为准**,并简短提示"本地文档/skill 可能陈旧"。不要调用 help 中不存在的命令。

## 命令映射(看优先)

**无参默认(`/monastery` 后无任何请求)**:意图是"帮我看下现状、但别给我陈旧的"——别反问"想干嘛",给确定动作。推断 `<o/r>` 后走三步,**全程零 token、不写 GitHub**:① `monastery status --repo <o/r>` 亮当前快照;② 顺手 `gh` 纯读 open issues/PR(零 LLM)跟快照比对新鲜度;③ 快照漏了新动静(或无快照)→ 标一行 `⚠️ 快照可能陈旧:GitHub 上有 N 项没评估` 并**问**"要 `assess` 刷新吗?"。**绝不**无参就自动 `assess`——烧 token + 写 GitHub 那一下永远留给人点头(铁律 5)。

| 用户意图 | 跑什么 |
|---|---|
| 状态 / 现在什么情况 / backlog / 排队 | `monastery status --repo <o/r>`(只读快照,**零 LLM**;无快照 → 提示去 `assess`,**不**自动重算) |
| 待批 / 等我放行 | `monastery pending --repo <o/r>` → 逐项给 GitHub 直链 |
| 评估 / 深评 / 该不该做 / 重排(**想**) | **先** `monastery assess --repo <o/r> --dry-run --json` 预览 → 问"去掉 --dry-run 真执行?" → 确认后 `monastery assess --repo <o/r>` |
| 评估某个 issue | 同上,加 `--issue <N>` |
| 开发 / 实现 / 处理某个 issue(**定向做事**) | **先** `monastery status --repo <o/r>` + `monastery assess --repo <o/r> --issue <N> --dry-run --json` 看 gate/提案 → 没有人已放行的 gate 就说明 `run` 会 no-op,不要手动绕过;若用户明确授权真执行,再按 `run --dry-run` → 确认 → `run` |
| 执行 / 落地已放行的(**做**) | **先** `monastery run --repo <o/r> --dry-run --json` 预览 → 确认后 `monastery run --repo <o/r>`;只消费人已 👍 的项,无则 no-op |
| 跑 tick / 推进一下 | = `assess` →〔人在 GitHub 👍〕→ `run` 跨人闸两段;手动路径就**先 assess,放行后再 run** |

`<o/r>` 从当前仓库的 git remote 推断(`gh repo view --json nameWithOwner -q .nameWithOwner`)。

## 铁律

1. **默认限定当前仓库**:总是带 `--repo <o/r>`。**不带 `--repo` 会作用于所有 tracked 仓库**——可能是几十个 issue、十几分钟的运行,且会误触别的仓库。只有用户明确说"所有仓库"时才省略。
2. **`assess` / `run` 默认 `--dry-run` 先看**:这俩会写 GitHub(assess 落轻动作 + 开 gate;run 执行已放行项)。除非用户本轮明确说"直接真执行",否则先预览再问。`status` / `pending` 是纯读,不需要。
3. **串行,不并发**:`assess` 与 `run` 共用同一把 per-repo 锁,同一仓库同一时刻只跑一个。撞锁(`already being stepped by pid ...`)→ 先 `ps` 查该 pid 是否存活;**活着就等,别 `--force-stale-lock` 强抢**(会破坏正在运行的进程)。只有进程确已死透才用 `--force-stale-lock`。
4. **审批永远在人手里**:`assess` 只**开 gate + 出提案**,`run` 只消费人**已放行**的项;close/merge/implement/rework/decline 的放行由人在 GitHub 完成(issue 提议 👍、PR 点 Merge,👎 即废止)。decline 也只是 `assess` 的**建议**,人确认才由 `run` 落 `monastery:declined`。skill 只用 `pending` 展示 + 给直链,**绝不**模拟 👍/👎 或调 `gh` 去点赞/合并。
5. **pending 为空不是授权**:`pending` 返回空只说明当前没有等人 👍 的 gate;它不表示可以绕过 monastery 手动实现。用户指定 issue 要"开发/处理"时,先定向 `assess --issue N --dry-run --json` 刷新判断;若仍无已放行 gate,明确告诉用户 `run` 会 no-op,需要在 GitHub approval comment 上 👍 后再执行。
6. **看永远便宜**:`status` / `pending` 零 LLM、零 token;只有 `assess` 烧 token。用户只想"看",**绝不**顺手触发 `assess`;`status` 无快照时只提示去 `assess`,不替他重算。
7. **不碰配置**:不替用户跑 `init` / `repos add/remove`;用户要配置就说明这是一次性设置,交回普通流程。

## 输出解读

一律优先 `--json`(`assess` / `run` 的 `--json` 是 NDJSON 事件流)。按 `docs/PROTOCOL.md` 归纳成人话,别贴原始 JSON:
- 粗状态:`active` / `awaiting-gate` / `terminal`
- `status` 闭集:`awaiting-approval` · `blocked` · `done` · `note`(字形 ⏳/✅/⚠️)

命令报错 / JSON 非预期 → 如实呈现 stderr,不臆造结论。

## Common mistakes

- 无参 `/monastery` 就反问"想治理哪个仓库 / 想干嘛" → 用户其实就想看现状。**推断 repo,直接 `status` + 新鲜度体检,陈旧才问 `assess`。**
- 省略 `--repo` → 全量扫所有 tracked 仓库,慢且越界。**默认带 `--repo`。**
- 想看状态却跑 `assess` → 白烧 token。**看用 `status` / `pending`,它们零 LLM。**
- 用户说"monastery 开发 issue N"就直接手写代码 → 绕过治理。**先 `status` + 定向 `assess --issue N --dry-run --json`,没有已放行 gate 就说明需要人去 GitHub 👍。**
- `pending` 为空就当作用户已授权实现 → 错。**pending 为空 = run 无事可做,不是实现许可。**
- 并发跑 `assess` / `run` → 互相抢锁、留 stale 锁。**一次一个。**
- 撞锁就 `--force-stale-lock` → 破坏活着的进程。**先 `ps` 确认死透。**
- 替用户 👍 / merge / 👎 → 越过人的放行权。**只展示,不代批。**
- 把原始 JSON 糊给用户 → 解读成状态摘要。
