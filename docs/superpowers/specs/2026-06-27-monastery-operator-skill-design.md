# monastery operator skill — 设计

> 一个**零新逻辑的薄壳 skill**:在 Claude Code 会话里,把"用户提到仓库治理/巡检/待批 PR/跑 tick"翻译成正确的 `monastery` CLI 调用,并把输出按协议解读成人话。它不重实现任何治理逻辑,不代替人审批。

- 关联:`README.md`(命令表)、`docs/PROTOCOL.md`(粗状态/审批信号)、`docs/CONSTITUTION.md`(薄壳原则)。
- 设计原则:结构大于逻辑,不过度工程。skill 是 CLI 之上的一层翻译,不是第二个引擎。

## 1. 目标与非目标

**目标**
- 用户在会话里用自然语言表达运维意图时,Claude 能稳定、安全地驱动本地 `monastery` CLI。
- 输出按 `docs/PROTOCOL.md` 的状态语义解读,给人话总结,而非糊原始 JSON。
- 对会写 GitHub 的动作保持"先预览、人放行"的安全边界。

**非目标(明确不做)**
- 不覆盖一次性配置命令:`init`、`repos add/remove`。
- 不重实现治理逻辑(judge/dispatch/patcher 等)——那是 monastery 引擎的职责。
- 不代替人审批:close/merge/implement/rework 这些 gated 动作永远由人在 GitHub 上放行(👍 / Merge)。

## 2. 定位:operator 薄壳

monastery 本身是"一个被治理的 agent 每 tick 治理一个仓库"的 CLI。本 skill 站在更外层:它是**会话里的操作员助手**,只做三件事——
1. 把意图映射到正确的 `monastery <command> [flags]`;
2. 跑命令、读 `--json` 输出;
3. 按协议把结果翻成人话,并在涉及写操作/审批时把人放回决策回路。

## 3. 触发场景(when to use)

skill 的 `description` 覆盖以下意图(中英混合,贴合实际用法):
- 「巡检 / 治理一下仓库」「monastery 现在什么状况」「repo 状态」
- 「有哪些待我批的 / pending / 等放行的」
- 「backlog / 排了什么 / 优先级队列」
- 「跑一个 tick / 推进一下 / reconcile 一次 / step」

不触发:纯代码问题、与 monastery 无关的 git/gh 操作、init/repos 配置(交回普通流程)。

## 4. 命令映射(只读优先,写操作先预览)

| 用户意图 | skill 行为 |
|---|---|
| 状态 / 现在什么情况 | `monastery status [--repo o/r]`,解读 in-flight 阶段进度 |
| 待批 / 等我放行 | `monastery pending [--repo o/r]`,**逐项给 GitHub 直链**,引导用户去点 👍(issue 提议)/ Merge(PR);skill 不代批 |
| backlog / 排队 | `monastery backlog [--repo o/r]`,给出最近一次 ranked 快照摘要 |
| 跑 tick / 推进 | **先** `monastery step [--repo o/r] --dry-run --json` 展示"会做什么" → 明确问"去掉 --dry-run 真执行?" → 用户确认后才 `monastery step` |

- 无 `--repo` 时命令作用于**所有 tracked repos**(沿用 CLI 语义);如会话上下文明确是某个仓库,带上 `--repo owner/repo`。
- 单 issue 推进:用户点名某个 issue 时用 `monastery step --issue <N>`,同样 dry-run 先行。

## 5. 安全边界(铁律)

1. **`step` 默认 `--dry-run` 先看**:除非用户已在本轮明确说"直接真执行",否则一律先预览再问。
2. **审批永远在人手里**:skill 只用 `pending` 展示 + 给链接;close/merge/implement/rework 的放行由人在 GitHub 完成(`docs/PROTOCOL.md` §4)。skill 绝不模拟 👍、不调用 `gh` 去点赞/合并。
3. **不碰配置**:不替用户跑 `init` / `repos add/remove`;若用户要配置,提示这是一次性设置并交回普通流程。

## 6. 输出解读

- 命令一律优先 `--json`(`step`/`status`/`backlog`/`pending` 都支持;`step --json` 是 NDJSON 事件流)。
- 按 `docs/PROTOCOL.md` 的语义归纳,而非贴原始 JSON:
  - 粗状态:`active` / `awaiting-gate` / `terminal`。
  - `status` 闭集:`awaiting-approval` · `blocked` · `done` · `note`。
  - 字形参考 `STATUS_GLYPH`(⏳/✅/⚠️)给人一眼可读的摘要。
- 解读失败(JSON 非预期/命令报错)时,如实呈现 stderr,不臆造结论。

## 7. 前置自检

- 首次调用前确认 `monastery` 在 `PATH`:`monastery --version`。
- 缺失或报错时,引导用户看 `README.md` 的 Prerequisites(`gh auth login`、`claude` CLI、Node ≥ 20),不硬闯、不贴裸 stack trace。
- monastery 自身的 preflight 已会打印"该修什么";skill 只需把它转述清楚。

## 8. 文件结构与安装

**单文件 skill**(薄壳够用,不拆 references):

```
.claude/skills/monastery/SKILL.md
```

- `SKILL.md` 含 frontmatter(`name: monastery`、`description:` 覆盖第 3 节触发词)+ 正文(第 4–7 节的映射与铁律)。
- **source of truth = 仓库内**这一份,随仓库进版本控制、团队共享。

**全局可用(symlink)**:
```
~/.claude/skills/monastery -> <repo>/.claude/skills/monastery
```
- 个人全局通过软链指向仓库那份,任何项目的会话都能用,且永不漂移(改一处即生效)。
- 取舍:仓库目录搬走/删除会断链——可接受,届时重建软链即可。

## 9. 验收

- 在 monastery 仓库会话里说"巡检一下" → skill 触发,跑 `status`,给人话摘要。
- 说"有什么待我批的" → 跑 `pending`,逐项带 GitHub 直链,且明确说审批要你自己去点。
- 说"跑一个 tick" → 先 `step --dry-run --json` 预览,再问是否真执行,不擅自写 GitHub。
- 在非 monastery 项目会话里(全局软链生效)同样可触发。
- `monastery` 不在 PATH 时,给出 README 的安装/登录引导而非裸报错。
