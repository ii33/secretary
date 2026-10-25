# 「执行秘书—总经理—部门」多代理架构：头脑风暴稿

> 目标：在 DSH 0.2.1-rc.2 上复刻并优化 dots 式架构。
> 本文只做设计，不实施。
> 依据：dots 对话记录 1924 条（2026-10-15～10-21，用户 602 / 助手 1322）；DSH 本机 profile、会话日志与包文档实测。
> **第二轮修订**：记忆优先、秘书工具、档案室、报表/文档与精简风格的冲突，见 [secretary-memory-design.md](D:/a/dsh/team/secretary-memory-design.md)。
> **第三轮修订**：核心服务独立于 DSH，DSH 只做薄适配器，见 [decoupled-architecture.md](D:/a/dsh/team/decoupled-architecture.md)。

---

## 0. 核心判断

三句话：

1. **执行秘书的精简不是文风，是上下文压缩算法。** 秘书每多说一句细节，它的上下文就多背一份下层复杂度；精简的本质是把细节挡在下面。
2. **层级不是组织图，是上下文防火墙。** 每跨一层只允许一份受约束的摘要上行；完整对话、工具输出、失败堆栈留在下层会话和数据库里。
3. **DSH 已经提供了约 80% 的运行时，真正要建的是控制面。** 执行秘书就是一个普通会话；总经理/部门经理/工人是原生 subagent 树；当前 profile 的 `maxDepth: 3` 正好是三层；子代理完成时父级只收到最终回答；原生 subagent UI 已能浏览并续聊任意层级子代理；SQLite FTS5 会话索引已随安装提供（默认关闭，开一个持久路径即可）。缺的是：项目/角色注册表、报告契约、记忆与顾问旁路、总控制台。

---

## 1. dots 风格的可量化规格

从导出记录统计（已去掉空消息）：

| 指标 | 数值 |
|---|---|
| 助手消息中位长度 | 101 字 |
| ≤120 字 / ≤250 字 | 60% / 91% |
| 中位句数 | 3 句 |
| 含数字 | 52% |
| 含 `https://` 链接 | 5% |
| 提问（？） | 7% |
| 使用列表 `-` | 8% |
| 使用 `#` 标题 / `**` 加粗 / 代码块 / 表情 / 感叹号 | 0% |
| 第一人称「我」开头 | 9% |

典型结构：**状态/结论 → 证据（数字、提交号、文件、链接）→ 下一步或阻塞**。例：

> 已按你的步骤复现：生成的 16 层数据里，材料、数据集和厚度都正确，旧空层也已被替换。问题在列表复用控件时没刷新材料选择框，所以恰好留下三个“请选择材料”。正在修正这一处刷新，并验证滚动、再次生成和撤销。

### 1.1 写成系统提示词的硬规则

- 1–3 句；常规 ≤120 字，硬上限 250 字（用户明确要求展开时除外）。
- 先结论后证据；能写数字就不写形容词。
- 不承诺未验证的结果；阻塞直接写「尚未 / 不能 / 还需」。
- 需要用户决定时，最多问一个问题，并给默认建议。
- 不用标题、加粗、代码块、表情、感叹号；三项以上才用列表。
- 不写「好的 / 明白 / 希望对你有帮助 / 我理解你的意思」。
- 报告必须包含：状态、证据、下一步三者中的至少两项。

### 1.2 dots 的「连续播报」在 DSH 里怎么处理

dots 平均每条用户消息对应 2.2 条助手消息，因为它在异步任务中持续播报。DSH 的一轮对话通常只有一条最终回复。不要为了模仿而硬造多条消息；用**控制台实时状态**替代聊天刷屏，聊天只报里程碑。若确实需要多次播报，再考虑「子代理完成通知唤醒秘书的新一轮」这种异步模式（见 4.8）。

---

## 2. 角色与通道

