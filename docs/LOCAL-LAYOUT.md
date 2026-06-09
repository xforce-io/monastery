# 本地结构

> monastery 在 `~/.monastery/` 下的磁盘布局。配套:`CONSTITUTION.md`(§5 GitHub 是唯一真相)、`PROTOCOL.md`(§7 幂等)。
> 实现:`src/config/store.ts`。路线图 step 1(Epic #34)。

## 一句话

**配置是唯一非易失的;其余全是可丢缓存,丢了从 GitHub 重建。secrets 不落盘。**

## 布局

```
~/.monastery/
├── config.json                       非易失 —— 用户意图
└── repos/
    └── <owner>__<repo>/
        └── cache.json                可丢 —— 从 GitHub 可重建
```

`<owner>/<repo>` 映射成目录名时把 `/` 换成 `__`(如 `xforce-io/monastery` → `xforce-io__monastery`)。

## `config.json`(非易失)

被管仓库清单 + 每仓 policy。**这是用户意图,删了得重新配。**

```json
{
  "defaults": { "language": "zh-CN" },
  "repos": {
    "xforce-io/monastery": {
      "model": "opus",
      "language": "zh-CN",
      "agents": { "patcher": { "maxIters": 5 }, "maintainer": { "failThreshold": 1 } }
    },
    "owner/other": {}
  }
}
```

- `repos`:key 是 `<owner>/<repo>`,value 是 per-repo policy(`RepoPolicy`)。
- `model`:仓库级默认模型;缺省时由 CLI 回退(见下)。
- `language`(可选,#76):该仓**对外 GitHub 文本**(issue 评论 / panel / PR 标题+正文 / spec / proposal 草案)的目标语言。注入到所有产出对外文本的 agent(maintainer / patcher / reviewer);代码 identifier、commit message、branch、既有文件语言**不**翻译。解析:`repos.<repo>.language → defaults.language → "en-US"`。另有一道非阻塞安全网——patcher 的 author summary 明显偏离目标语言时 `console.warn` 留痕,但仍开 draft PR(人审才是闸)。
- `defaults`(可选):跨仓全局默认。目前仅 `language`,在某仓未配 `language` 时兜底。
- `agents`(可选):**按 agent 名覆盖各自 spec 默认策略**(`failThreshold`/`maxIters`/`timeoutMs`/`model`)。分层 = **spec 默认 ← per-repo 覆盖**,运行时由 `effectivePolicy(spec, repoPolicy)` 合并(`docs/AGENTS.md`)。不写 `agents` 则全用 spec 默认。

## `repos/<owner>__<repo>/cache.json`(可丢)

每仓一份运行缓存。**删掉无副作用**——下次 tick 从 GitHub 重建(宪法 §5、协议 §7)。

```json
{
  "cursor": 0,
  "fails": { "42": 2 }
}
```

- `cursor`:增量发现的性能游标(当前引擎尚未消费,占位)。
- `fails`:`issue 号 → 连续失败次数`,用于升级判断;丢了只是重置升级计数。

## secrets

**只走环境变量 / 系统 keychain,绝不落 `~/.monastery/`。** GitHub 凭据由 `gh` CLI 自管;模型凭据由 provider(`claude` CLI)自管。本布局里没有任何 secret。

## 模型解析顺序(CLI `step`)

每仓 tick 时,**每个角色(maintainer / patcher / reviewer)各自**按此优先级取 model:

```
agents.<role>.model(effectivePolicy)  →  config.json 的 per-repo model  →  $MONASTERY_MODEL  →  "sonnet"(默认 ≥ sonnet)
```

即 per-agent 覆盖最高;不写 `agents.<role>.model` 时该角色回退到仓库级 model 链。reviewer 额外兼容历史的 `MONASTERY_REVIEW_MODEL`(经 `reviewModel`),其位置介于 per-repo model 之后:`agents.reviewer.model → MONASTERY_REVIEW_MODEL → per-repo model → …`。

`monastery repos add <owner>/<repo> [model]` 写入 config;省略 `model` 则该仓 policy 为空、走回退链。

## 孵化期

v2 孵化期**不保向后兼容**:旧的扁平 `repos.json` / `cursor.json` / `fails.json` 已弃,不迁移——重新 `repos add` 即可,缓存自然重建。
