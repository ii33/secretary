# 秘书的永久记忆与工具：第二轮头脑风暴

> 承接 [dots-office-architecture.md](D:/a/dsh/team/dots-office-architecture.md)。
> 这一轮只讨论你补充的重点：**执行秘书的永久记忆线、记忆工具、档案室，以及“报表/文档”和精简风格的冲突**。
> bigram 中文检索的成本/效果实测见 [bigram-evaluation.md](D:/a/dsh/team/bigram-evaluation.md)。
> **第三轮修订：核心服务改为独立程序（不依赖 DSH），DSH 只做薄适配器；M1 顺序调整为先核心、后适配器。见 [decoupled-architecture.md](D:/a/dsh/team/decoupled-architecture.md)。本文涉及“宿主插件/`~/.dsh` 路径”的段落以该文为准。**
> **第四轮修订：前端走 DSH Desktop 的 `desktop` profile（客户端插件），不自带运行时；核心用 DSH 自带 Python。见该文第 10 节。**
> 仍然只设计，不实施。

---

## 0. 先回答你的六个点

1. **workspace = 项目**：同意。一个 workspace 一个项目，方向是项目内分组。
2. **先一个 ES、一个 GM**：同意，先把单项目跑顺。
3. **顾问做成根会话**：同意，用户可以直接开聊。
4. **秘书 250 字太短**：对，但问题不在“放宽上限”，而在把**对话**和**交付物**分开。见第 1 节。
5. **控制台一步一步来**：同意，先做记忆底座，控制台后置。
6. **profile 是什么**：见下面的小框。

### profile 是什么

DSH 的 profile 就是一套**命名配置**，放在 `~/.dsh/profiles/<名字>/` 里，包含：

- 这次启动加载哪些 bundle（base / web / team / agentkit …）；
- `cordis.patch.yml`（插件与配置覆盖）；
- 已安装的插件、预设、`node_modules`。

启动时选哪套 profile，就用哪套工具、界面、模型和预设。你现在用的是 `desktop`。单独开一个 profile 等于给这套“秘书架构”一个独立房间：不污染日常会话，出问题容易回滚；代价是多一个启动入口、要单独装插件。

**建议**：现在做记忆插件，继续留在 `desktop` 就行，不必先开新 profile；等要装整套 bundle、或发现 Agent Teams 与预设内 subagent 工具打架时，再开一个 `dots` profile。它不是账号，也不是租户，只是配置隔离。

---

## 1. 关键修正：对话 ≠ 交付物

你说得对：秘书要能整理报表、文档，250 字明显不够。但**把长文档塞进聊天，和 dots 的简洁并不矛盾——它们是两个通道**。

| 通道 | 内容 | 长度 | 谁看 |
|---|---|---|---|
| 对话通道 | 状态、结论、确认、提问、阻塞 | 极短（默认 ≤250 字） | 用户，在聊天里 |
| 交付物通道 | 报表、文档、PPT、代码 diff、测试报告 | 可以很长 | 用户在文件/控制台里打开 |
| 记忆通道 | 对话与关键事实的长期索引 | 不直接给人看 | 秘书/档案室检索 |

所以正确做法不是“让秘书说更长”，而是：

- 秘书在聊天里永远短；
- 长文档由**文书角色**生成文件；
- 秘书只回一句：“周报已生成：`reports/week-42.docx`，3 页，核心结论是 X、Y。”

### 1.1 三档长度，而不是一个上限

| 模式 | 触发 | 上限 | 说明 |
|---|---|---|---|
| `status` | 默认：确认、进度、派活、阻塞 | 250 字 | dots 风格，1–3 句 |
| `answer` | 用户明确问“解释一下/为什么/怎么做” | 800 字 | 仍要求信息密度，不许灌水 |
| `artifact` | 用户要报表/文档/方案 | 聊天回复 ≤250 字 + 文件链接 | 正文进文件，不进聊天 |

再加一条：用户说“详细说说”时，秘书可以到 800 字；但**默认不主动展开**。这既保留 dots 的简洁，又不至于连解释都做不了。

### 1.2 新增角色：文书（Scribe）

- 归属：GM 下的“文档部”，或独立的文档部门；不建议直接挂在 ES 下（保持 ES 的工具极简）。
- 职责：把档案室的材料、GM 的结论、部门的数据，整理成 .md / .docx / .pptx / .pdf。
- 工具：文档生成、模板、表格、图片、排版；可以用 `office` 系列技能。
- 输出：artifact（文件 + 摘要 + 来源），不是聊天长文。
- 对上的报告仍然很短：“周报已生成，3 页，含 5 个结论、2 个风险。”