| 角色 | 面向用户 | 位置 | 主要职责 | 上下文规模 | 模型档位 |
|---|---|---|---|---|---|
| 执行秘书 ES | 是 | 根会话（root session） | 接需求、转 brief、收报告、向用户汇报；不碰执行细节 | 小，接近用户 | 快而稳（低推理） |
| 顾问秘书 Advisor | 是 | 根会话，可多个 | 重度思考、读完整对话、与用户深聊、产出建议备忘录 | 大 | 最强推理 |
| 总经理 GM | 否 | ES 的子代理（depth 1） | 拆方向、建部门、派任务、集成、验收、向 ES 报摘要 | 大 | 强 |
| 部门经理 DM | 否 | GM 的子代理（depth 2） | 领域内拆包、派工、初审、汇总证据 | 中 | 中 |
| 工人 Worker | 否 | DM 的子代理（depth 3） | 具体执行：写代码、跑测试、查资料、写文档 | 任务级 | 按任务，可便宜 |

```
用户 ⇄ 执行秘书(ES) ⇄ 顾问(Advisor，可多个)
             │  brief 下行
             │  摘要上行
          总经理(GM)  ⇄  项目记忆库
        ┌────┼────┐
      部门A 部门B 部门C
        │
      工人/子代理（最深到 depth 3，不能再递归）
```

三条通道，互相不能混：

1. **执行通道**：brief 下行，受约束摘要上行。每层都有长度上限与证据要求。
2. **记忆通道**：所有文本消息落库；细节按需查，不自动注入任何人的上下文。
3. **顾问通道**：只读完整对话 + 建议备忘录；只有一行通知进入 ES，不把顾问长文塞进 ES。

---

## 3. DSH 现有能力映射

| 需求 | DSH 现有能力 | 缺口 | 建议 |
|---|---|---|---|
| ES 输出像 dots | 预设 persona + 工具约束 | 没有原生长度校验 | 风格契约 + `submit_report` 校验 + 评测集 |
| ES 与 GM 互相精简 | subagent 完成通知只带最终回答 | 最终回答可能超长 | 报告 schema + 硬上限 + 超长打回 |
| 复杂上下文隔离在 GM 之下 | 原生 subagent 树；父级看不到子级中间步骤 | 无 | 直接用，别自己实现隔离 |
| 总经理持久、跨任务保留上下文 | `send_message` 可唤醒/恢复非活跃子级 | 需要稳定记住 GM 的 session id | 项目表存 id；自建 `delegate` 工具封装 |
| GM/DM 按职能选预设 | `agentPreset` 默认值 + `allowedAgentPresets` 白名单 + `agent_preset` 字段 | 模型选得不一定对 | 每个子角色一个 `delegate_*` 工具，或自建 `delegate(role)` |
| 每个角色指定模型 | `agentOptions` 固定子级 provider/model；`modelSelectionSettings` 暴露可选模型 | 角色级默认值分散在预设里 | 项目配置集中存，spawn 时传入 |
| 三层委派 | 当前 profile `maxDepth: 3` | 到 3 就不能再往下 | 正好 ES(0)→GM(1)→DM(2)→Worker(3) |
| 查看并对话任意子代理 | 原生 subagent UI：页头目录、任意深度打开、续聊、Stop、状态/token/耗时 | 控制台需要一个总览 | 控制台只做导航，聊天复用原生 UI |
| 永久记忆数据库 | 会话日志（append-only JSONL.zstd）+ `dsh-session-query-sqlite`（SQLite FTS5 派生索引，默认 `openAt: never`） | 默认关闭；结构化项目数据（角色/任务/报告/决策）没有 | 日志为源；在 profile 补丁里启用 FTS 并给持久路径；另建小项目库 |
| 总控制台 | 客户端插件可注册 `main` 页面、`sidebar.panellist` 图标、`settings.section` | 需要自己写页面与宿主远程服务 | 做插件，不 fork 壳 |
| 顾问完整访问对话 | `sessionQuery` + `dsh-tool-session-query`（同 cwd 授权） | 需要顾问专用只读入口 + 建议通道 | 顾问预设挂只读会话工具 + `submit_advice` |
| 角色预设/模型/状态可见 | 会话头 `agentPreset`、`model/selection` 事件、live agents、会话投影 | 需要一个读模型 | 控制台宿主服务聚合 |

