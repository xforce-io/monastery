# monastery 架构

> 北极星 + 当前结构。原则见 `CONSTITUTION.md`,GitHub 契约见 `PROTOCOL.md`,阵容见 `AGENTS.md`,本地布局见 `LOCAL-LAYOUT.md`。Epic #34(v2)。
> v2 薄壳已落地(#34 系列);多方共识 P0/P1 已实现、P2 在 `docs/design/48-multi-party-consensus.md`。本文标 **north-star** 的是已对齐、未实现的目标。

## 1. 北极星(一句话)

> **monastery = 一层薄的"安全/治理外壳",套在一个有能力的 agent 外面。**

主轴:**外壳不信任 agent,它约束 agent。** 模型变强不会侵蚀外壳——**越强的 agent 越需要约束**。monastery = 把一个**强大、不被信任、还在变强**的 agent,安全地指向一个仓库的**治理层**。

## 2. 三层 + 安全底座(解剖)

核心仍是两边解耦:**外壳保安全(永远成立)· agent 保有用(随模型涨)**(宪法 §1)。展开成三层 + 一道横切的安全底座:

```
resource 层   GitHubAdapter(GitHub 读写) · Store(本地可丢缓存) · 仓库文件
              —— 数据源;外壳的"手"。agent 不碰(§3)。
context 层    外壳为「某 agent × 某 item」从 resource 攒出语义 context
              —— "框架备料"(thesis / 评论 / PR 态 / deps / 共识 / backlog…)。
agent 层      有方法论的角色:读 context → 判断 → 从动作词表提议(只提议,§3)。
──────────────────────────────────────────────
安全底座(横切外壳两层):discovery · loop 覆盖/不饿死 · 强制 gate ·
              幂等 · 身份 · 人类协议 —— 模型不提供、对抗性稳健的东西。
```

数据流:`gather(context 层) → buildContext(AgentSpec,已有) → judge(agent)`。

> **覆盖 vs 强调**(宪法 §11):安全底座保证每个 open item 每 tick 都被检视(不饿死=活性=安全);agent 在"被检视的全部"里判断先做什么(PM 式强调=有用)。

### 2.1 agent 层 = 有方法论的角色

每个 agent 是一份 `AgentSpec`(`src/agents/`,#45;见 `AGENTS.md`),`persona` 即其**角色与方法论**:

| agent | 角色 | 方法论(persona 该有的) |
|---|---|---|
| **maintainer** | 项目经理 | 判"最值得做":影响 × 就绪度 × 成本、依赖优先、范围纪律、何时 spec/implement/defer |
| **patcher** | 研发 | 最小正确改动、TDD、不镀金、暴露假设 |
| **reviewer** | 架构师 / QA | 符合意图、正确性、安全、简洁;blocking vs advisory 判据 |

要 agent 更强 → **改 persona / 方法论,不建新机制**(宪法 §12)。这是真实研发团队的镜像:PM 定做什么 → 研发实现 → 架构/QA 评审。

### 2.2 外壳安全底座(六样,对抗性稳健)

哪怕 agent 错了、不确定、或将来更强但没对齐,照样兜得住:

1. **状态(粗)**:只 `需 agent 看 / 等人放行 / 终结` 三档,落 GitHub(label + marker)。富语义流转 agent 现推,外壳不存。
2. **规则(不变量)**:`agent 只提议不执行`、`没放行不对外写`、`GitHub 是真相`、`崩溃可重放`。
3. **幂等**:每动作怎么不重复(marker / `findPrForBranch` / `prState` / reply-marker,从 GitHub 重建)。
4. **强制 gate**:机械拦住 risky 动作(merge/close/官方回复),没人放行信号就不执行——**强制,非信任**。
5. **人类协议**:人怎么放行(**PR=Merge · issue=👍**)、提议怎么摆(草稿 PR / panel)、marker 约定。
6. **动作词表 + 安全分级**:agent↔外壳的接口;规则与 gate 都挂在它上面。

### 2.3 resource 与 context 层

- **resource**:`GitHubAdapter`(GitHub 读写)· `Store`(本地可丢缓存)· 仓库文件。外壳独占,agent 不碰(§3/§5)。
- **context**:把 resource 攒成 agent 要的语义输入。**现状**:散在 `src/engine/issue-step.ts` 的 `active()`(thesis + 评论 + pr 态 + deps + 共识 + self)。**north-star**:抽成一个**薄 context 模块**,并给 maintainer 加 **backlog 感知**(其它 open issue 摘要),让 PM 判断有料——而外壳照样 loop(覆盖),所以 backlog 感知 ≠ 当调度器、≠ 会饿死。

### 2.4 核心概念模型(名词与两轴)

> 散在 PROTOCOL/AGENTS/代码里的核心名词,这里收口成单一概念模型。宪法 §13 立原则,本节给模型。

**核心名词**

| 名词 | 是什么 | 谁拥有/写 | 落在哪 |
|---|---|---|---|
| **item** | 被追踪的 open issue 或 monastery 开的 PR | — | GitHub |
| **粗状态** | active / awaiting-gate / terminal(只这三档) | 外壳 | label + marker |
| **控制标签** | `needs-approval` / `declined`(外壳路由专用) | 外壳 | GitHub label |
| **展示标签** | `type:bug` 等(给人看状态) | agent 维护 | GitHub label |
| **marker** | `<!--monastery-state-->`(note panel / approval gate) | 外壳 | 评论 |
| **动作(能力词表)** | reply/relabel/panel/openDraftPR/propose/implement/spec/endorse | agent **只提议** | — |
| **安全分级** | safe(当场执行) vs gated(propose→approve→execute) | 外壳 | 挂在动作上 |
| **signal** | 人的放行:PR=Merge · issue=👍(拒=👎 · 重议=👀) | 人 | reaction / merge |
| **gate** | 审批闸门(§4) | 外壳 | needs-approval + 审批评论 |
| **spec** | 共享验收契约(need+acceptance+approach),👍 背书 | maintainer 著 · 各方背书 | issue body / 评论 |
| **agent** | maintainer/patcher/reviewer;`AgentSpec={name,role,persona,sandbox,policy}` | — | `src/agents` |
| **sandbox** | agent 访问权限分级:`artifact-only`/`readonly-clone`/`workspace-clone` | 外壳 | AgentSpec |
| **provider** | agent 运行后端:claude-code / codex / api | 外壳 | — |
| **外壳** | L_repo(`reconcile`)+ L_item(`issueStep`) | — | `src/engine` |

**两轴(外壳约束 agent 的两个维度,宪法 §13)**

```
约束 agent
├─ 效果轴(能造成什么)= 能力词表 + 安全分级 + gate + 永不碰 git/gh   →【§3 接口】
└─ 访问轴(能读/碰什么)= sandbox 三档:
     artifact-only   只读输入文本、只写产物          —— 不碰代码(reviewer)
     readonly-clone  只读整个 repo、写无效(外壳不采纳) —— 只读代码(maintainer,#108)
     workspace-clone 读写沙箱、外壳读 diff            —— 读写代码(patcher)
   不变量:读非边界,写才是。
```

**关系一句话**:外壳发现 **item** → 按**粗状态**路由 → active 调 **agent**(其 **sandbox** 决定能读多少)→ agent 从**能力词表**提议**动作** → 外壳按**安全分级**:safe 当场执行 / gated 摆 **gate** 等 **signal** → 人放行 → 执行。**spec** 是 issue 侧到开发侧的过境契约。

## 3. 接口:动作词表 + 安全分级

agent 输出 = 一组**提议的动作**,每个在外壳预定义词表里,外壳知其安全级与幂等键。实现:`src/shell/actions.ts`(`ActionSchema` 同源)。安全动作 `executeSafe` 当场做;`implement` 路由到 patcher;gated(close/merge)只能经 `propose` + 人放行。详见 `docs/design/34-action-vocabulary.md`。

## 4. 生命周期:agent 推断,外壳只持粗状态

外壳每 tick(`reconcile` → `issueStep`):discovery(列 open items)→ 三档分(active / awaiting-gate / terminal)→ active 调一次 maintainer → `executeSafe` 它的提议 / `implement` 走 patcher;awaiting-gate 查信号(👍/Merge)→ gated 执行器。富语义流转 agent 现推,外壳不存。详见 `PROTOCOL.md`。

## 5. 这个下注 + 何时它是错的

**下注**:模型能力会涨——让强 agent 端到端推理,外壳只做"安全/治理/幂等/覆盖"。

**取舍**:每 item 一次 agent 调用比"便宜路由 + 小 judge"更贵;路由非确定(agent 决定),但**只提议**——治理/幂等仍确定可测。放弃测"路由逻辑",保留测"治理/副作用"。

**何时错**:若模型长期**不够强**到端到端可靠维护一个仓库。判据:dogfood 中单 agent 端到端**一次成功率**够不够高(自审门 #22 + 人 merge 闸是安全网)。— 已开始 dogfood(monastery 给自己开 PR,#59/#61/#63),成功率在积累。

## 6. 非目标(明确不建)

- 富生命周期状态机 / 每类任务一个 judge / 投机性通用 dispatch(在有真实 producer 前)。
- 框架解析 agent 数据(AGENTS.md 等)——那是 agent 的。
- **把"看哪些 / 不饿死"交给 agent**——活性/安全归外壳,不塞进不被信任方(§11)。
- **context 层做成插件框架**——它是**数据装配模块,不是框架**;**persona 写成死脚本**——给判据,别规定每步(§12)。

## 7. 关联
- 原则 `CONSTITUTION.md` · 契约 `PROTOCOL.md` · 阵容 `AGENTS.md` · 本地布局 `LOCAL-LAYOUT.md`。
- 词表 `docs/design/34-action-vocabulary.md` · 多方共识 `docs/design/48-multi-party-consensus.md` · 路线图 `docs/superpowers/specs/2026-06-06-v2-refactor-roadmap.md` · v0 旧设计 `docs/superpowers/specs/2026-06-05-monastery-v0-design.md`。
- 治理脊柱来源:#23(闸门)· #31(PR 检测)· #22(自审)· #45(agent 统一定义)。
