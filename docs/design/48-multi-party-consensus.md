# 多方共识协议(north star)

> Epic #48。monastery 从「单仓治理」升级为「多方共识」的目标设计。**只记不实现**,分期落地。
> 守宪:`CONSTITUTION.md`。延续:`PROTOCOL.md`(三档/marker/信号/propose→approve→execute)、`AGENTS.md`、动作词表 `docs/design/34-action-vocabulary.md`、本地结构 `docs/LOCAL-LAYOUT.md`。

## 0. 一句话

**多方就一份共享、可背书的 spec 达成一致(agent 制造共识),各自在自己仓里执行(owner 闸门退化成"乐意盖的章");共识失败时,闸门 / 不采纳是安全地板。**

> 成事靠**共识**,不靠**妥协**。共识是方法(常态),地板是失败时才落下的安全网(稀有)。

## 1. 为什么(单仓协议在多方下的缺口)

`PROTOCOL.md` 假设「一个 repo、一个外壳、owner 把关」。把它对着「A 给 B 提的 issue、两边 agent 讨论、人评判」一跑,暴露:

- **对作者失明**:`listComments` 只取 `{id, body}`,人/bot 全靠 marker 区分(因为 bot 与人共账号)。多方下两个 monastery 的 marker 一样 → B 把 A 的评论当"自己的"过滤掉 → 对话发生不了。
- **活性脆**:正在对话 = `advanced>0` = 退避不触发 = 双方钉在 60s 快轮询;reply 幂等只保证"每条评论回一次",但评论数无上界 → **礼貌的无限快轮询**。退避反向激励收敛。
- **人召不来**:人只在闸门处动作;纯讨论没闸门 → 人没有被触发的入口 → 永不评判。
- **重心错位**:闸门 / exit 只处理「共识失败」(妥协地板),对「共识达成」一字未表达。

> 结论:monastery 的**安全**性质在多方/对抗下出奇地稳(一切不可逆动作人闸兜底,注入只能制造噪声);**活性 / 共识**这一维度,外壳里一行都没有。本设计补的就是它——而且**几乎全是已有积木的重组**。

## 2. 核心概念