结论：**不要重写运行时，也不要把 ES 做成特殊 agent。** ES 是一个普通会话，靠预设把工具裁到最少；层级用原生 subagent；控制台用插件；记忆用现成 SQLite FTS + 一个小项目库。

---

## 4. 关键机制

### 4.1 摘要向上、细节向下：报告契约

每个下层角色完成工作时，调用 `submit_report`（或由插件在轮次结束时强制收集），写两份东西：

- **摘要**：进入上层上下文，严格限长。
- **详情**：写入项目库，带 id；上层默认看不见，需要时用 `get_report(id)` 取。

```json
{
  "task_id": "T-102",
  "status": "done | partial | blocked | failed",
  "summary": "≤200 字，给秘书/用户看的结论",
  "evidence": ["554 tests passed", "commit 438da39", "file: src/x.ts:42"],
  "risks": ["仅在 Windows 验证"],
  "next": "无 / 待验收 / 需用户决定",
  "needs_decision": {
    "question": "是否允许推送？",
    "options": ["允许", "先不推送"],
    "recommended": "允许"
  },
  "detail_ref": "report://T-102"
}
```

限长建议：

| 边 | 摘要上限 | 说明 |
|---|---|---|
| Worker → DM | 300 字 | 只写结果、证据、阻塞 |
| DM → GM | 500 字 | 可带 1–2 条风险 |
| GM → ES | 200 字 | 只写用户需要知道的 |
| ES → 用户 | 250 字 | dots 风格 |

机制要点：

- 超长不是截断，而是**打回重写**：`submit_report` 返回错误，要求压缩；连续两次超长则记录违规并按硬截断处理。
- 没有 evidence 的报告标记为低置信，GM 必须复核。
- 详情默认不进上下文；上层需要时按 id 读取，读多少由工具限长。
- 所有报告落库，控制台可看完整详情；用户看到的只有摘要。

### 4.2 执行秘书的上下文

ES 的预设只挂四类工具：

- `delegate(role, brief)`：只通向 GM（和可选的快速工人）。
- `status(project)`：从项目库读一行状态，直接回答用户「现在怎么样」。
- `recall(query)`：从记忆库取 ≤3 条、≤200 字的摘要；不取全文。
- `ask_user`：只在需要用户拍板时用。

ES 的上下文里应该只有：

- 用户消息；
- ES 自己的回复；
- 下行 brief（短）；
- GM 上行摘要（≤200 字）；
- 项目 digest（每个用户轮开始时注入的几行状态）。

不应该有：worker 的工具输出、测试日志、代码 diff、失败堆栈、GM 的内部推理。

**上下文预算**：ES 会话保持小窗口（例如 32k–64k token），压缩阈值调低；压缩时保留「用户目标、已确认决策、未决问题、最近 N 轮原文」，其余折叠成 digest。这样即使聊很久，ES 仍像「和用户同步看过同一份简报的人」，而不是「读过所有代码的人」。

**思考内容**：ES 优先用低推理/非推理档；如果所用模型会在历史里回放 reasoning，需要验证并按需在压缩或自定义循环里剥离。记忆库永远不写 reasoning。

**快路径**：状态、回忆、简单确认由 ES 直接答；只有需要动手的事才下派。不要让每件小事都绕 GM 一圈。

### 4.3 总经理：持久、单例、可恢复