ES 的职责变成：判断“这是聊天问题还是交付物问题”；交付物交给 GM，GM 再交给文书；ES 只负责把文件递到用户面前。

**一句话：秘书可以“整理报表”，但整理出来的东西是文件，不是聊天消息。**

---

## 2. 记忆总设计：harness 管上下文，我们管长期记忆

你补充的方向是对的：**执行秘书自身上下文先交给 harness 管理**，我们不自己搞一套上下文循环。分工如下：

| 层 | 谁负责 | 内容 | 生命周期 |
|---|---|---|---|
| 工作上下文 | DSH harness | 最近对话、工具结果、压缩摘要 | 一轮/一个会话 |
| 永久记忆线 | 我们的记忆库 | ES↔用户、ES↔GM 的全部文本，结构化索引 | 项目级、永久 |
| 语义记忆 | 我们的记忆库 + 档案室 | 决策、偏好、事实、未决问题、artifact 索引 | 项目级、人工/档案室维护 |
| 交付物 | 文件系统 + 项目库 | 报表、文档、代码产物 | 永久，按项目归档 |

harness 的压缩会丢细节，但**原始会话日志不丢**；记忆库从日志重建索引。这样：

- ES 的上下文由 harness 正常压缩，不需要自定义 agent loop；
- 压缩后 ES 想不起细节时，用记忆工具查；
- 记忆库永远比上下文完整，且不占上下文。

### 2.1 执行秘书的会话日志 = 项目记忆主线

这是你这句话的核心，我完全同意。原因是：

- ES 的会话里只有“用户说了什么、秘书回了什么、派了什么活、收到什么摘要”——**天然是项目的高信号日志**；
- GM/部门/工人的细节不进 ES 会话，所以这条线不会被工具输出污染；
- 只要 ES 保持精简，这条线就可读、可检索、可审计；
- 所以“ES 精简”不只是风格，也是**记忆质量的前提**。

建议把记忆线定义为：

**包含**：
- 用户消息；
- ES 回复；
- ES→GM 的 brief（工具调用的参数摘要）；
- GM→ES 的报告/完成通知（工具结果摘要）；
- 压缩摘要（compaction summary）；
- 显式记忆：决策、偏好、事实、未决问题；
- artifact 元数据（标题、路径、摘要、来源 turn）。

**排除**：
- reasoning / 思考内容；
- 记忆工具自己的调用与结果（否则检索会自我循环）；
- 系统提醒、时间上下文、审批通知；
- 原始工具输出、测试日志、代码 diff；
- 大段文件正文（只存路径和摘要）。

### 2.2 一个项目可以有多条 ES 会话

用户可能开新会话、归档旧会话。记忆线按**项目**而不是按单个 session 组织：

- 项目 id 来自 workspace 下的 `.dsh/project.json`；
- 每个 ES 会话都映射到同一个项目；
- 新 ES 会话启动时，注入一页“项目 brief”，并可检索旧会话；
- 控制台以后按项目展示时间线，而不是按会话。

这样即使 ES 会话被压缩、归档、重开，项目记忆不断。

---

## 3. 记忆库

### 3.1 位置与备份

建议：

- 主库：`%USERPROFILE%\.secretary-office\office.db`（独立程序的数据目录，不跟 DSH 家目录绑定；第三轮修订）；
- 项目内导出：`<workspace>/.dsh/memory/`（可选，便于随项目迁移/查看）；
- 原始日志：`~/.dsh/sessions/...`（DSH 自己管，append-only；由适配器采集，不作为核心真相）；
- 备份：每日快照主库 + 日志目录；可选 SFTP 到 NAS；每季度做一次“从日志重建索引”演练。

如果更看重“项目自带记忆”，也可以把主库放 workspace 的 `.dsh/`，再把备份放 DSH 家目录；两种都行，关键是**至少两份、至少一处不在 workspace 里**。

### 3.2 Schema 草案

