# monastery v0 设计

> **Monastery: where repositories learn to govern themselves.**

- 日期：2026-06-05
- 状态：草案，待评审
- 一句话：**每个 repo 一个独立 reconciler，以 GitHub 为唯一真相源与共享内存，通过多层 `step` 协作式推进——像单核多线程跑在 GitHub 上的 AI repo maintainer。**

名字的隐喻：monastery 是一个按「规约（Rule）」自治的共同体——`thesis.md` 是这个 repo 的规约，reconciler 是日常守约的修行（多层 step 把它一格格守回规约），自治的主体始终是 repo 自己。

---

## 1. 目标与范围

### 1.1 Thesis

monastery 是 repo 的 AI maintainer。它不"看到 issue 就修"，而是按一条可追溯的链路、以确定性的方式推进 repo 的工作，只在少数"判断点"调用 LLM，所有对外动作都先经人工审批。

### 1.2 范围：设计范围 vs 实现里程碑

为避免验收歧义，明确区分两个"范围"：

- **设计范围（Design Scope）= 本文档描述的完整系统**，涵盖里程碑 M1–M5（见 §15）：thesis 门禁、issue triage、显式点名补丁、跨 repo Signal 协作、完整预算。
- **MVP / 里程碑 1 实现范围 = 首个可跑版本**，刻意只含 **thesis-gate 全闭环（单 repo）**，不含 triager / patcher / coordination / 完整预算。

> 下文凡"设计范围内"指前者；"首个可跑版本能跑什么"一律以 §15 里程碑 1 为准。两者不可混用作验收口径。

设计范围内的能力：

- **协调 + 建议修复**：thesis 门禁判定、issue triage 打标、把 issue↔PR↔CI 连线并追溯、对**被显式点名**的 issue/CI 失败生成补丁草稿（draft PR）。
- **人工审批后才合并**：任何对外正式 / 不可逆的动作（正式回复、关 issue、开/合 PR）都要人点头。
- **跨 repo 协作原语**：reconciler 之间通过 GitHub Signal（评论 + 结构化 marker）通信。这是核心概念模型，属设计范围（落地在 M4）。

### 1.3 设计范围明确不做

- 不自动判断 issue"简不简单"再自作主张开 PR——补丁一律**显式点名才触发**。
- 不做 L0 的 LLM 智能调度（先确定性策略，留接口）。
- 不做 Telegram 等具体 channel（控制面就是 GitHub 本身；channel 是以后的可插拔适配器）。
- 不做多 owner / 多信任域的 per-repo 身份（v0 单一机器账号）。

### 1.4 自托管（dogfooding）—— monastery 是 managed-repo #0

monastery 从第一天就把**自己这个 repo** 纳入管理：`monastery` 是 `repos.json` 里的第 0 个 repo，配自己的 `.monastery/thesis.md`。项目自身的开发即最强测试回路，也直接兑现 motto——**第一个学会自治的 repo 就是 monastery**：它的 thesis 门禁它自己的范围，新功能 issue 先过自己这关（服务"战略不跑偏"）。

自托管程度**随里程碑收紧**（诚实：不是 day-1 全有）：

```text
M1  gate / triage 自己的 issue          ← 第一天就有
M3  对自己的 bug/CI 失败开 draft PR + 跑测试  ← 开发 + 测试回路成立
之后 跨 repo 时与其它 repo 互发 Signal
```

- bootstrap 事实：最初的代码仍由人/Claude Code 直接写（monastery 不存在时管不了自己）；M1 上线即管自己 issue，M3 上线即能给自己提代码。
- **早建 CI**（GitHub Actions + vitest），让 M3 的"改→测"有真实信号；patcher 还会在 worktree 里**先本地跑测试再 push**（比只等 CI 更紧的内回路）。
- **自改安全**：monastery **绝不 auto-merge 自己的代码**（门禁天然覆盖——draft PR 由人 review+merge）；手改 monastery 时打 `monastery:hold` 暂停它对自己的处理。运行进程与被改 repo 相互独立，draft PR 不影响在跑的二进制，直到人 merge+重启。

### 1.5 运行形态

- 宿主：常开的 Mac mini。
- 编排器：用户自有的 OpenClaw-like bot 驱动 step。
- 触发：外部的事（cron / 手动 / 未来的 channel 指令）。monastery 自身**不含调度心跳**。
- 数据源 / 真相源：GitHub（gh CLI / GitHub API）。
- 本地：仅放配置（管哪些 repo、policy、预算）+ 可丢的 cursor 缓存 + secrets。

---

## 2. 核心概念模型：单核多线程跑在 GitHub 共享内存上

| 单核多线程 | monastery |
|---|---|
| 单核 | 一个 step 执行器，一次推进一个 quantum，无真并行 |
| 线程 | 每个 in-flight item（其状态机执行流 = 一条线程） |
| 调度器 | `reconcile(repo)`：从 runnable 集挑一个，给一个 quantum |
| 时间片 / yield | 一次 `innerStep` = 一个 quantum；`await` / `waiting` 处让出 |
| 阻塞 (blocked on I/O) | `waiting(on: human/peer/ci)` → 移出 runnable，descheduled |
| 唤醒 | level-triggered：观察 GitHub，条件满足 → 重回 runnable |
| **共享内存** | **GitHub** |
| 同步原语 (mutex/condvar) | label / state / Signal marker |
| 线程间通信 | 改共享内存（写 GitHub），**不是消息总线** |

推论（贯穿全设计）：