- 每个项目一个 GM；GM 是 ES 的本地可继续子代理，session id 存在项目表里。
- ES 每次 `delegate` 时：若 GM 不活跃，用 `send_message`/恢复生命周期唤醒；若活跃，消息进入它的 FIFO inbox。
- GM 的工具：`delegate(role, brief)`、`report`、`task`、`review`、`recall`、可选的 `worktree`。
- GM 收到 brief 后：拆方向 → 建/复用部门 → 并行派发 → 等完成 → 集成 → 验收 → 报摘要。
- GM 的上下文可以大，但也要压缩；细节推给项目库与部门报告。
- GM 不直接和用户说话；需要用户决定时，在报告里带 `needs_decision`，由 ES 转述。

**为什么不让 GM 直接当根会话？** 根会话会出现在侧边栏、被用户直接打开；GM 需要长期持有复杂上下文，不适合当用户入口。让它做 ES 的子代理，既能持久，又不污染用户侧。

### 4.4 顾问秘书：旁路，不进执行链

- 每个项目/方向可以有多个顾问，都是根会话；用户可以从侧边栏或控制台直接打开深聊。
- 顾问预设：强推理模型、高 effort；工具为只读：会话检索/读取、记忆搜索、web；不挂 fs/shell，不挂委派。
- 顾问能完整读 ES↔用户对话：用 `sessionQuery`/`dsh-tool-session-query`（同 workspace 授权），或插件提供的 `read_transcript(project, agent, range)`；只读文本，不含 reasoning。
- 顾问产出 `submit_advice(subject, recommendation, evidence, options)`，写入项目库；ES 在下一轮开始收到一行「顾问有新建议：…」，而不是整篇。
- 顾问不执行、不派活；它的结论是建议，采纳与否由用户/ES 决定。
- 多顾问按方向隔离：各自有 scope，控制台分组显示；避免互相污染。

**为什么不让顾问当 subagent？** 顾问要能独立和用户深聊、要长期存在、要按方向多个；根会话最自然。subagent 适合执行，不适合对等讨论。

### 4.5 永久记忆：三层，不要只有一层

1. **源**：DSH 会话日志，append-only，重启不丢，压缩也不删旧事件。这是真正的「永不丢失」。
2. **索引**：`dsh-session-query-sqlite` 的 SQLite FTS5 派生库。可跨会话、单会话搜索，按 workspace 授权；坏了可以从日志重建。它默认是关闭的（`path: ':memory:'`、`openAt: never`），在 profile 补丁里改成持久路径才算启用：

```yaml
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: !!js dshHomePath('session-search.db')
    openAt: startup        # 或 first-search
```

3. **项目库**：一个小 SQLite，存角色、任务、报告、决策、建议、配置版本。它不存全文对话，只存结构化事实与指针。

对话文本只存一次（日志），索引和项目库都是派生/引用。备份策略：日志目录 + 项目库 + FTS 库定期快照；定期做一次「从日志重建索引」演练。`dsh-tool-session-query`（模型可用的 `session_search` / `session_event_read` 等）也是 opt-in，需要显式加进顾问（以及需要检索的）预设。

建议 schema（项目库）：

```sql
projects(id, name, workspace, config_json, created_at)
agents(session_id PRIMARY KEY, project_id, role, parent_session_id,
       preset, model_provider, model_name, reasoning_effort,
       status, created_at, last_active_at)
tasks(id, project_id, parent_id, title, assignee_role, assignee_session,
      status, write_scope, created_at, updated_at)
reports(id, project_id, task_id, from_session, to_session, status,
        summary, evidence_json, risks_json, detail_ref, created_at)
decisions(id, project_id, topic, recommendation, evidence_json,
          status, advisor_session, created_at)
advice(id, project_id, advisor_session, summary, detail, delivered_at)
artifacts(id, project_id, path, kind, sha256, created_by, created_at)
role_config(project_id, role, preset, provider, model, effort,
            limits_json, revision, updated_at)
```

写入路径：

- 对话消息：由插件订阅会话事件（或 `sessionQuery` 增量读取）写入；按 `(session_id, seq)` 幂等；只写 user/assistant 文本与必要的工具摘要，**过滤 reasoning**。
- 报告/决策/建议：由工具直接写项目库，事务提交。
- 角色配置：控制台写，带 revision；新任务生效；不追溯改历史。