```sql
PRAGMA journal_mode = WAL;

project(id TEXT PRIMARY KEY, name TEXT, workspace TEXT, created_at INTEGER,
        schema_version INTEGER)

session(id TEXT PRIMARY KEY, project_id TEXT, kind TEXT,
        -- secretary_user / secretary_gm / advisor / other
        started_at INTEGER, ended_at INTEGER, title TEXT)

turn(id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, turn_no INTEGER,
     user_text TEXT, assistant_text TEXT, created_at INTEGER,
     summary TEXT, intent TEXT, outcome TEXT, importance REAL,
     report_ids TEXT, artifact_ids TEXT, tags TEXT,
     state TEXT,              -- hot_raw / processed / cold
     processed_at INTEGER, summary_id TEXT,
     archived_at INTEGER, cold_ref TEXT)

message(id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, turn_id TEXT,
        role TEXT, kind TEXT,
        -- user / assistant / brief / report / compaction
        text TEXT, created_at INTEGER, source_seq INTEGER, token_count INTEGER,
        archived_at INTEGER, cold_ref TEXT)

note(id TEXT PRIMARY KEY, project_id TEXT, kind TEXT,
     -- fact / preference / decision / todo / open_question
     text TEXT, tags TEXT, importance REAL, status TEXT,
     -- active / superseded / archived
     source_session TEXT, source_seq INTEGER, created_at INTEGER,
     superseded_by TEXT)

artifact(id TEXT PRIMARY KEY, project_id TEXT, title TEXT, path TEXT,
         kind TEXT, summary TEXT, source_turn TEXT, created_at INTEGER)

summary(id TEXT PRIMARY KEY, project_id TEXT, scope TEXT,
        -- day / week / milestone
        period_start INTEGER, period_end INTEGER, text TEXT,
        source_from_seq INTEGER, source_to_seq INTEGER, created_at INTEGER,
        model TEXT, prompt_version TEXT, source_turn_ids TEXT)

-- 冷备索引：原文移到 cold/ 后，按 id 查文件/偏移；可选冷库
cold_index(id TEXT PRIMARY KEY, project_id TEXT, kind TEXT,
           file TEXT, offset INTEGER, length INTEGER, sha256 TEXT,
           created_at INTEGER)

-- 中文检索：内容less FTS，body 存 bigram 预处理后的 token 文本
-- rowid = turn.id / note.id，命中后回表取原文
CREATE VIRTUAL TABLE turn_fts USING fts5(body, content='', tokenize='unicode61');
CREATE VIRTUAL TABLE note_fts USING fts5(body, content='', tokenize='unicode61');

CREATE TABLE embedding(
  id TEXT PRIMARY KEY, ref_type TEXT, ref_id TEXT, model TEXT, vector BLOB
); -- 可选，先不建
```

要点：

- `turn` 是记忆的最小单位（用户一句 + 秘书回复 + 关联报告/文件），也是**检索单位**；
- `message` 保留原始行，方便精确回放；FTS 不索引 message，避免重复；
- `note` 是“提炼过的记忆”，可以覆盖/过期；
- `summary` 是压缩摘要和日/周总结；
- artifact 只存元数据，正文在文件里。

### 3.3 中文检索是最大的技术坑

SQLite FTS5 默认的 `unicode61` 对中文不友好：中文没有空格，整句可能被当成一个 token，搜“膜系优化”未必能命中“膜系优化算法”。DSH 自带会话索引用的就是 `unicode61`，所以**不要假设它中文召回够用**。

三个方案，按成本排序：

1. **bigram 预处理**（推荐先做）：入库时把中文文本切成两字组合，例如“膜系优化”→“膜系 系优 优化”，用空格连起来存进 FTS；查询时同样切。这样“优化”“膜系”都能命中。英文按单词切。实现简单、可移植、无依赖。
2. **FTS5 `trigram` tokenizer**：支持子串匹配，中文效果通常不错；但要求 SQLite 3.34+，2 字查询要回退 `LIKE`。
3. **向量检索**：用 embedding API 或本地模型；中文语义召回更好，但要额外模型、成本、存储。建议等 bigram + 规则召回不够时再上。

另外：
- 查询走“多查询 + 合并”：档案室/ES 可以给 2–3 个同义改写（“上次的方案”“之前定的做法”“历史决策”），提高召回。
- 排序：BM25 + 时间衰减 + 重要度 + 类型权重（决策/偏好 > 报告 > 闲聊）+ 精确短语加成。
- 结果去重：同一个 turn 只返回一次。

**实测结论（详见 [bigram-evaluation.md](D:/a/dsh/team/bigram-evaluation.md)）**：

| 方案 | 2 字查询 recall@5 | 自然问句 recall@5 | 20k 条查询 p50 | 存储（1,281 条） |
|---|---|---|---|---|
| raw unicode61 | 3% | 27% | — | 1.38MB |
| **bigram** | **100%** | **78%** | **32ms** | **1.74MB** |
| trigram | 0% | 62% | — | 3.30MB |

- 精确短语 2–8 字：bigram 30/30；原生 0–10%；trigram 2 字 0/30。
- bigram 单条增量写入约 1.5ms（WAL + NORMAL），全量构建约 1.9ms/条。
- 结论：**bigram 是默认方案；trigram 不选；embedding 先不上。**
- embedding 补充实测（bge-small-zh-v1.5）：自然问句 top-1 60%（bigram 53%），但精确短语 recall@5 只有 10/30（bigram 30/30）；hybrid 后 top-1 63%、精确仍 30/30。代价是 90MB 模型、20k 条约 41MB 向量、全量构建约 45 分钟、Node 侧还要 sidecar/ONNX。**M1/M2 不引入；真实评测语义失败率 >10% 再加 hybrid，且不替换 bigram。**

