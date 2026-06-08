# 智能体清单

> monastery 的智能体定义索引。**定义即真相在代码里**(`src/agents/*` 的 `*Spec` + persona);本文是**指针**,不复制 persona。
> 配套:`CONSTITUTION.md`(§3 agent 不碰 git/gh、§8 useful 塌进 agent)、`PROTOCOL.md`、动作词表 `docs/design/34-action-vocabulary.md`。

## 一句话

agent 的定义(persona / 输入 / 输出 / 沙箱 / 策略)是 v2「发挥模型能力」的主操作面,统一收在 `src/agents/`:一个 agent 一份 `AgentSpec`,共性(跑→读→校验→回退)交给薄 runner `runStructuredAgent`。

## 阵容

| agent | 定义 | 角色 | 输入 → 输出 | 沙箱 | 在哪被调 |
|---|---|---|---|---|---|
| **maintainer** | `src/agents/maintainer.ts` `maintainerSpec` | **项目经理**:读 item+上下文 → 判最值得做 → 提议动作 | `MaintainerInput`(thesis/issue/评论/PR 态)→ `actions.json` = `Action[]`(`ActionSchema`) | `artifact-only` | `engine/issue-step.ts` `active()` |
| **reviewer** | `src/agents/reviewer.ts` `reviewerSpec` | **架构师/QA**:评判 patcher 的 diff(自审门 #22) | `{diff, issue}` → `review.json` = `{findings}`(`ReviewSchema`) | `artifact-only` | `engine/patch.ts` `runImplement()` |
| **patcher** | `src/agents/patcher.ts` `patcherSpec` | **研发**:在沙箱里修 issue,产 diff | issue → 工作树改动(无 schema,外壳读 diff) | `workspace-clone` | `engine/patch.ts` `runImplement()` |

> **角色即方法论**(宪法 §12):每个 agent 是一个有方法论的角色——PM 定做什么 → 研发实现 → 架构/QA 评审。要它更强就改 persona 的方法论,不建新机制。方法论清单见 `ARCHITECTURE.md` §2.1。

> patcher 是 `workspace` 模态(产 diff 非 JSON),保留自己的 clone/自审循环;persona(主 + `fixPersona`)与 policy 从 `patcherSpec` 取。maintainer/reviewer 是 `schema` 模态,走 `runStructuredAgent`。

## 统一定义(`src/agents/spec.ts`)

```ts
AgentSpec      = { name, role, persona, sandbox, policy }         // 共有身份
StructuredAgentSpec<In,Out> extends AgentSpec { buildContext, artifact, schema }  // maintainer/reviewer
WorkspaceAgentSpec          extends AgentSpec { fixPersona? }                     // patcher
AgentPolicy    = { model?, timeoutMs?, failThreshold?, maxIters? }
```

- **runner** `runStructuredAgent(spec, input, {provider, model, artifactDir})`:跑 provider → 读 `spec.artifact` → `spec.schema` 校验 → 回退 stdout 抽取 → `null`。一处实现,maintainer/reviewer 复用。

## 不变量(测试钉死,`tests/agents.test.ts`)

- **每个 persona 都声明「不碰 git/gh」**(宪法 §3)——边界写进定义,不靠各自口头。
- **沙箱显式**:maintainer `readonly-clone`(只读代码,验真后才提 implement,#108);reviewer `artifact-only`;patcher `workspace-clone`。
- **运维策略在 spec.policy**:`failThreshold`/`maxIters` 等的单一归宿。**默认值在 spec,per-repo 覆盖在 `RepoPolicy.agents`**——运行时 `effectivePolicy(spec, repoPolicy)` 合并(`config.json` 配 → `Store.repoPolicy` → `ctx.repoPolicy` → 引擎)。

## 边界回顾

三个 agent 都**不碰 git/gh**,各在自己沙箱里只产文件/改工作树;一切副作用(标签/评论/PR/merge)由外壳做、risky 的卡人闸(宪法 §3/§4)。**判断权随模型涨(agent),执行权与不可逆副作用锁在外壳(不变)。**