- **协作式 quantum**：`reconcile(repo)` 一次 = 一个调度 tick，给每个 runnable item 一个 quantum 就 yield，不会"先干完 A 再碰 B"（round-robin，慢 item 不饿死别人）。
- **waiting = 阻塞，不做重活（但仍廉价探条件）**：进 `waiting` 的 item 不进入 runnable quantum（不调 LLM、不下钻干活）。但 level-triggered 下**没有持久 blocked queue**，所以 L0 每 tick 仍会对每个 waiting item 跑一个**廉价 watch predicate**（一次 GitHub 读，常是条件请求/304）判断是否被唤醒；predicate 为真才升回 runnable。即"不 busy-wait 重活，但廉价探条件"——既非"完全不看"，也非忙等。
- **单核 = 天然无锁无竞态**：一次只推一个 quantum；加上每个转移幂等、状态在 GitHub，连多执行器都安全。v0 单核最省心。
- **无死锁**：request/response 不是互斥锁——收到 inbound 的一方立即 runnable（有活干：回复），不会双方互等。

单 repo → 多 repo 自然外推：单 repo = 一台单核多线程机器；多 repo = 多个这样的"核 / 节点"共享同一块内存（GitHub）；跨 repo 协作 = 一条线程 block 在条件变量上，等另一个核通过共享内存 signal 它。item 级语义完全不变。

---

## 3. 四个原语

```text
State   状态     = label + <!--monastery-state--> 块         （内存）
Step    推进     = 递归 step 协议 + 调度 quantum             （执行）
Signal  通信     = @mention + marker，reconciler 间唯一交互   （线程间通信）
Wait    等待/唤醒 = waiting(on:…) + level-triggered 观察       （条件变量）
```

### 3.1 State —— 状态如何编码在 GitHub 上

状态/进度有三个家，按"谁 author 的就写谁的地方"分，**monastery 绝不改人写的 issue/PR body**：

| 内容 | 家 |
|---|---|
| 宏观状态（互斥，转移时替换） | **label** `monastery/state:<x>` |
| 分类信息（叠加） | **label** `thesis:in\|out\|unclear`、`type:bug\|feature\|question` |
| 复合态内部进度（attempts / await:corr / protocol） | **monastery 自有的一条 sticky 评论**，原地编辑 |
| Signal（to/from/corr/kind） | **就在那条 Signal 评论里**（Signal 本就是一条评论） |

复合态进度的 marker 块（放在 sticky 评论里）：

```text
<!--monastery-state
  protocol: patch
  attempts: 2
  last_ci: red
  await: corr-X        # 等待哪条 Signal 的回复
-->
```

**sticky / panel 评论 = 常见 bot 模式**：每个 in-flight item 一条，monastery **原地编辑**（不刷新评论）；可见部分是人看的状态面板（含**明确标注为「待审提议」的草稿**，见 §9），hidden 的 `<!--monastery-state-->` 在其中。定位便宜——"author=@monastery-bot 且含该 marker 的那条"。单核串行，只有 monastery 编辑它，无冲突。**内容受限**：只放状态摘要 + 标注待审的提议，**绝不是**以 repo 名义对外的"正式回复"。

**铁律**：monastery 永远只写**它自己 author 的内容**（sticky 评论 + Signal 评论），绝不动人写的 body。

**原则**：任何一层 `step` 要的"我做到哪了"，都从 label + sticky 评论 marker + GitHub 原生事实（PR/CI/comment）读出。本地永远只有配置 + 可丢 cursor。

### 3.2 Step —— 统一契约

```ts
type Outcome =
  | { kind: 'progressed', note?: string }              // 挪了一格，还有活，再敲
  | { kind: 'waiting', on: 'human' | 'peer' | 'ci' }   // 停住，等外部变化
  | { kind: 'done' }                                   // 这个单元完成
  | { kind: 'noop' }                                   // 没我的事

type Step<Ctx> = (ctx: Ctx) => Promise<Outcome>
```

父层用子层的 `Outcome` 决定自己动不动：子 `done` → 父宏状态转移；子 `progressed | waiting` → 父保持原态、原样上报。详见第 5 节。

### 3.3 Signal —— reconciler 间唯一通信原语

**一个 Signal = 一条 GitHub 评论**：

```text
@monastery-bot                    # 人可见 + 多账号时的门铃（单账号 v0 不靠它发现，见 §8）
<!--monastery
  to:   owner/repoB               # 门牌：路由地址（不靠 @handle 区分）
  from: owner/repoA#123           # 回信关联
  corr: X                         # 关联 id，唯一配对 request↔reply
  kind: request | reply           # 信号类型
-->
正文（自然语言，给人看）
```

四个属性缺一不可：**有地址**(to)、**可配对**(corr)、**持久**(它是评论)、**可观测**(人能看、search 能发现)。

**铁律：reconciler 之间永远只通过 GitHub 通信，绝不进程内直调——哪怕同进程。** 理由对应四条已定原则：

1. **持久**：进程崩了，进程内请求丢失；写 GitHub 则重启后两边都能重建。
2. **异步独立**：B 可能几小时后、甚至另一台机器才被触发；进程内直调要求同时在场。
3. **人可见**：交互是真实评论，维护者能看见跨 repo 协商、能插手。
4. **单→多 repo 同构**：A、B 以后属于不同 owner / 部署时，GitHub 是唯一公共媒介；day-1 就走 GitHub，单进程和多部署是同一套机制。

寻址：`@handle` 仅作人可见标记与未来多账号门铃；**v0 单账号下发现靠 §8 的 search/scan，不靠 @mention**。真正路由看 `marker.to`。