### 3.4 写入管线

```
ES 会话事件（user/assistant/compaction/delegate/report）
        │ 过滤：去掉 reasoning、记忆工具自身、系统噪声
        ▼
   turn 组装器（按 turn/start、turn/end 归并）
        ▼
   memory.db（message / turn / summary）
        ▼
   FTS 索引（bigram）
```

- 实时：订阅会话事件，按 `(session_id, seq)` 幂等写入；
- 写入策略：`journal_mode=WAL`、`synchronous=NORMAL`，按 turn 或每 10–20 条消息一个事务；实测约 1.5ms/条；
- 回填：启动时用 `sessionQuery.listSessions` / `readSession` 扫历史，补齐缺失 seq；
- 崩溃恢复：事务提交 + 幂等键；
- 重建：从日志重放，`turn/message` 可完全重建；`note/decision/artifact` 需要单独备份（它们不在日志里，或只在聊天里出现过）；
- 维护：定期 `INSERT INTO turn_fts(turn_fts) VALUES('optimize')`；FTS 是派生索引，坏了可重建。

### 3.5 隐私与删除

- 本地库文件权限 0600；
- 入库前做敏感信息检测/脱敏（API key、密码、token 不落库）；
- 支持软删除 + 物理清理；删除操作记审计；
- 备份可选加密；
- 不把记忆库发给外部模型，除非用户明确同意；检索结果只带必要片段。

### 3.6 记忆分层：以“是否已梳理”为降级条件

你的定义不是按时间老化，而是按**处理状态**：

- ES 每次对话，程序自动收录；
- **热记忆 = 已梳理的记忆（brief/摘要/笔记）+ 还没梳理的实时收录**；
- 新收录的记忆一旦被梳理，就**自动降级**。

状态机：

```
capture     → hot_raw（processed_at IS NULL，立即可搜）
summarize   → summary/note（梳理后的记忆）+ 标记 processed_at / summary_id
demote      → 原文进 cold；热库留元数据 + cold_ref
```

| 层 | 内容 | 检索 | 生命周期 |
|---|---|---|---|
| 热 | 未梳理的实时收录 + 当前 brief/最新摘要/笔记 | bigram FTS 全量 | 直到被梳理（可配宽限） |
| 温 | 全部已梳理的 summary / decision / preference / todo / open_question / artifact 索引 | FTS + 结构化过滤 | 永久 |
| 冷 | 已梳理 turn 的完整原文（压缩） | 按 id 精确取；可选 `scope=all` 慢搜 | 永久，可导出 |

**流程**（默认手动；可选长周期/大规模阈值，不依赖 DSH）：

1. **实时收录**：每个 turn 落 `hot_raw`，马上可搜；不等待 LLM。
2. **触发梳理**：默认**手动**（控制台按钮/CLI）；可选“每 N 天”或“积压 N 个 turn 才触发”；**不设空闲定时、不做每 20 turn 的频繁梳理**。
3. **梳理**：对一批 `hot_raw` 生成：
   - 周期/任务/主题摘要；
   - `decision`/`preference`/`todo`/`open_question` 候选；
   - 更新项目 brief；
   - 每条带 `source_turn_ids`、`model`、`prompt_version`。
4. **提交 + 降级**：摘要/笔记落库，同事务给该批 turn 写 `processed_at`、`summary_id`；然后（可配宽限期，如 24h）把原文追加到 `cold/<project>/<period>.jsonl.gz`，写 `cold_index(id, file, offset, length, sha256)`，热库清空大字段但保留 `cold_ref`。
5. **检索**：默认搜“热 raw + 温摘要/笔记”；命中冷记录时用 `memory_get(id)` 解压取原文；`memory_search(scope=all)` 可选慢搜冷层。
6. **恢复/导出**：`memory_restore(id)` 把冷记录搬回热层；`export` 可打包冷文件。

**长时间不梳理也可以**：

- 不梳理时，原文一直在热层，照常可搜；20k turn 约 26MB，查询仍可用，不需要为了性能强行梳理。
- 控制台显示“未梳理 turn 数 / 热层大小”；到软上限（如 5,000 turn / 200MB）只**提示**，不强制。
- 手动梳理可以一次处理很大积压：按 `batch_turns`（如 100）分批调用 LLM，先出 chunk summary，再合并成周期 summary/brief；可取消、可续跑。
- 如果永远不梳理，冷层就不会产生；热层一直增长，但备份仍覆盖。是否冷备、多久梳理，完全由你控制。