| 概念 | 含义 | 怎么 GitHub 可观测 |
|---|---|---|
| **owner** | 能 gate/合/关某 repo 的一方 | 该 repo 的 maintainer 权限(派生) |
| **stakeholder** | 对某 issue 有利益、但只能评论的一方 | issue 的 author / 参与者(派生) |
| **共享 spec** | 双方共编:真实需求 + 验收标准 + 商定做法。**append-only 版本化评论**(每版一条) | `<!--monastery-spec version=N parties=…-->` 评论;当前 spec = 最高版本 |
| **背书** | required party 发一条带 `version` 的 endorse 标记评论 | `listComments`(带 author):endorser = `comment.author`(#51)+ `version=N` |
| **共识** | 当前 `version` 被**所有 required party** 背书 | 背书集合 ⊇ required(全派生/可观测) |
| **required parties** | 必须背书的一方集合 | 默认派生 `issue.author + repo owner`;超出则写进 spec 的 `parties=…`,**改名单本身要重背书** |

要点:**roster 跟着 GitHub 事实走**,默认不记录;超出默认才写进**受背书的 spec**——改名单是一次 spec 编辑,使旧背书失效、要原班人马重背。本地 store 里若有,只是可丢缓存。

## 3. 机制(★=新增,其余复用)

1. **身份 ★(小)**:`listComments` 带 `author`(#51)。§3 从「monastery vs 人」推广成「**我 vs 其他所有人**」:外壳只排除**自己账号**发的内容,别的 agent 与人一样是对手方。marker 退化为「同账号 bot/人」的兜底。
2. **共享 spec = append-only 版本化评论 ★(细化:不用 sticky panel)**:`spec` 动作 append 一条 `<!--monastery-spec version=N parties=…-->\n<body>`;**body 变才 `version++`(幂等)**。当前 spec = 最高版本评论。比原"单条 sticky+原地编辑"更好:**版本天然清晰、背书按版本对得上、不撞现有 note/approval sticky**。
3. **背书 = 带 version 的 endorse 标记评论 ★**:`endorse` 动作 post `<!--monastery-endorse version=N-->`,**endorser = `comment.author`(复用 #51,连 `by=` 都不用写)**;同一 party 同一 version 幂等。**这点纠正了「背书=reaction」:reaction 绑不到 spec 版本**。`reactions`(#39)仍只用于单方 owner 闸门(无版本)。
   **背书是 agent 级、人不另设仪式**:agent 的 endorse 只驱动「讨论→实现」这步**可逆**工作(开 draft PR);**不可逆落地仍是 owner 的人 merge(原闸门不变)**。对抗同伴最多骗 agent 开个被人否掉的草稿 PR(噪声,§10)。
4. **共识判定(纯函数)**:`endorsers(currentVersion) ⊇ requiredParties`。一个无副作用的读取助手即可,无新状态。
5. **收敛即终点、卡死即召人 ★**:spec 达成共识 → 讨论**正终结** → 进入执行;**N 轮 spec 仍不收敛** → 外壳在双方升 `needs-human`(人**恰在共识卡死时**被召来破局)。这一条同时补掉 §1 的三个活性洞——成本由**收敛**封顶,不靠拍脑袋预算。
6. **两道闸门 = 安全地板(复用现有 gate)**:共识后,B 的 agent 在 B 实现 → B 的 PR → **B 的人合**;A 的 agent 集成 → A 的采纳 PR → **A 的人对着同一份 spec 验收**。**无跨仓否决**,主权完整。
7. **stakeholder 限权 ★**:对**非自有 repo**,外壳只放行 `reply` / spec 编辑,**代码层禁** `propose`/`implement`/控制标签——与「agent 碰不到 git/gh」同类的硬约束(§3)。

## 4. Happy path(共识之道)

```
1. A 在 B 提 issue,写真实需求(不是单一解法)
2. A、B 的 agent 共编 spec,收敛到双方都想要的版本           ← 共识引擎(agent)
3. 双方用各自账号 👍 当前 version → 共识成立(GitHub 可观测)
   └ N 轮不收敛 → 双方 needs-human,人来破局
4. B 实现 → B 的 PR → B 的人合(共识在,乐意盖章)
5. A 集成 → A 的采纳 PR → A 的人对着同一份 spec 验收 → 落地
   └ 任何偏离,在对应 owner 的闸门被接住 = 安全不采纳
```

## 5. 失败与地板

- **B wontfix**:B 的 owner 提 `propose(close)`,B 的人 👍 → terminal declined;A 不采纳、自己适配。共识失败 ≠ 出事。
- **共识卡死**:N 轮不收敛 → 双方 `needs-human`。
- **实现偏离 spec**:A 的采纳闸门对着同一份 spec 验收时接住 → **安全不采纳**(§10)。
- **对抗 agent / 提示注入**:peer 评论是不可信输入,但背书必须**本人账号**点、一切不可逆动作**人闸**兜底 → 注入最多让某 agent 提个蠢动作,被人一眼否掉 → **噪声,不是损害**。安全模型对对抗同伴鲁棒。
- **被迫消费未版本化依赖**:不是审批能救,是**解耦**(版本化/契约/SLA)。协议不背这个锅。

## 6. 边界与异常(机制边角)

§5 是主要失败模式;这里扫机制的边角。★=该扫描逼出的设计纠正。

**身份**
- **bot 与人共账号**:自我排除按「我的账号 **∧** 有 marker」——同账号**无 marker** 的是我的人(对手方,要听)。纯按账号会把自己的人吞掉。
- **party = 身份集合**(团队的 bot + 多人账号),非单一 login;按稳定 `user.id`,不按可改名的 login。

**共享 spec(并发 / 篡改)**
- **两壳同 tick 改 spec**:乐观并发——编辑针对读到的 `version`,提交前 version 变了就重读重并(upsert-by-marker + version 检查)。
- **任何编辑作废全部背书**(`version++`)→ 杜绝「背书后偷改验收标准」。
- **spec 是唯一共享 sticky**,与 per-party 的 `by=X` panel 区分;首个动手方建,双方共编。

**背书 / 共识 ★**
- **背书不是裸 reaction,是带 version 的 endorse 评论**——reaction 绑不到 spec 版本(见 §3.3)。
- **背书停在 agent 级,人只在原 merge 闸门**——不新增人类背书仪式(见 §3.3)。这是本扫描的净简化:砍掉一道多余的人类闸门。
- **共识非单调**:已背书方撤回 → 若已开 PR,退化到 owner merge 闸门(人见撤回→不合)。
- **卡死精确定义**:连续 `K` tick 无新 endorse 且 spec 未变 → 双方**各自**升 `needs-human`(无协调器,各侧本地判)。`K` 落 `spec.policy.consensusMaxRounds`。

**执行两道闸门**
- **谁实现什么写进 spec**:否则 A、B 各改各的 → 冗余 / 冲突;工作归属是共识的一部分。
- **顺序靠可观测**:A 采纳前读 B 的 `prState`(已有);B 没交付则 A 等,最终一致。
- **B 合了但 A 用不了**:A 采纳闸门接住 = 安全不采纳;A 开 follow-up 重启,无自动回灌。

**采纳不对称(落地初期常态)**
- **B 根本不跑 monastery**:无 B-agent,A 的 agent 把 **B 的人当对手方**(无 marker 评论)。**单边也能跑**。

**发现**
- **A 怎么知道对 B#42 有 stake**:P0 只认「A 自己 author 的 / 显式登记的」外部 issue,不做模糊的"被提及"推断。

## 7. 分期(P0 是最小楔子)

| 期 | 范围 | 新增面 | 价值 |
|---|---|---|---|
| **P0** ✅ | **身份 + 跨仓读** | `listComments` 带 `author`(#51);issue body 用 `Depends-on: owner/repo#N` 声明 stake → 读其状态喂 context(#52) | A 的 agent 把「我关心的 B#42 状态」当 context 决定 **A 自己仓**的动作。**零新副作用、零 ping-pong、零新注入面**。 |
| **P1** | **共识核** | spec `panel`(version)+ 带身份的背书 + 共识判定 + 收敛/卡死→召人 | 真正的多方共识。机制=已有积木组合。 |
| **P2** | **stakeholder 限权** | 非自有仓只放行评论/spec 编辑,代码层禁 gate | 让跨仓发言安全。 |

> **先读后写**:跨仓 READ(P0)拿走大部分价值且安全;跨仓 WRITE(P1+)才引入活性/成本/注入,放到配齐收敛机制之后。

## 8. 刻意不做(反过度工程)

- **不**做中心协调器 / 调度服务 / 通用工作流引擎 / 富状态机——多方靠 GitHub 可观测 + 身份 + owner 锚定撑起,无中心。
- **不**在本地存 roster / 共识状态——全 GitHub 派生或可丢缓存(§5)。
- **不**做「预批准 B 的计划」这类被模型吃掉的脚手架(§8);对齐靠**前置的共享验收标准**,不靠互相否决。
- **不**做强制 two-party veto(破坏 owner 主权);co-approval 仅 owner **自愿**把对方 👍 也当必需信号。
- **不**新增外部依赖;`reactions`/`listComments` 只补「读身份」这一点。
- **不**为活性发明新预算/节流原语——收敛即终点、卡死即召人,复用 `needs-human` + 人闸。

## 9. 需要改的接口(小、明确)

- `src/github/gh-adapter.ts`:`listComments` 返回值带 `user`(去作者失明)。
- `src/agents/maintainer.ts`:输入纳入 peer 评论(按身份当对手方)+(P1)spec 状态;persona 增「共编 spec、达成即停、卡死交人」。
- `src/engine/reconcile.ts`:发现集纳入「我有 stake 的外部 issue」(P0 只读);spec 未收敛的卡死检测 → 双方 `needs-human`(P1)。
- 共识判定 / spec version 解析 / endorse 评论解析:纯函数助手(P1),无新状态。
- 复用:`panel`、owner gate(#23/#31)、`reactions`(#39,仍管单方 owner 闸门)、`RepoPolicy`(`consensusMaxRounds` 等落 spec.policy / per-repo)。

## 10. 守宪自检

| 宪法 | 本设计 |
|---|---|
| §1 安全/有用解耦 | 共识(有用)在 agent,随模型涨;闸门/身份/召人(安全)在外壳,恒定 |
| §3 agent 不碰 git/gh;只提议 | agent 改 spec/implement 全是提议;背书与合并是人 |
| §4 不可逆动作人放行 | 合并/关闭仍是 owner 的人;agent 背书只驱动可逆的开 PR,不可逆落地仍是人 merge |
| §5 GitHub 唯一真相 | 身份/spec/背书/roster 全 GitHub 派生或观测,本地仅可丢缓存 |
| §8 不搭脚手架 | "该不该继续谈/该不该实现/谁该背书"塌进 agent 与 GitHub 事实,无 judge/调度 |
| §9 最薄即最耐用 | 新增仅:读身份、spec=panel+version、背书=带 version 的 endorse 评论、卡死→needs-human;余皆复用 |
| §10 失败=噪声 | 共识失败 → 安全不采纳 / 召人;对抗注入 → 被人闸兜成噪声 |

## 关联

宪法 `CONSTITUTION.md` · 协议 `PROTOCOL.md` · 智能体 `AGENTS.md` · 动作词表 `docs/design/34-action-vocabulary.md` · 本地结构 `docs/LOCAL-LAYOUT.md` · Epic #48。