### 3.4 Wait —— 等待与唤醒

- item 进入 `waiting(on:…)` = 阻塞在条件变量上，**不进入 runnable quantum**（不做重活）。
- 唤醒是 **level-triggered**，且因为没有持久 blocked queue，**L0 每 tick 会对每个 waiting item 跑一个廉价 watch predicate**：读它自己的 thread / linked PR / CI（常是条件请求/304），判断条件是否满足；满足才升回 runnable、下钻干活。
- 所以准确说法：**waiting item 不跑重活（不调 LLM/不下钻），但会被廉价探条件**——不是"完全不看"，也不是 busy-wait。
- 每个 `on` 对应一个明确 predicate：`human` = 审批标变化；`peer` = thread 出现配对 reply(corr)；`ci` = linked PR 的 checks 完成。

---

## 4. 架构与边界

```text
   外部触发（cron / 手动 / 未来 channel）        ← 不属于 monastery
            │ 调用
            ▼
   reconcile(repo)  —— per-repo，独立，自带游标
   │
   ├─ L0 reconcile(repo)     本 repo 这一轮推谁（调度器）
   ├─ L1 issueStep(item)     单 item 宏状态机推进
   └─ L2 innerStep(item, p)  复合态内部子流程推进
            │ 用到 ↓（L2 能力层）
   ┌────────┴───────────┬──────────────┬──────────────┐
   │ github-adapter     │ judges       │ ApprovalPort │
   │ (读/写 GitHub)      │ (LLM 判断)    │ (挂待审)      │
   └────────┬───────────┴──────────────┴──────────────┘
            │ 全落到
   GitHub（真相源 + 进度 + 待审 + Signal 都在这）   本地：仅 repos 配置 + cursor
```

**关键边界纪律**（判据 = 可逆/发现 vs 不可逆/对外，不是"机械 vs 智能"）：

- **shell（确定性引擎）独占两类事**：① reconcile 循环 / 状态机 / 幂等 / level-triggered 发现 / cursor / Signal 关联——确定、可测、零 token；② 少数**不可逆/对外**动作（merge、close、以 repo 名义正式回复），且只在 `monastery:approved` 后执行。
- **agent（judges）只做仓库内、零 GitHub 写的事**：读 repo、改 worktree 文件、本地跑测试、产出 patch artifact。它**完全不碰 GitHub**——连可逆写（branch/commit/push/开 PR）都不做，因此 agent 进程**不带任何 gh 凭证**。
- **所有 GitHub 写都在 shell**（含可逆的 branch/commit/push/开 draft PR），dry-run / 幂等 / 可测才守得住。可逆/不可逆只用来分**审批门**（draft=提案，免审批 / merge=门控，必审批），但**执行者永远是 shell**。
- **github-adapter** = 发现用的只读查询 + 那几个写操作（含 patch 的 git/gh 机械步）；薄，但是唯一的 GitHub 写入口。

judges 全部走**同一个 Provider 抽象**（仿 `~/dev/github/petri`），不分"结构化 API"和"agentic"两路：

```ts
AgentConfig  { persona, playbooks[], context, artifactDir, model, timeout }
AgentProvider.createAgent(cfg) → Agent
Agent.run(signal) → { artifacts[], usage }
```

- 默认 provider = **claude_code**：在 `artifactDir` 里 spawn `claude -p --model <m> --output-format json`，**agent 靠写文件输出**，跑完扫描 artifactDir 收文件。复用本地 Claude Code 鉴权（无 API key / 无 per-token 账）、留在 Mac 上。
- 判断点的"结构化输出" = 约定 agent 把结果写成 artifactDir 里的 `<name>.json`；shell 读回并 zod 校验。
- provider 可插拔；**v0 只做 `claude_code`（默认）+ `codex`（备选），其余先不考虑**。`model` 只是传给 agent 的字符串，可按 role 配。
- 三个 judge（thesis-gate / triager / patcher）是同一个 `run()`，只是 persona/playbooks/context/cwd 不同——patcher 的 cwd 是 git worktree，其余无需 repo。

---

## 5. 三层递归 step

### 5.1 L0 · `reconcile(repo)` —— per-repo 调度器（"下面做什么"）

```text
作用域：只读自己这一个 repo（借三元组/四元组游标）
读：    本 repo 的可行动 item（发现方式 = GitHub 查询，cursor 仅加速）
          无任何 monastery/state:* 标的 open issue = virtual new（triage 入口）
          monastery/state:approved       （待执行）
          marker.to=本repo 的未处理 inbound Signal（发现方式见 §8）
          monastery/state:coordinating / :patching （复合态，跑 watch predicate）
判断：  本 repo 内的确定性优先级 + 本 repo 预算
          1 执行已 approved（最便宜，解人类的堵）
          2 回应 inbound Signal（解别的 repo 的堵）
          3 triage 新 issue
          4 推进 in-flight 复合态
        预算：每 tick 最多 N 次 LLM 调用 / M 次写操作，超了即停，下次续
做：    对每个 runnable item 给一个 quantum（调 L1），收集 Outcome
出：    报告（推进了啥 / 在等啥 / 卡在哪）
```

L0 **无记忆**：每次从 GitHub 重算 worklist。它是唯一跨 item 的层，但**绝不跨 repo**（无全局扫描，否则就退回中央协调，违背 choreography）。