**触发与引擎分开配置**：

| 配置 | 选项 | 默认 |
|---|---|---|
| `trigger` | `manual` / `interval` / `threshold` / `off` | **`manual`** |
| `engine` | `off` / `rule` / `core_llm` / `dsh_archivist` | `core_llm`（配了 endpoint）否则 `rule` |
| `interval_days` | 仅 `trigger=interval` 时用 | 30 |
| `threshold_turns` | 仅 `trigger=threshold` 时用 | 2000 |

- `manual`：控制台按钮/CLI 触发；可一次梳理大积压。
- `interval`：每 N 天检查一次；DSH 没开就下次启动补。
- `threshold`：积压到 N 个 turn 才触发；适合“很久才整理一次”。
- `off`：不自动梳理，只收录/备份；需要时仍可手动触发（若引擎开着）。

**可自定义的保留参数**（按项目）：

```yaml
memory:
  summarize:
    trigger: manual          # manual / interval / threshold / off
    engine: core_llm         # off / rule / core_llm / dsh_archivist
    interval_days: 30        # 仅 interval
    threshold_turns: 2000    # 仅 threshold
    batch_turns: 100         # 每次 LLM 调用的 turn 数；大积压分层合并
  hot:
    soft_limit_turns: 5000   # 只警告，不强制梳理
    grace_minutes: 1440      # 梳理后原文在热层再留 24h
  cold:
    keep: forever
    format: jsonl.gz
  recycle:
    days: 30
```

默认就是 **`manual` + `core_llm`**（没配 endpoint 用 `rule`）：你不点，它不整理；热层一直可用。

**要点**：

- **热是“工作集”不是“时间窗”**：未梳理的原文 + 当前梳理记忆；不是简单按 30/90 天切。
- **降级只发生在梳理成功后**；失败/关闭梳理时原文不丢。
- **摘要必须带引用**；原文在冷层，随时可查。
- **prompt 版本化**；升级后可对历史重跑（原文在冷层）。
- **冷备不是删除**；回收站是另一套（软删 + 保留期 + purge）。
- **隐私**：梳理会把文本发给 LLM；脱敏、可关、可选本地模型。

### 3.6.1 `summarize` 具体指什么

这里的 `summarize` **不是**给用户看的聊天摘要，也**不是** DSH 的上下文压缩；它是：

> 把一批“还没梳理”的 hot_raw turn，变成**结构化、可检索、可复用的长期记忆**，然后让原文退到冷层。

#### 输入

一批 turn（默认 20–50 个），每个包含：用户原话、ES 回复、GM brief/report、压缩摘要、artifact 元数据、时间戳、turn id。

#### 输出（结构化 JSON，不是一段散文）

```json
{
  "period": { "from_turn": "T101", "to_turn": "T120" },
  "summary": "200–400 字：发生了什么、完成了什么、卡在哪、下一步",
  "decisions": [
    { "text": "窗口下拉按膜系/沉积/仿真分两级",
      "rationale": "用户要求按类别分组",
      "status": "active",
      "source_turns": ["T101", "T102"] }
  ],
  "preferences": [
    { "text": "报告统一用 .docx", "source_turns": ["T118"] }
  ],
  "facts": [
    { "text": "回归 2737 项通过，Qt 崩溃未定位", "source_turns": ["T115"] }
  ],
  "todos": [],
  "open_questions": [
    { "text": "Qt 源编辑器清理阶段崩溃的根因", "source_turns": ["T115"] }
  ],
  "artifacts": [
    { "title": "修复提交", "path": "commit:438da39", "source_turns": ["T120"] }
  ],
  "brief_update": {
    "goal": "…",
    "state": "…",
    "active_decisions": ["…"],
    "open_questions": ["…"]
  },
  "tags": ["窗口列表", "材料刷新", "Qt"]
}
```

#### 写入

- `summary` 表：summary 正文 + `source_turn_ids` + `model` + `prompt_version`；
- `note` 表：decision / preference / fact / todo / open_question；
- `artifact` 表：文件/提交/链接索引；
- 项目 `brief` 更新；
- 同事务给这批 turn 标 `processed_at` / `summary_id`；宽限期后原文进冷层。

#### 一个具体例子

输入 20 个 turn，主题是“窗口列表两级、材料列表刷新、Qt 崩溃”：

- summary：`10-15 完成窗口列表两级与材料列表刷新修复；回归 2737 项通过；Qt 清理阶段崩溃未定位；尚未推送。`
- decision：`窗口下拉按膜系/沉积/仿真两级`、`材料列表复用控件需在生成后刷新`
- open_question：`Qt 源编辑器清理崩溃根因`
- artifact：`commit 438da39`
- brief：目标/状态/已定/未决各更新一行。