### 4.6 总控制台

一个客户端插件页面，不做第二个聊天应用。布局建议：

```
项目：coating-sim        [运行中]  今日 1.2M tokens  [暂停全部]
方向：coating / narrative / ...
┌ 角色树 ───────────────────────────────────────────┐
│ ● 执行秘书  secretary  deepseek-flash   [打开对话] │
│   ● 总经理  gm  deepseek-v4.1-flash     [查看][停止]│
│     ● 架构部 dm-arch  ...                [查看]    │
│       ○ worker-coding  idle 2m           [查看]    │
│ 顾问：advisor-physics  [对话] [新建议 2]           │
├ 任务看板 / 记忆搜索 / 最近报告 ────────────────────┤
└───────────────────────────────────────────────────┘
```

页面能力：

- **总览**：项目、方向、运行状态、token/费用、异常。
- **角色树**：任意深度的 live + 历史 agent；状态、preset、model、effort、token、耗时、最后活动；点击打开对话。
- **角色配置**：每个角色选预设、模型、推理档、限长、预算；保存为项目配置。
- **对话**：ES/顾问走根会话；GM/DM/worker 走原生 subagent 会话地址（`dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>`），聊天窗、续聊、Stop 全部复用现有实现。
- **任务/报告**：看板、详情、证据链接。
- **记忆**：跨会话 FTS 搜索、按角色/时间过滤、打开原始消息。
- **操作**：发消息、中断、重启、归档、暂停项目。

数据来源（宿主插件聚合）：

- `agents` / `subagents`：live 状态、子级目录、中断、发消息；
- `sessionQuery`：历史、事件、标题、搜索、谱系；
- `agentPresets`：预设列表/声明/选择；
- `session` 投影：model、token、turn 状态；
- 项目库：角色配置、任务、报告、建议。

关键取舍：**控制台负责「看」和「配置」，聊天复用原生 UI。** 这样工作量从「重写一个 IM」降到「一个带远程服务的 React 页面」。

### 4.7 角色 = 预设 + 模型 + 权限 + 预算

用户说的「预设和模型」，建议扩展成五元组：

| 字段 | 例子 | 作用 |
|---|---|---|
| preset | `secretary` / `gm` / `dm-arch` / `worker-code` / `advisor` | 决定 persona、工具、报告格式 |
| model | provider + model + reasoning effort | 决定能力/成本/速度 |
| permissions | 可读/可写目录、可用工具、审批策略、网络 | 决定能做什么 |
| limits | 单次报告字数、最大轮次、超时、token 预算 | 防止失控 |
| report_contract | 向谁报、报什么、多长 | 决定上下文形状 |

项目配置示例：

```json
{
  "project": "coating-sim",
  "workspace": "D:/work/coating-sim",
  "roles": {
    "secretary": { "preset": "secretary", "model": {"provider":"deepseek-account","model":"deepseek-flash","reasoningEffort":"low"} },
    "general_manager": { "preset": "gm", "model": {"provider":"opencode-go","model":"deepseek-v4.1-flash","reasoningEffort":"high"} },
    "departments": {
      "architecture": { "preset": "dm-arch", "model": {"provider":"opencode-go","model":"deepseek-v4.1-flash"} },
      "verification": { "preset": "dm-verify", "model": {"provider":"opencode-go","model":"deepseek-v4.1-flash"} }
    },
    "workers": {
      "coding": { "preset": "worker-code", "model": {"provider":"opencode-go","model":"deepseek-v4.1-flash"} },
      "research": { "preset": "worker-research", "model": {"provider":"deepseek-account","model":"deepseek-flash"} }
    },
    "advisors": [
      { "id": "physics", "preset": "advisor", "model": {"provider":"...","model":"...","reasoningEffort":"max"} }
    ]
  }
}
```

落地方式：