**Bootstrap 与终态规则**：GitHub 新开的 issue 本身没有 monastery 标——**任何缺 `monastery/state:*` 的 open issue 一律视为 virtual new**（triage 入口）。**每次处理后必须给 item 赋上且仅一个 `monastery/state:<x>`**（互斥替换），否则下个 tick 会重复 thesis-gate。"是否处理过"由此完全编码进 GitHub 状态，不依赖本地。

### 5.2 L1 · `issueStep(item)` —— 单 item 宏状态机

```text
读： 这一个 item 的全部 GitHub 状态（labels / linked PR / CI / marker 块）
转移（item 当前态 = 它的 monastery/state:*；virtual new 视为 new）：
  new            → thesis-gate(+triager) → 打 thesis/type 标 → 据判定提议 → state:triaged
  triaged        → 有待审提议 → 写入 panel + state:needs-approval（waiting:human）
                   无待审提议（thesis:in/unclear）→ 停在 state:triaged，parked
                     （M1 的 L0 不再选它 = 零成本；M2 triager 上线后从 state:triaged 接手。不落 done）
  needs-approval → 看人有没有打 monastery:approved；没有 → waiting:human
  approved       → 执行对外正式动作（发布正式回复 / 关 issue / 合 PR）→ state:done
  coordinating   → 复合态，下钻 L2(coordination)
  patching       → 复合态，下钻 L2(patch)
  复合态：L1 不直接转移，按 L2 的 Outcome 决定 转移 / 保持
不变式：每次转移**恰好**留下一个 monastery/state:*，从不让 item 处于"无 state"。
出： 自己的 Outcome 上报 L0
```

L1 只看一个 item，绝不看别的——隔离 = 可测。

### 5.3 L2 · `innerStep(item, protocol)` —— 复合态内部子流程

两个 protocol，结构同构：

```text
protocol = coordination（跨 repo 推进，见第 7 节）
  读 GitHub：我上条 request(corr:X) 的 reply 回了吗
  没回 → waiting:peer
  回了 → 读回复 → judge 下一步 → 发出去 / 更新 marker → progressed
  谈完 → done（L1 据此推进宏状态）

protocol = patch（仅被显式点名 monastery:try-fix 时）
  无 draft PR → 跑 patcher（只改 worktree + 本地跑测试，产出 patch）
               → shell：branch / commit / push + 开 draft PR（Closes #N）→ progressed
  有 PR & CI 跑中 → waiting:ci
  有 PR & CI 红  → 重试预算内：再跑 patcher 改 → push → attempts++ → progressed
                  预算耗尽：打 monastery:needs-human → done（交回人）
  有 PR & CI 绿  → done（draft 本身就是待你 merge 的审批面）
```

L2 子状态也全在 GitHub（draft PR / 它的 CI / 对方 repo 的 thread / marker 块）。要再等第三个 repo 就再下钻 L3，契约一模一样——"至少三层"本质是 N 层，结构自相似。

### 5.4 空闲与退避

对应线程模型的"所有线程都阻塞 → 核 halt，等唤醒，绝不空转"，延伸到时间维度。要点：**reconcile 自己永不 sleep**（monastery 无心跳），它廉价返回一个退避提示，由**外部触发器**据此安排下次调用 = 自适应退避。

```ts
ReconcileResult {
  advanced: number,
  waiting: { on: 'human' | 'peer' | 'ci', count: number }[],
  idle: boolean,
  nextPollHint: Duration   // "最早值得再叫我"
}
```

`nextPollHint` 由"大家在等什么"推出：

```text
有 waiting:ci    → 短（分钟级）
有 waiting:peer  → 中
有 waiting:human → 长（小时级）
完全没 item，只盯新 issue → 最长
floor = notifications 的 X-Poll-Interval（不低于它）
```

- **idle tick 近乎免费**：一次条件请求（ETag → 304）确认无事可做，不耗额度。
- **退避是默认节奏，不是硬睡**：任何外部 nudge（手动 / 未来 channel / webhook）短路退避立即跑。纯轮询下新 issue 延迟上界 = 当前退避间隔，靠 floor/ceiling 可调。
- `nextPollHint` 可选落 cursor（可丢），仅为崩溃后恢复退避节奏，非业务真相。

---

## 6. per-repo reconciler 与游标

- **unit 是 per-repo reconciler**，没有全局层。每个 reconciler：自己的触发、自己的游标、自己的 step 循环，互不知道对方存在，唯一交汇点是 GitHub。
- **三元组游标**（per repo，纯性能、可重建）：

```jsonc
// ~/.monastery/<owner>-<repo>/cursor.json  —— 可丢
{ "issues": "<watermark>", "prs": "<watermark>", "runs": "<watermark>" }
```

- **notifications 水位**是账号级一条流（见第 8 节），单独存，也可丢。
- level-triggered 下游标不参与正确性（正确性全在 GitHub 的 label/state），只是免得每次从头扫。

---

## 7. 跨 repo 协作（coordination protocol）

### 7.1 完整生命周期

```text
A.issueStep(#123) 需要 B：
  发 Signal{to:B, from:A#123, corr:X, kind:request} 到 #123 线程
  → state:coordinating + marker{await:X}；outcome = waiting(on:peer)

B.reconcile（自己的 tick）：用 §8 的 search/scan 发现未处理 inbound（marker.to=B），路由进 B
  B.handleInbound：
    · 能直接答    → 发 Signal{kind:reply, corr:X} 回 #123 → 这条 inbound done
    · 需 B 侧改动  → 在 B 建本地 item B#45，走 B 自己的状态机推进
                    （B 不阻塞 A 的调度——那是 B 自己的线程在干 B 的活）
                    B#45 done 时 → 发 reply corr:X 回 #123

A.issueStep(#123) 后续 tick：state:coordinating，await:X
  在 #123 线程找 corr:X 的 reply
    没有 → waiting(on:peer)（廉价：只读自己 item 的 thread）
    有了 → 消费 → 宏状态前进 → progressed/done
```