之后 ES 搜“窗口列表怎么改的”命中 summary + decision；搜“Qt 崩溃”命中 open_question；要看原话则 `memory_get(T115)` 从冷层取。

#### 不是什么

- **不是 DSH 的 compaction**：compaction 是为了压缩模型上下文，随会话走；`summarize` 是为了项目长期记忆，落库、可检索、可重放。
- **不是给用户看的报告**：用户看的是 ES 的 ≤250 字汇报；`summarize` 是后台记忆整理。
- **不是每轮都做**：批量做，一次 20–50 个 turn；否则成本高、质量差。
- **不是替代原文**：原文进冷层，永远可查；summary 只是索引和提炼。
- **不是自由发挥**：必须带 `source_turns`，不能写源里没有的事实；JSON 校验不过就重试/标记失败，不标 processed。

#### 质量与自动写入

- 默认自动写入 summary/fact/preference；决策类也自动，但控制台可复核/纠正（你选“程序自动”）。
- 与已有 note 做相似去重；新决策与旧决策冲突时，旧决策标 `superseded_by`。
- 每次梳理记 `prompt_version`、`model`、耗时、token；失败不降级，排队重试。
- 成本：一次梳理几十个 turn，一次 LLM 调用；不是每轮。

M1 只建 schema 字段（`processed_at`、`summary_id`、`cold_ref`、`state`）；M2 做“手动梳理 + 自动降级”（可选 `interval`/`threshold`）；M3 做冷备与恢复。

---

## 4. 秘书的工具定义

第一批只做记忆工具，不做委派。五个工具，控制 schema 体积，也控制上下文。

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `memory_search` | 按关键词/时间/类型检索记忆 | 返回 ≤5 条，每条 ≤160 字，带 id/日期/来源 |
| `memory_get` | 按 id 读一条完整记录（可带前后各 1 条） | 总输出 ≤1200 字 |
| `memory_recent` | 读最近 N 个 turn | N≤10，每条 ≤120 字 |
| `memory_note` | 写入一条长期记忆（事实/偏好/决策/待办/未决） | 正文 ≤500 字，必须带 kind |
| `memory_brief` | 读当前项目 brief（目标、已定、未决、最近里程碑） | ≤400 字，自动注入也可用 |

### 4.1 Schema 草案

```json
// memory_search
{ "query": "上次为什么不用 AI 模型",
  "limit": 5,
  "kind": ["turn", "note", "decision"],
  "since": "2026-10-01",
  "tags": ["算法"] }

// 返回
{ "results": [
  { "id": "T42", "date": "2026-10-18", "kind": "decision",
    "snippet": "决定先做预设结构+全局搜索，不先上 AI 模型。",
    "source": "secretary_user" } ] }
```

```json
// memory_note
{ "kind": "decision",
  "text": "报告统一用 .docx，不用 PDF。",
  "tags": ["交付格式"],
  "importance": 0.8,
  "source_turn": "T57" }
```

### 4.2 工具描述里必须写清楚的事

模型-facing 的工具描述，按 `agent-experience` 的原则，要回答：

- **什么时候用**：用户提到“上次/之前/为什么/我们决定过/我说过”时，先 `memory_search`，不要凭印象答。
- **什么时候不用**：当前对话里刚说过的事，不要重复查。
- **查不到怎么办**：明确说“记忆里没有找到”，不要编。
- **写什么**：用户说“记住/以后都/决定/不要”时，写 `memory_note`；不要每句话都写。
- **返回多大**：服务端强制限长；超长截断并提示“已省略，可用 memory_get 查看”。
- **引用**：结果带 `id`，秘书回复时可用日期或 id 指代来源。

### 4.3 系统提示词片段（秘书）

```text
你是这个项目的执行秘书。你的职责是保持项目记忆线清晰：
接需求、查档案、转达、回报。

规则：
1. 默认极简：状态/结论/证据/下一步，1–3 句，≤250 字。
2. 用户问“上次/之前/为什么/决定过什么”，先调用 memory_search；
   记忆里没有就直说没有，不要猜。
3. 用户说“记住/以后都/决定”，调用 memory_note，并回一句“已记下”。
4. 需要长文档时，不要自己写进聊天；交给文书，聊天只回文件链接和一句结论。
5. 不要粘贴工具输出、代码 diff、完整报告。
```

### 4.4 记忆 brief 的自动注入

每个用户轮开始时，插件把 `memory_brief()` 的结果作为一段 ≤400 字的上下文注入：

```
项目：coating-sim
目标：把膜系优化做到 …
已定：预设结构+全局搜索；报告用 docx。
未决：是否推送 438da39。
最近：10-20 完成 16 层复现。
```