- **P0（无代码）**：每个角色一个预设；ES 预设里挂一个 `subagent` 工具，`agentPreset: gm`、`agentOptions` 指定模型；GM 预设里按部门挂多个 `subagent` 工具实例（不同 `toolName` + `agentPreset` + `agentOptions`）；DM 同理。
- **P3（插件）**：一个 `delegate(role)` 工具读项目配置，spawn 时传 preset/model，避免每个角色一个 tool schema，也避免模型选错。

### 4.8 状态与进度

- **实时状态**：live agents 的 running/inactive；turn 状态；inbox 队列；子代理目录；token/耗时。
- **历史状态**：`sessionQuery` 读旧会话；报告状态。
- **异常**：turn error、超时、连续失败、无心跳。
- **进度**：用控制台状态 + 里程碑报告；不要逼 DSH 每一秒往聊天里发一条。
- **异步模式（可选，后做）**：`send_message` 唤醒非活跃目标；GM 完成时可让 ES 进入新一轮补一条「已完成」。这能接近 dots 的连续播报，但会增加会话轮次和成本，建议 P4 再试。

### 4.9 失败、升级、验证

- 每层报告必须带 status；失败也要有报告，不能静默。
- 重试策略：Worker 失败 → DM 换方案/换人，最多 2 次；DM 失败 → GM 重规划；GM 阻塞 → ES 给用户 2–3 个选项。
- 超时：每个 task 有 wall-clock 与 token 预算；到点由上层 `interrupt_agent`。
- 验证：GM 不能只信 DM 摘要；至少一条独立证据（测试、构建、复现、外部来源）。关键任务加一个独立 verification 部门。
- 用户决定：只有 ES/顾问对用户说话；GM/DM 的 `needs_decision` 必须上浮。

### 4.10 并发与文件冲突

- 同一 workspace 下多个 worker 可能改同一文件。优先级：
  1. 任务写作用域（write_scope）互斥；
  2. 同一文件串行；
  3. 编码类任务用 `worktrees` 服务，各自分支，GM 合并。
- 控制台显示每个任务的写作用域与冲突告警。
- 不要依赖「模型会自觉不冲突」。

---

## 5. 端到端例子

用户：「把 XX 功能做完并验收。」

1. ES：一句确认 + 下 brief 给 GM（目标、约束、验收、相关文件）。
2. GM：拆成架构/实现/验证三个部门；并行派发；等待。
3. DM：各自拆包给 worker；worker 执行；`submit_report` 带证据。
4. GM：收三份摘要，抽查证据，跑集成/验收；给 ES 一份 ≤200 字摘要。
5. ES：给用户 ≤250 字报告；控制台可展开细节。
6. 用户找顾问深聊；顾问写建议备忘录；ES 下一轮看到一行提示，决定是否采纳/转给 GM。

---

## 6. 分阶段路线

| 阶段 | 内容 | 产出 | 风险 |
|---|---|---|---|
| P0 无代码验证 | 建 secretary/gm/dm/worker 预设；原生 subagent；`maxDepth: 3`；跑一个真实小任务 | 验证隔离、层级、预设/模型、原生 UI | 预设 YAML 与工具 schema 成本 |
| P1 控制台只读 | 项目/角色注册表；角色树、状态、preset/model、跳转对话 | 看得见 | 客户端插件 + 远程服务 |
| P2 记忆 | 启用 SQLite FTS；项目库；digest；备份/重建演练 | 查得到、丢不了 | 索引内容与 reasoning 过滤 |
| P3 编排器 | 稳定 GM/DM 会话；`delegate`/`submit_report`；角色配置写入；任务板 | 跑得稳、可配置 | 阻塞等待、恢复、并发 |
| P4 顾问 | 顾问根会话；transcript 只读；建议 inbox | 想得深 | 权限与上下文隔离 |
| P5 强化 | 评测集、预算、worktree、异常恢复、多项目 | 可长期用 | 成本与复杂度 |