对话**留在请求方 A 的 item thread 里**，B 以"被 @ 的参与者"身份进来。B 处理 inbound 可能派生出 B 自己的 item——Signal 原语与 per-item 状态机天然组合。

### 7.2 身份（v0）

**单一 `@monastery-bot` 机器账号**。`@handle` 当门铃、`marker.to` 当门牌路由。适配 v0 场景（用户自己的一堆 repo，单一信任域）。多 owner 才需要 per-repo 身份，属于以后。

### 7.3 幂等 / 去重

- `corr` id 是唯一键：`kind:reply corr:X` 是该 request 的唯一响应；发前先查，绝不重复发。
- "已处理"判定看 thread 上有没有配对 reply / reaction（level-triggered 真相），**不信** notification 已读态。

---

## 8. Signal 发现（discovery）

reconciler 怎么发现"有 Signal 要处理"。三层：**增量扫描（可靠底盘） > Search（快路径） > notifications（可选加速）**——可靠性始终落在底盘。

**为什么不能靠 notifications 当队列**：GitHub notifications 是用户**收件箱**语义——是否进 inbox 受通知设置、watch/subscription、参与状态影响；它是"订阅活动更新"的可条件请求 inbox，**不是持久消息队列**。更关键：**同一账号 @ 自己通常根本不产生通知**，而 v0 是单账号——所以 notifications 在 v0 很可能**不触发**，绝不能作为发现机制建模。

**可靠底盘 = 按 managed repo 增量扫 open issues/PR 的 comments（REST list）**：

```text
for repo in managed repos:                # 列表已知、有界 → 限流友好
  list open issues/PRs（按 cursor 增量，updated_at 水位）
  扫其 comments 里的 monastery Signal marker
  → 按 marker.to 路由出 inbound
  → 对每条跑"已处理判定"（thread 上有无配对 reply/reaction corr）→ 未处理即 runnable
```

确定、完整、限流友好；cursor 只是增量优化，**可丢**，丢了就全量重扫一遍 managed repos 重建。

**Search API = 快路径，不作唯一依据**：`is:open "<!--monastery"` 能跨 repo 一把捞，但有**索引延迟、限流、结果截断**——只用来加速"该看哪几条"，正确性永远回落到上面的增量扫描。

**notifications = 可选加速器**：触发时（未来多账号 / 跨账号 mention）降低发现延迟；触发不了也不影响正确性。**永不**作为真相或唯一发现路径。

```text
GET /notifications  （可选，加速）
  If-Modified-Since + X-Poll-Interval：触发时廉价拿到"去哪看"的提示
```

可丢的水位（账号级，非 per-repo）：`~/.monastery/account-cursor.json` → `{ "notifications_since": "...", "etag": "..." }`。

**"已处理 / 未处理" = thread 真相**：只看那条 Signal 评论后面有没有 monastery 的配对 reply / reaction，**不信** notification 已读态（账号全局可变、不可靠）。本地全删也能从上面的 search + 该判定完整重算。

discovery（search/scan）= 可靠底盘；notifications = 可选加速；truth（thread）= 持久、唯一、可重建。

---

## 9. 审批模型（控制面 = GitHub 本身）

引入 `ApprovalPort` 接口，把"通知 / 审批"从核心解耦；v0 只实现 `GitHubChannel`：

承载与执行**分两步**，解决"草稿一发评论就公开"的边界冲突：

```text
① 提议（auto，写进 monastery 自有的 panel 评论，不作为正式回复）
     关闭/回复草稿 → panel 内挂草稿正文（折叠 <details> 标注「待审提议」）
                     + 打 monastery:needs-approval
     补丁         → 开 draft PR（draft 状态本身即"待审"）
   panel 是 monastery 自己 author 的内容，免审批，但内容受限：只放
   状态摘要 + 明确标注的待审提议，绝不是给 issue 作者的"正式回复"。

② 执行（gated，仅 monastery:approved 后）
     发布正式回复（一条新的、面向作者的评论）/ 关 issue / 合 PR
   人审批 = 移除 needs-approval / 打 monastery:approved（下个 tick 执行②）
            或直接把 draft PR 标 ready / 合并
```

**自动 vs 审批的默认线**（per-repo 可调）：

- **免审批**（机械 / 可逆 / monastery 自有面板）：打 label、写 marker、编辑 panel 评论（仅状态 + 标注待审的提议）、advance cursor；**以及 shell 为 patch 执行的可逆动作**：branch / commit / push / 开 **draft** PR（draft 本身即提案；agent 只产出 patch，不碰 GitHub）。
- **必审批**（不可逆 / 以 repo 名义对外）：发布**正式回复**、关 issue、**合 PR**（draft → ready / merge）。

> 边界澄清：panel 评论技术上公开可见，但它是"monastery 的提议面板"而非"代表 repo 的正式回复"，且明确标注待审——故归入免审批是安全且透明的。真正受控的是②里"以 repo 名义对外正式发声 / 改变状态"的动作。

Telegram 等以后只作为另一个 `ApprovalPort` 适配器：镜像 GitHub 上的待审 + 让你一句话代替"去 GitHub 点一下"。**核心 loop 一行不改。**

---