这样即使 harness 压缩掉旧对话，ES 仍知道项目当前状态；细节再靠 `memory_search`。这是“harness 管上下文 + 我们管记忆”的衔接点。

---

## 5. 档案室：工具还是子代理？

你提到“给执行秘书配一个记忆管理子代理或者叫档案室”。两个方案：

### 方案 A：只做工具（推荐先做）

- ES 直接调用 `memory_search/get/recent/brief`；
- 插件是宿主服务 + SQLite；
- 优点：一次调用、便宜、透明、可调试；
- 缺点：检索结果直接进 ES 上下文；多跳问题要 ES 自己串；ES 可能不会改写查询。

### 方案 B：档案室子代理

- ES 调用 `ask_archive(question)`；
- 档案室是 ES 的子代理（depth 1），有自己的预设和模型；
- 它用同一套记忆工具检索、读全文、综合，返回 ≤300 字 + 引用；
- 优点：ES 上下文更干净；档案室可以做多跳检索、查询改写、日/周总结；
- 缺点：多一次模型调用；延迟和成本；档案室自己也会犯错；需要维护另一个 preset。

### 推荐：同一存储，两条访问路径，先 A 后 B

1. **M1**：先把记忆库和工具做出来，ES 直接用。用真实对话测 20 个回忆问题，看召回和上下文占用。
2. **M2**：如果发现 ES 经常问多跳问题、或检索片段太占上下文、或需要定期总结，再把同一套工具包装成档案室子代理。
3. 档案室不新建一套记忆，它只是“会检索、会综合的读者”。这样不会返工。

档案室的定位：