建议先做 **P0 + P1**：P0 半天到一天就能验证「这套层级在 DSH 上到底成不成立」；P1 让用户第一次看见整个项目，反馈会决定 P3 的形态。

---

## 7. 需要你拍板的问题

1. **项目边界**：一个 workspace 一个项目，还是允许一个 workspace 多项目/多方向？（我倾向 workspace = 项目，方向是项目内的分组。）
2. **ES 数量**：每个项目一个 ES，还是全局一个 ES 管所有项目？（我倾向每项目一个；全局控制台负责切换。）
3. **GM 数量**：每项目一个 GM，还是每个方向一个 GM？（我倾向先一个；方向多且独立时再拆。）
4. **顾问位置**：顾问是根会话（用户可直接开聊），还是隐藏在 ES 之下？（我倾向根会话。）
5. **风格严格度**：ES 常规 120 字、硬上限 250 字，是否合适？用户要求展开时是否允许突破？
6. **记忆范围**：只存 ES↔用户、ES↔GM，还是所有 agent 的对话都进索引？（我倾向全索引，但只给 ES 摘要级 recall。）
7. **控制台优先级**：先只读看板，还是直接做「改角色配置/发消息/停止」？
8. **模型与预算**：ES/GM/顾问/工人分别想用哪些模型？每天/每任务预算上限是多少？
9. **是否独立 profile**：这套架构建议单独一个 DSH profile，避免和日常 Team/profile 的补丁互相影响；是否接受？
10. **用户直聊子代理**：允许用户直接给 GM/worker 发消息吗？还是默认只读、需要确认？（我倾向允许但标注「用户直连」，避免和 ES 的 brief 冲突。）

---

## 8. 动手前要验证的技术点

1. `maxDepth: 3` 的实际计数：ES(0)→GM(1)→DM(2)→Worker(3) 是否正好，worker 是否确实不能再派。
2. 自定义 `delegate` 工具能否阻塞等待子代理最终回答；若不能，如何用事件/`send_message` 组装。
3. `send_message` 唤醒冷 GM 时，是否保留它的 preset/model/上下文。
4. 历史 reasoning 是否会被回放进后续请求；若会，如何在 ES 侧剥离。
5. `agentPreset` + `agentOptions` 在 spawn 时是否同时生效；model 白名单是否限制固定路由。
6. `dsh-session-query-sqlite` 的索引是否包含 reasoning；如何只索引消息文本。
7. 控制台页面能否稳定打开任意深度子会话地址，并保留续聊能力。
8. Electron 主进程能否直接用 `node:sqlite`；不行则用 bundled Python/侧车。
9. Agent Teams bundle 与预设内 subagent 工具是否冲突；是否要在独立 profile 里只保留 base。
10. 项目库写入与会话事件订阅的幂等/顺序/崩溃恢复。

---

## 9. 不建议做的事

- **不要重写聊天 UI**。原生会话 + subagent UI 已经能看、能聊、能停。
- **不要自己做一套 agent 运行时**。DSH 的 agent loop、压缩、持久化、工具管线已经够用。
- **不要用 Agent Teams 当层级骨架**。它是扁平的 Lead+成员，最多 8 人，成员没有独立的角色预设/模型参数，而且会禁用宿主级 subagent 工具；它适合小团队协作，不适合「总经理—部门」树。
- **不要把记忆数据库当唯一真相**。日志才是源；DB 是索引和结构化事实，必须可重建。
- **不要让 ES 拿 fs/shell/web**。它的价值就是「不知道细节」。
- **不要把所有子代理全文自动注入上层**。那等于没有隔离。
- **不要用截断冒充精简**。超长报告要打回重写，否则关键信息会被切掉。

---

## 10. 一句话建议

先把 P0 跑通：用三个预设 + 原生 subagent 验证「ES 只看见摘要、GM 持有复杂上下文、子代理能被单独查看和续聊」。验证通过后，再建控制台和记忆；最后才写编排器。这样每一步都能用现有 DSH 能力兜底，不会一开始就陷进自建框架。