## 10. 三个判断点（judges）I/O 契约

```jsonc
// judge 1 · thesis-gate（API + structured output）
// in
{ "thesis": "<.monastery/thesis.md 正文>",
  "issue": { "title": "...", "body": "...", "labels": [] } }
// out（zod / JSON-schema 强校验）
{ "verdict": "in" | "out" | "unclear",
  "reason": "<=2 句，引用 thesis 哪条" }

// judge 2 · triager（仅 verdict==in 时调）
// in
{ "issue": { "title": "", "body": "", "labels": [] } }
// out
{ "type": "bug" | "feature" | "question",
  "labels": ["type:bug"],
  "draft_reply": "<给提报人的回复草稿，markdown>" }

// judge 3 · patcher（Claude Code agent，唯一需 repo 工作区）
// in
{ "target": { "kind": "ci_failure" | "bug_issue",
              "issue_ref": 123, "ci_log_excerpt": "...", "repo_path": "..." } }
// out
{ "diff": "<unified diff>",
  "pr_title": "", "pr_body": "... Closes #123",
  "confidence": 0.0,
  "notes": "<不确定点 / 没动的地方>" }
```

**调用方式（统一）**：每个 judge = 一次 `agent.run()`，persona/playbooks 固定其职责，context 喂上面的 `in`，**约定 agent 把 `out` 写成 artifactDir 里的文件**（`verdict.json` / `triage.json` / `patch` 改动）。shell 读回、zod 校验：缺文件或不合 schema → 跳过 + 告警，绝不把脏数据写回 GitHub。

**边界靠环境隔离，不靠 API 形状**：thesis-gate / triager 的 agent 进程**不挂 repo、env 不带 gh 凭证** → 物理上碰不到 GitHub，只能往 artifactDir 写文件；patcher 在 git worktree 里跑、改动仍由 shell 用 gh 开 PR。所有 GitHub 写操作只在 github-adapter 里。

---

## 11. 安全 / 幂等 / 防跑飞

- **幂等键** `(repo, issue#, action-type)` / Signal 的 `corr`：动作前先查 label/marker/reply，重复 tick 绝不二次发评论或重复开 PR。
- **cursor 后置推进**：动作确认成功后才推进；崩溃重放安全（因幂等）。
- **dry-run 模式**：打印全部 intended actions 不落副作用——日常默认观察方式。
- **防接入爆发**：里程碑 1 仅一行 `MAX_ITEMS_PER_TICK = K`（`.slice(0,K)`），防大存量 repo 接入时一个 tick 爆发数百次 thesis-gate（dry-run 拦不住 LLM 成本，只拦写操作）。完整 per-repo 配额 + token 账延后，随 patcher/coordination 的高成本一起回归。
- **schema 校验**：judge 输出过 zod，脏数据 → 跳过 + 告警。
- **审批超时**：待审痕迹 N 小时无响应 → 自动 skip 并标记，不悬挂。

---

## 12. 数据 / 真相源分工

| 谁 | 存什么 | 能否丢 |
|---|---|---|
| GitHub | 全部业务+进度：state label、分类 label、PR/CI、comment thread、Signal、`<!--monastery-state-->` 块 | 不能，唯一真相 |
| 本地 | repos 配置、policy/预算、secrets、cursor 缓存、notifications 水位 | 能，丢了从 GitHub 重建 |

约定文件：

```text
~/.monastery/repos.json            # 管哪些 repo + per-repo policy/预算/免审批项
~/.monastery/account-cursor.json   # 账号级 notifications 水位（可丢）
~/.monastery/<owner>-<repo>/cursor.json  # per-repo 三元组游标（可丢）
# secrets 走 env / Keychain
# 每个目标 repo 内：.monastery/thesis.md
```

---

## 13. 测试策略

- **shell（确定性，全可测）**：github-adapter / store / orchestrator / 三层 step / Signal 收发 → 单测 + 集成。GitHub 用 **record/replay 假数据**（录一遍 gh / API 输出回放），完全确定性。
- **三层 step 各自可测**：给定 GitHub 状态 fixture，调任意一层 step，断言 Outcome + 产生的动作（无时间、无隐藏状态）。
- **judges（契约测试）**：固定 input fixtures → 断言 output 过 schema；thesis-gate 另配一小组 golden 判例（in/out/unclear 各几个真实 case）防判定漂移。
- **coordination 端到端**：两个 sandbox repo，dry-run 跑完整 request→reply→wake 一圈，断言 thread 上的 Signal 与状态转移。

---

## 14. 技术栈

- **judges**：统一的 **agent 层 Provider 抽象**（仿 petri 的 `AgentProvider.createAgent(cfg).run()`）——抽象的是"怎么跑一个 agent"，不是"怎么发一个 LLM 请求"。默认 `claude_code` provider：在 artifactDir spawn `claude -p --model <m> --output-format json`，agent 用文件输出 artifacts；shell 读回 + zod 校验。**v0 provider 只做 claude_code（默认）+ codex（备选），其余先不考虑**；复用本地鉴权、留在 Mac。**不引入 Anthropic SDK / Managed Agents。**
- **shell**：TypeScript + Node（与 petri 同栈，可共享 provider 形状）；`execa` 调 gh CLI；`zod` 校验 judge artifacts；ApprovalPort 先只实现 GitHubChannel。**github-adapter 很薄**——十来条 gh 命令（发现读 + ~4 个门控写），不建厚 Octokit 层。
- **进程**：单常驻 Node 进程，无外部数据库（本地仅 json 文件）。无内部调度心跳——step 由外部触发。运行时默认 Node（Bun 可选，更快启动但非必需）。