- 名字：档案室 / Archivist；
- 位置：ES 的子代理（depth 1），用户可在原生 subagent UI 里查看；
- 模型：快模型即可（检索是机械活，综合也不难）；
- 工具：`memory_search/get/recent/brief`，可选 `summary_write`；
- 提示词：“只根据档案回答；引用 [T#]/[N#]；找不到就说找不到；≤300 字；不要推测。”
- 定期任务：每日/每周把当天对话压成 summary，提取候选 note/decision，标记过时的未决问题。
- 它的输出不直接进用户聊天，ES 决定怎么转述。

“档案室”也可以以后在控制台里做成一个页面：时间线、搜索、笔记、来源。但那是 UI，不是新的记忆系统。

---

## 6. 角色树更新

```
用户 ⇄ 执行秘书(ES) ⇄ 顾问(根会话，可多个)
          ├─ 档案室 Archivist（记忆检索/整理，depth 1）
          └─ 总经理 GM（depth 1）
               ├─ 部门经理（depth 2）
               │    └─ 工人 / 文书 Scribe（depth 3）
               └─ 验证部门（可选）
```

- 档案室和 GM 都是 ES 的子代理，平级；ES 只跟它们俩说话。
- 档案室不派活；GM 不查档案细节（GM 有自己的部门报告和项目库；需要历史时找 ES 或档案室，走一条明确的工具）。
- 文书是工人角色的一种，挂在文档部门下；也可以有独立的“文档部”。
- depth 仍然是 3：ES(0)→档案室/GM(1)→部门(2)→工人/文书(3)。

### 两个流程例子

**例 1：用户问“上次为什么决定不先上 AI 模型？”**

1. ES 调 `memory_search("为什么 不先上 AI 模型 决策")`；
2. 命中 `T42` 决策记录 + `T41` 讨论；
3. ES 回：“10-18 决定先做预设结构+全局搜索，因为当时没有达标耗时证据；AI 模型留到结构搜索跑顺后再评估。[T42]”
4. 用户追问细节 → ES 调 `memory_get("T42")` 或转档案室。

**例 2：用户说“把这周的进展整理成周报”。**

1. ES 判断这是 artifact，不是聊天；
2. ES 给 GM 一个 brief：“本周进展 → 周报，docx，面向老板，3 页以内”；
3. GM 让档案室/部门汇总材料，文书生成 `.docx`；
4. GM 回 artifact 元数据；
5. ES 回：“周报已生成：`reports/week-42.docx`，3 页，5 个结论、2 个风险。核心结论是 X。”

聊天里没有 3000 字周报，但用户拿到了 3000 字周报。

---

## 7. 第一步做什么（M1：记忆底座 + 秘书工具）

**目标**：让 ES 拥有项目级永久记忆，能自己查，restart 不丢；暂不做 GM、不做控制台、不做文书。

> **第三轮修订**：M1 拆成 **M1a 核心服务（独立 Python，不 import DSH）** + **M1b DSH 薄适配器**；顺序与验收见 [decoupled-architecture.md](D:/a/dsh/team/decoupled-architecture.md)。下面“宿主插件”条目按该文替换为“核心服务 + 适配器”。

### 交付物

1. 宿主插件 `secretary-memory`（先不做客户端页面）：
   - 项目识别：workspace → `.dsh/project.json` → project id；
   - SQLite 库 + schema + 迁移；
   - 会话事件订阅 + 历史回填；
   - bigram FTS 索引；
   - 五个工具；
   - brief 注入。
2. 预设 `secretary`：
   - persona（第 4.3 节）；
   - 工具：五个记忆工具；
   - 不挂 fs/shell/web/委派。
3. 测试：
   - 用真实对话跑 30–50 个回忆问题；recall@5 ≥70%，top-1 命中 ≥50%；
   - 重启后同一问题仍可答；
   - 新开一个 ES 会话，仍能检索旧会话；
   - 压缩后旧 turn 仍可检索；
   - 工具结果 p95 ≤350 字；
   - 查询 p95 ≤100ms（20k turn 量级）；存储 ≤2KB/turn；
   - 增量写入 ≤2ms/条；
   - 数据库从日志重建后 turn 数一致。

### 明确不做

- 不做控制台；
- 不做 GM/部门/工人；
- 不做档案室子代理（M2 再评估）；
- 不做 embedding（先看 bigram + 规则召回够不够）；
- 不做文档生成（M4）；
- 不改 harness 的上下文管理。

### 为什么先做这个

- 它是整个架构的底座：没有可靠记忆，ES 就只是“转发器”；
- 它不依赖层级，能独立验收；
- 它直接解决你最在意的“永久记忆线”；
- 它能先暴露中文检索、工具限长、上下文注入这些真实问题。

时间估计：2–4 天（含测试）；如果只做最小可用版，1–2 天。

---

## 8. 后续步骤

| 阶段 | 内容 | 依赖 |
|---|---|---|
| M2 档案室 | 同一存储包装成子代理；日/周总结；查询改写 | M1 的召回评测结果 |
| M3 总经理 | GM 子代理、brief/report 契约、ES↔GM 记忆入库 | M1 |
| M4 文书 | 文档部门、artifact 生成与投递 | M3 |
| M5 控制台 | 只读角色树/记忆浏览/artifact；再逐步可写 | M1–M4 |
| M6 顾问 | 根会话、读完整记忆线、建议 inbox | M1 |

注意顺序：**记忆 → 档案室（可选）→ GM → 文书 → 控制台 → 顾问**。先把“记得住”解决，再解决“干得成”，最后解决“看得见”。

---

## 9. 需要你拍板的几个点

1. **记忆库位置**：`~/.dsh/projects/<id>/memory.db`（推荐）还是 workspace 内 `.dsh/memory.db`？
2. **先工具还是先档案室**：我建议先工具（M1），用评测决定要不要档案室（M2）；你是否接受？
3. **记忆写作范围**：只允许 ES 写 `memory_note`，还是也让档案室自动提炼候选笔记（标记 proposed，等确认）？
4. **中文检索**：先 bigram（推荐），还是一步到位上 embedding？
5. **文档交付**：文书挂在 GM 下的文档部（推荐），还是 ES 直接挂一个文书？
6. **长回答**：`answer` 模式 800 字够不够？还是需要 1200/1500？
7. **profile**：现在继续用 `desktop`，等装整套 bundle 再开 `dots` profile；是否同意？

---

## 10. 待验证的技术点

1. DSH 会话事件里，compaction summary 以什么事件/角色出现，是否适合入记忆库。
2. `sessionQuery` 回填历史时，如何区分 ES 会话、GM 会话、其他会话（cwd + preset + parent）。
3. bigram 预处理对中文的召回效果；是否需要 trigram 或 embedding 兜底。
4. 工具结果限长后，ES 是否仍能正确回答；会不会因为片段太短而误判。
5. 记忆 brief 每轮注入的 token 成本；能否缓存/按需。
6. 多 ES 会话同项目时，turn 编号/时间线如何合并。
7. `memory_note` 写入与用户删除/更正时的冲突处理（supersede 语义）。
8. DB 从日志重建的完整性；note/artifact 的单独备份。
9. 敏感信息脱敏规则。
10. 插件加载方式：宿主行 + 预设工具，是否走 `@local` 包；热重载行为。

---

## 11. 一句话总结

**harness 管 ES 的“最近记得住”，我们管项目的“永远查得到”。** ES 的会话日志是项目记忆主线；我们的记忆库是它的索引和提炼层；档案室是这条记忆线的一个“会检索的读者”，不是另一套记忆。报表/文档走交付物通道，聊天继续保持 dots 式精简。