---

## 15. 构建顺序（里程碑）

每个里程碑可独立验证。**里程碑 1 = 首个可跑版本，刻意切到最薄**，只为端到端验证那套新颖机器（reconciler + 三层 step + 状态在 GitHub + level-triggered + GitHub 控制面 + 空闲退避），judge 蠢到不成为变量。**里程碑 1 的那个单 repo 就是 monastery 自己**（见 §1.4 自托管）——第一天起就 dogfood，自托管程度随后续里程碑收紧。**M1 同时建好 CI**（GitHub Actions + vitest），为 M3 的 patch/test 回路备好真实信号。

**里程碑 1 · 单 repo · 仅 thesis-gate · 全闭环**
- shell 地基：store（配置 + cursor）、github-adapter（读/写 + record/replay 测试）、Outcome/step 骨架。
- L0 调度（确定性，仅 `approved→` 执行 与 `new→` triage 两类）+ L1 宏状态机 + GitHubChannel 审批。
- thesis-gate judge：virtual new（无 state 的 open issue）→ 打 `thesis:in/out/unclear`；`out → panel 挂关闭+理由草稿 → state:needs-approval → approved → 关 issue + 发布理由 → state:done`；`in/unclear → 打 thesis 标 + **state:triaged**，停手 parked（**不落 done**；state 必须落以防重复 triage）`。`state:triaged` 正是 M2 triager 的入口。`done` 在 M1 仅用于被关闭的 issue（out 路径）。
- 仅保留一行 `MAX_ITEMS_PER_TICK` 防接入爆发。
- **不含**：triager、patcher、coordination/Signal、完整预算系统。

**里程碑 2 · triager**：叠加 type 分类 + 给提报人的回复草稿（补全"triage 新 issue"的另一半）。

**里程碑 3 · patch protocol**：L2 patch + patcher agent + draft PR + CI 观察（显式点名 `monastery:try-fix` 触发）。

**里程碑 4 · Signal + coordination**：notifications feed 消费、Signal 收发、L2 coordination、跨 repo 端到端。

**里程碑 5 · 完整预算系统**：per-repo 配额 + token 账，随 patcher/coordination 的高成本回归。

---

## 16. 人类角色与干预

**核心原则：人是共享内存（GitHub）上的另一个线程。** 所有干预 = 直接改 GitHub 状态，monastery 下个 step 观察到即据此对账。没有独立控制台，人和 monastery 在同一块共享内存上操作——monastery 永远以**当前 GitHub 真相**为准、**绝不回怼人的覆盖**、**绝不改人 author 的内容**。这是真相源 / level-triggered / 铁律三条原则的自然结论。

人的角色 = 该 repo 的 maintainer/owner：定方向（写 thesis）、审批对外动作、随时覆盖纠正、点名派活、暂停接管。**thesis 归人所有**——AI 只执行不拥有。

干预点（里程碑 1 子集加粗）：

| 干预 | 怎么做 |
|---|---|
| **批准** | 移 `monastery:needs-approval` / 加 `monastery:approved`；或 draft PR 标 ready / merge |
| **拒绝** | 加 `monastery:declined`（留痕，防 monastery 重复提议） |
| **纠正** | 直接编辑 monastery 的草稿评论 / draft PR，再批准 → monastery 用你改后的当前内容执行 |
| **覆盖** | 改任意 monastery 标 / 重分类 `thesis:in→out` / 编辑 sticky；monastery 重读适配 |
| 派活 | 加 `monastery:try-fix`（里程碑 3） |
| **暂停** | per-item `monastery:hold`（视为不可推进，跳过）；per-repo 配置；global 停触发 |
| 接管 | 自己在 GitHub 干完，monastery 看到 done 即收手 |
| **改方向** | 编辑 `.monastery/thesis.md`（影响后续门禁判定） |
| 审计 | sticky 评论 + label + Signal 评论 = 完整可见痕迹 |

**冲突语义**：单核 + level-triggered → 人改的赢；`monastery:declined` / `monastery:hold` / 人手动关闭被视为**终止态**，monastery 不再触发。**monastery 永不做对外/不可逆动作而无显式人类批准标。**

里程碑 1 的人类干预面：批准/拒绝 `thesis:out` 关闭提议、编辑关闭理由草稿、覆盖 thesis 判定标、`hold`、编辑 `.monastery/thesis.md`。

---

## 17. CLI 设计

CLI = 确定性 shell 的**薄入口，不含逻辑**。它同时是：外部触发器（cron / OpenClaw bot）驱动 `step` 的入口，与人本地巡检/配置的入口。`--json` 让 bot 可消费；**canonical 审批仍在 GitHub**，CLI 的 approve/decline 只是语法糖。

```text
monastery step [--repo o/n] [--dry-run] [--only #N] [--json]
    跑一次 reconcile（一个调度 tick）。无 --repo = 所有 managed repo 各跑一次（仍单核串行）。
    --json   输出 ReconcileResult（含 nextPollHint）→ cron/bot 据此安排下次调用（自适应退避）。
    --dry-run 打印 intended actions 不写 GitHub（调试/预览）。
    --only #N 单步调试，只推进某个 item。

monastery status [--repo o/n] [--json]
    只读巡检：各 item 当前状态 / 在等什么 / 待审清单。不推进。

monastery repos <add|remove|list> [o/n]
    管理本地 repos.json（managed repo 列表 + per-repo policy）。

monastery init o/n
    引导目标 repo：建 .monastery/thesis.md 脚手架 + 建好 label 集
    （monastery/state:*、thesis:*、type:*、monastery:approved|declined|hold|needs-approval|try-fix|needs-human）。

# 可选语法糖（canonical 路径仍是在 GitHub 上操作）
monastery approve o/n#123     # = 打 monastery:approved
monastery decline o/n#123     # = 打 monastery:declined
monastery try-fix o/n#123     # = 打 monastery:try-fix（里程碑 3）
```

**触发模型**：cron/bot 稳态下反复 `monastery step --json` → 读 `nextPollHint` → 安排下次（自适应退避）。人本地用 `monastery status` 巡检、`monastery step --dry-run` 预览。这与"monastery 无心跳、被外部驱动"完全一致——CLI 就是那个被驱动的入口。

**dry-run vs apply**：`step` 默认 apply——对外动作已被审批标保护，自动写的只有低风险的 label + 草稿；`--dry-run` 仅用于预览/调试。

**里程碑 1 CLI 子集**：`step`（含 `--dry-run` / `--only` / `--json`）、`status`、`repos`、`init`。`approve`/`decline` 为可选糖；`try-fix` 属里程碑 3。

---

## 18. 已定决策记录

| # | 决策 | 选择 |
|---|---|---|
| 1 | 闭环自动度 | 协调 + 建议修复，人工审批后合并 |
| 2 | 运行形态 | Mac mini + OpenClaw bot + GitHub；monastery 无调度心跳，被外部 step 驱动 |
| 3 | 真相源 | GitHub 唯一；本地仅配置 + 可丢 cursor |
| 4 | 逻辑打包 | Hybrid：确定性外壳 + LLM 判断核 |
| 5 | 触发模型 | level-triggered；`step()` 被调用即对账推进 |
| 6 | 执行模型 | 单核多线程 / 协作式 quantum / GitHub 共享内存 |
| 7 | reconciler 粒度 | per-repo 独立，无全局扫描（choreography） |
| 8 | 通信 | Signal 原语：`@mention` + marker，永远走 GitHub，绝不进程内直调 |
| 9 | patch 触发 | 显式点名（`monastery:try-fix` / 指令）才触发 |
| 10 | L0 策略 | 确定性优先级，LLM 控制器留接口 |
| 11 | 身份（v0） | 单一 `@monastery-bot` 账号；多 owner per-repo 身份属以后 |
| 12 | 复合态进度 | `<!--monastery-state-->` 显式存于 monastery **sticky 评论**（非人写的 body）；承重结构 |
| 13 | coordination 范围 | 核心原语，属 v0 完整设计；落地在里程碑 4 |
| 14 | channel | 控制面 = GitHub 本身；Telegram 等是以后的可插拔 ApprovalPort |
| 15 | 里程碑 1 范围 | 单 repo + 仅 thesis-gate 全闭环；不含 triager/patcher/coordination/完整预算 |
| 16 | triage 拆分 | 保留 thesis-gate（门禁，里程碑 1）；triager（分类+回复）延后到里程碑 2。M1 让通过的 issue 停在 `state:triaged`（非 done），作为 M2 triager 的入口 |
| 17 | 预算控制 | 完整预算系统延后到里程碑 5；里程碑 1 仅留一行 `MAX_ITEMS_PER_TICK` 保险丝 |
| 18 | Signal 发现 | 靠 search/scan（`is:open "<!--monastery"` + `marker.to` 过滤）；notifications 仅加速，单账号下 @ 自己很可能不触发 |
| 19 | 审批承载 | 提议写 monastery panel（auto，内容限状态 + 标注待审）；以 repo 名义对外正式动作才 gated |
| 20 | issue bootstrap | 无 `monastery/state:*` 的 open issue = virtual new；每次处理后必赋恰好一个 state（防重复 triage） |
| 21 | waiting 探测 | waiting item 不跑重活，但 L0 每 tick 跑廉价 watch predicate 探唤醒（无持久 blocked queue） |
| 22 | 术语 | "设计范围(M1–M5)" 与 "MVP/里程碑 1 实现范围(仅 thesis-gate)" 严格分开，避免验收歧义 |
| 23 | agent 抽象 | 统一 **agent 层 Provider 抽象**（仿 petri）：默认 `claude_code` + 备选 `codex`，其余先不考虑；judge 靠**写文件**输出，shell 读回 zod 校验。不用 Anthropic SDK / Managed Agents；复用本地鉴权、留在 Mac |
| 24 | 职责边界 | agent 只改 worktree / 产出 patch，**完全不碰 GitHub**（无 gh 凭证）；**所有 GitHub 写都在 shell**（含可逆的 branch/commit/push/开 draft PR）。可逆/不可逆只用于分**审批门**（draft=提案 / merge=门控），执行者永远是 shell |
| 25 | 语言 | TypeScript + Node（与 petri 同栈）；execa + zod；运行时默认 Node，Bun 可选 |
| 26 | 自托管 | monastery 是 managed-repo #0，dogfood 从 day1；自托管程度随里程碑收紧（M1 gate/triage 自己 issue → M3 开/测自己 PR）；M1 即建 CI；绝不 auto-merge 自己代码 |

---

## 19. 待办 / 后续版本

- L0 智能调度（LLM 控制器）。
- per-repo 身份与多 owner 信任域。
- Telegram / 其它 channel 适配器（加速器，非必需）。
- Thesis / Roadmap / Epic / Story 等上层链路（v0 只到 Issue 执行层 + thesis 门禁）。
