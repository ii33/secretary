# 秘书办公室 v1 规格（M1）

> 状态：**M1a/M1b 完成；M2 控制台可用；M3 冷层 + advisor 最小闭环；M4 GM/部门/worker 预设已实现，待重启验收。** 本文是唯一执行口径；更长的背景见 [dots-office-architecture.md](../dots-office-architecture.md)、[secretary-memory-design.md](../secretary-memory-design.md)、[decoupled-architecture.md](../decoupled-architecture.md)、[bigram-evaluation.md](../bigram-evaluation.md)。
> 决策：前端走方案 A（装进现有 `desktop` profile，不新建 profile、不开浏览器）；Agent Teams 已关闭；手动压缩 dry-run 确认；顾问对话不进主记忆线；回收站 purge 连带冷层；M1 范围按本文冻结。

---

## 0. 决策与假设

| 项 | 决定 |
|---|---|
| 前端 | DSH Desktop 的 `desktop` profile 内客户端插件；不新建 profile；不自带运行时 |
| 核心 | 独立 Python 进程，只用标准库；代码不 import DSH；用 DSH 自带 Python，系统 Python 兜底 |
| 数据目录 | `%USERPROFILE%\.secretary-office` |
| 记忆范围 | ES↔用户 + ES↔GM 报告；顾问、DM、worker 过程不进主记忆线 |
| 写入 | 程序自动收录；notes 可手动/自动；手动压缩需 dry-run 确认 |
| 搜索 | bigram + SQLite FTS5，索引单位 turn |
| M1 不做 | GM/部门/工人、控制台、LLM 压缩、冷备、embedding、advisor |
| 运行 | 核心随 DSH 启动、后台隐藏；CLI 可在无 DSH 时启动核心/查数据 |

### 0.1 执行秘书定位

执行秘书（ES）不是传声筒，而是**与用户同层的全局把控者**：

- 自动看项目 brief（目标/已定/未决/里程碑/已采纳顾问建议），决定路线并给 GM 下发指令；
- 比 GM 更总览全局：GM 只看一棵任务树，ES 看项目记忆、用户意图、顾问意见和跨会话状态；
- 验收 GM 报告，发现偏差用 `send_message` 纠正、用 `interrupt_agent` 停当前轮；
- **不直接读 GM 完整会话**，只接收 GM 的 brief/报告；`list_agents` 只给 running/inactive 与层级，不读子日志；
- GM 停了用 `send_message` 唤醒；终止整个 GM 任务要 `list_agents({scope:"descendants"})` + 逐层 `interrupt_agent`（interrupt GM 不会自动停后代）；
- ES 看不到顾问与用户的对话，也看不到未采纳建议；**只有用户采纳后**才追加一条 `advice.accepted` 的 hot turn（未压缩），不自动写 brief/note、不触发 compress；采纳/不采纳由用户决定，ES 不自行采纳/拒绝/执行；
- 主动维护上下文：只保留 brief、GM 报告、决策和证据，不把 DM/worker 完整过程塞进上下文；
- 任务板/项目约定：用户与 ES 可编辑；顾问/GM/DM 只读；worker 不可见；约定与任务板分表、分 tab。
- 人员架构：控制台树展示项目会话，节点可查看 preset、进入会话；角色 tab 列项目/全局 preset，支持导出与草稿导入。
- 工具：`memory_*` + `gm` + `list_agents`/`send_message`/`interrupt_agent`；不直接改文件/执行命令。

历史“3 个工具/8 个工具”的对话是同会话切换工具集的调试现象，不能作为 ES 能力或错误的证据。

---

## 1. 范围

### M1a：核心服务（无 DSH 可跑）

- SQLite schema、迁移、WAL、bigram FTS；
- 原始事件仓 + 归一化；
- HTTP API + 本地 token；
- 5 个记忆工具的后端逻辑：
  - `memory_search`、`memory_get`、`memory_recent`、`memory_note`、`memory_brief`；
- 回收站 API（软删/还原/purge/审计）；
- CLI：`doctor / init / ingest / search / get / recent / brief / note / export / recycle / restore / purge / stats / serve`；
- fake 事件源与完整测试；无 DSH import。

### M1b：DSH 薄适配器（只在 DSH 内）

- 安装到 `desktop` profile 的 `@local/dsh-office` bundle（host + presets + core 代码；client 页面后置）；
- 订阅 `session/event`，自动收录 ES 会话；
- `sessionQuery` 回填；
- 把 5 个工具挂到 `secretary` 预设（薄 host 工具调用核心 HTTP；MCP 后置）；
- 端到端：真实 ES 会话 → 自动入库 → 工具检索 → 重启/回填不丢。

### 非目标（M1 明确不做）

- 不做 GM/DM/worker 层级；不做 subagent 编排；
- 不做控制台页面/侧边栏；
- 不做 LLM 压缩、不做冷备、不做 embedding；
- 不做 advisor 对话入库；
- 不做 MCP、不做多租户/远程访问；
- 不打包 Python 运行时。

---

## 2. 架构

```
DSH Desktop（desktop profile）
├─ @local/dsh-office（M1b）
│  ├─ host 插件：采集 + 工具桥 + 启动核心
│  └─ presets：secretary
└─ 原生聊天/会话
        │ HTTP 127.0.0.1 + token
        ▼
独立核心服务（Python，M1a）
  SQLite + FTS5 + 原始事件仓 + 回收站
        │
        ▼
%USERPROFILE%\.secretary-office\office.db
```

- 核心不 import DSH；可用任意 Python 3.11+ 启动。
- 适配器是唯一 DSH 相关代码；DSH 升级只改适配器。
- 数据/核心不依赖 DSH；DSH 坏了仍可用 CLI 查/导出。
- 控制台 M2/M3 再加，作为同一 bundle 的 client 插件。

---

## 3. 数据模型（M1）

SQLite，WAL；`schema_version` 记在 `meta`，当前为 **v11**（v1→v2 加 `turn.event_type`；v2→v3 加 `advice`；v3→v4 去重并建 live turn 唯一索引；v4→v5 加 advice `decided_at`；v5→v6 加 `taskboard`；v6→v7 加 `taskboard_item` 列表；v7→v8 加约定 kind；v8→v9 独立 `convention_item`；v9→v10 加 `agent_name`；v10→v11 加项目预设表；迁移前自动备份）。时间统一 epoch ms。

```sql
meta(key TEXT PRIMARY KEY, value TEXT)

project(id TEXT PRIMARY KEY, name TEXT, workspace TEXT,
        settings_json TEXT, created_at INTEGER)

session(id TEXT PRIMARY KEY, project_id TEXT, kind TEXT,
        -- secretary_user / secretary_gm / advisor / other
        external_ref TEXT, preset TEXT, model TEXT,
        started_at INTEGER, ended_at INTEGER, title TEXT)

raw_event(id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT, source_version TEXT, event_type TEXT,
          external_session TEXT, external_seq INTEGER,
          payload TEXT, received_at INTEGER,
          normalizer_version TEXT, normalized_at INTEGER, error TEXT,
          UNIQUE(source, external_session, external_seq, event_type))

turn(id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id TEXT, session_id TEXT, seq INTEGER, event_type TEXT,
     turn_no INTEGER,
     user_text TEXT, assistant_text TEXT, created_at INTEGER,
     summary TEXT, state TEXT,          -- hot_raw / processed / cold
     processed_at INTEGER, summary_id TEXT,
     archived_at INTEGER, cold_ref TEXT,
     importance REAL DEFAULT 0.5, tags TEXT,
     deleted_at INTEGER, deleted_by TEXT, delete_reason TEXT, purge_after INTEGER)

message(id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT, session_id TEXT, turn_id INTEGER, seq INTEGER,
        role TEXT, kind TEXT,           -- user / assistant / brief / report / compaction
        text TEXT, created_at INTEGER, source_seq INTEGER,
        archived_at INTEGER, cold_ref TEXT)

note(id TEXT PRIMARY KEY, project_id TEXT, kind TEXT,
     -- fact / preference / decision / todo / open_question
     text TEXT, tags TEXT, importance REAL, status TEXT,
     -- active / superseded / archived
     source_session TEXT, source_turn INTEGER, created_at INTEGER,
     superseded_by TEXT,
     deleted_at INTEGER, deleted_by TEXT, delete_reason TEXT, purge_after INTEGER)

artifact(id TEXT PRIMARY KEY, project_id TEXT, title TEXT, path TEXT,
         kind TEXT, summary TEXT, source_turn INTEGER, created_at INTEGER,
         deleted_at INTEGER, deleted_by TEXT, delete_reason TEXT, purge_after INTEGER)

summary(id TEXT PRIMARY KEY, project_id TEXT, scope TEXT,
        -- day / week / milestone / manual
        period_start INTEGER, period_end INTEGER, text TEXT,
        source_turn_ids TEXT, model TEXT, prompt_version TEXT, created_at INTEGER)

brief(project_id TEXT PRIMARY KEY, text TEXT, updated_at INTEGER, source_summary TEXT)
taskboard(project_id TEXT PRIMARY KEY, long_term TEXT, stage TEXT, current TEXT,
          updated_at INTEGER, updated_by TEXT)  -- legacy text, migrated
taskboard_item(id TEXT PRIMARY KEY, project_id TEXT, section TEXT, kind TEXT, title TEXT, detail TEXT,
               status TEXT, position INTEGER, created_at INTEGER, updated_at INTEGER,
               updated_by TEXT)
convention_item(id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, title TEXT, detail TEXT,
                status TEXT, position INTEGER, created_at INTEGER, updated_at INTEGER,
                updated_by TEXT)


cold_index(id TEXT PRIMARY KEY, project_id TEXT, kind TEXT,
           file TEXT, offset INTEGER, length INTEGER, sha256 TEXT, created_at INTEGER)

role_policy(project_id TEXT, role TEXT, preset TEXT, provider TEXT, model TEXT,
            effort TEXT, sandbox TEXT, limits_json TEXT, revision INTEGER,
            PRIMARY KEY(project_id, role))

audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, actor TEXT,
      action TEXT, ref_type TEXT, ref_id TEXT, detail TEXT)

-- 内容less FTS，body 为 bigram token 串；rowid 映射
CREATE VIRTUAL TABLE turn_fts  USING fts5(body, content='', tokenize='unicode61');
CREATE VIRTUAL TABLE note_fts  USING fts5(body, content='', tokenize='unicode61');
CREATE VIRTUAL TABLE summary_fts USING fts5(body, content='', tokenize='unicode61');
```

- `turn.state`：`hot_raw` / `processed` / `cold`（M3 已实现冷层）。
- 删除：`turn` 不直接删，随回收站；`message` 跟随 turn；`note/artifact` 软删字段；purge 级联删除由 turn 派生的 summary/note/artifact。
- `role_policy` 表已建；控制台只读，写入策略待 M4 后续。
- `cold_index`/`summary` 已由 M2/M3 写入；冷层归档/读取/purge 已接线。
- FTS`_content` 不存 token 正文；命中后回表取原文。
- 索引：`turn(project_id, created_at)`、`turn(state)`、`raw_event(external_session, external_seq)`、`note(project_id, status)`。

---

## 4. 事件与归一化

### 4.1 事件信封（适配器 → 核心）

```json
{
  "source": "dsh",
  "source_version": "0.2.1-rc.2",
  "event_type": "turn.completed",
  "external_session": "session-...",
  "external_seq": 123,
  "project": "coating-sim",
  "occurred_at": 1792596532000,
  "payload": {
    "role": "secretary",
    "preset": "secretary",
    "model": "deepseek-flash",
    "user_text": "...",
    "assistant_text": "...",
    "brief": "...",
    "report": "...",
    "kind": "user_turn"
  }
}
```

- 适配器先 `POST /v1/raw-events`，核心存原始 JSON；归一化器再写 `turn/message`。
- 幂等唯一键：`(source, external_session, external_seq, event_type)`。
- M1a 用 fake 事件源（同一信封）测试。
- 只收文本；不收 reasoning、工具原始输出、系统提醒。
- `brief`/`report` 作为 `message.kind` 写入；M1b 的 GM 报告来自 `subagent/end`（若存在）。

### 4.2 项目识别（M1b）

- workspace 根 `.dsh/office.json`：`{"project":"coating-sim"}`；
- 适配器读 cwd → project；未知则跳过并告警；
- 只收录 `agentPreset=secretary` 的会话；顾问/GM/DM/worker 默认不收；
- 会话中途换 preset：以首次识别为准，控制台可纠正（M2）。

### 4.3 回填

- 启动/首次连接时用 `sessionQuery.listSessions` + `readSession` 扫历史；
- 按 `(session_id, seq)` 幂等；
- 回填只补缺，不重复；
- DSH 事件不可用时，退回 `sessionQuery` 轮询（低频）。

---

## 5. HTTP API（本地）

- 仅监听 `127.0.0.1`；`Authorization: Bearer <token>`；token 在 `.run/core.json`。
- 错误：`{"error":{"code":"...","message":"..."}}`；HTTP 4xx/5xx。
- 批量接口可选；M1 先单条。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/v1/health` | 版本、DB、FTS、uptime |
| POST | `/v1/projects` | 建项目 `{id,name,workspace}` |
| GET | `/v1/projects` | 列表 |
| POST | `/v1/raw-events` | 上报原始事件（单条） |
| GET | `/v1/search` | `q,project,limit,kind,since,until,include_deleted` |
| GET | `/v1/turns/{id}` | 取 turn 原文；`include_deleted=1` 可看软删 |
| GET | `/v1/recent` | `project,limit,include_deleted` |
| POST | `/v1/notes` | 写 note |
| GET | `/v1/notes` | 列 note（过滤） |
| GET | `/v1/brief` | 读 brief |
| GET | `/v1/taskboard` | 任务板列表 `{items}`（长期/阶段/当前，含状态） |
| POST | `/v1/taskboard` | 新增/编辑/状态/移除任务板条目 |
| GET | `/v1/conventions` | 项目约定列表 `{items}`（avoid/follow） |
| POST | `/v1/conventions` | 新增/编辑/挂起/恢复/移除约定 |
| GET | `/v1/compress/preview` | 压缩 dry-run（不写库） |
| POST | `/v1/compress` | `{project,batch,confirm:true}` 写入 summary/notes/brief 并标 processed |
| POST | `/v1/archive` | `{project,grace_hours}` 或 `{now:true}` 归档已压缩原文到冷层 |
| GET | `/v1/summaries/{id}` | 读摘要全文 |
| GET | `/v1/recycle` | 回收站列表 |
| GET | `/v1/roles` | 角色策略只读列表 |
| GET | `/v1/advice` | 顾问建议 inbox |
| POST | `/v1/advice` | `{project,subject,recommendation,evidence,options}` 写建议 |
| POST | `/v1/advice/{id}/delivered` | 标记建议已读 |
| POST | `/v1/advice/{id}/decision` | `{decision:accepted|rejected}` 用户决定建议 |
| POST | `/v1/recycle` | `{ref_type,ref_id,reason}` 软删 |
| POST | `/v1/restore` | 还原 |
| POST | `/v1/purge` | `now=1` 强制清理；默认只清到期 |
| GET | `/v1/stats` | 计数、大小、延迟 |
| GET | `/v1/audit` | 最近审计 |
| GET | `/v1/agent-names` | 项目 agent 实例名映射 |
| POST | `/v1/agent-names` | `{project,session_id,name}` 设置实例名 |
| GET | `/v1/project-presets` | 项目本地预设草稿 |
| POST | `/v1/project-presets` | 写入项目本地预设（不自动进全局） |
| GET | `/office-console/api/org` | 项目人员架构树（host） |
| GET | `/office-console/api/presets` | preset 清单（project/global） |
| GET | `/office-console/api/presets/{id}` | preset YAML 组成 |
| POST | `/office-console/api/presets/import` | 导入 preset 草稿（需重载生效） |

搜索结果：

```json
{ "results": [
  { "id": "T42", "date": "2026-10-18", "kind": "turn",
    "snippet": "……", "score": 0.82, "state": "hot_raw" } ] }
```

---

## 6. CLI（无 DSH 可用）

```bash
python -m secretary_core doctor
python -m secretary_core init --project coating-sim --workspace D:/work/coating-sim
python -m secretary_core ingest --project coating-sim --file events.jsonl
python -m secretary_core serve --host 127.0.0.1 --port 0
python -m secretary_core search "上次为什么不用 AI 模型" --project coating-sim
python -m secretary_core get 42
python -m secretary_core recent --project coating-sim --limit 5
python -m secretary_core brief --project coating-sim
python -m secretary_core note --project coating-sim --kind decision --text "..."
python -m secretary_core search "窗口 两级" --project coating-sim --include-deleted
python -m secretary_core get 42 --include-deleted
python -m secretary_core export --project coating-sim --out exports/
python -m secretary_core backup --label manual
python -m secretary_core compress --project coating-sim --batch 20
python -m secretary_core compress --project coating-sim --batch 20 --confirm
python -m secretary_core archive --project coating-sim
python -m secretary_core recycle --project coating-sim --type turn --id 42
python -m secretary_core restore --project coating-sim --type turn --id 42
python -m secretary_core purge --project coating-sim --now
python -m secretary_core stats --project coating-sim
```

- `doctor`：Python 版本、sqlite3 FTS5、数据目录、token/端口、DSH Python 路径、磁盘权限。
- `serve`：单实例；写 `.run/core.json`（port/token/pid/version）；已运行则复用。
- `ingest`：读 JSONL 事件信封；测试/回放用。
- `backup`：SQLite online backup 到 `backups/`；迁移前也会自动备份。
- `--include-deleted`：search/get/recent 可查软删数据；默认排除。
- `purge`：默认只清到期；`--now` 强制清理所有软删记录。
- `compress`：默认 dry-run；`--confirm` 才写 summary/notes/brief 并标 processed；规则引擎本地运行。
- `archive`：把已压缩且超过宽限期的 turn 原文写冷层；`--now` 忽略宽限期。

---

## 7. 记忆工具（M1）

工具逻辑在核心；M1b 由 host 插件薄封装；schema 固定。

| 工具 | 输入 | 输出/约束 |
|---|---|---|
| `memory_search` | `query`, `limit=5`, `kind?`, `since?`, `until?` | ≤5 条，每条 ≤160 字；带 id/日期/kind；默认只搜热 raw + notes |
| `memory_get` | `id`, `neighbors=0` | ≤1200 字；M1 只热；M3 支持冷 |
| `memory_recent` | `n=5` | 最近 n 个 turn，每条 ≤120 字 |
| `memory_note` | `kind`, `text≤500`, `tags?`, `importance?`, `source_turn?` | 写 note；返回 id；ES 可调用 |
| `memory_brief` | — | ≤400 字；读 `brief`；空则“暂无 brief” |

- **不提供** `memory_compress` / `memory_forget` 给 ES；手动入口只在控制台/CLI。
- 工具描述写清楚：何时用、何时不用、查不到就说没有、超长截断提示。
- 服务端强制限长，不依赖模型自觉。

---

## 8. 检索

- bigram + FTS5 contentless；中文 bigram、英文小写词；
- 查询：抽 bigram/词 → 取 12–20 个最稀有 → OR → top 30–50 → 重排（稀有覆盖度 + 时间 + 重要度 + 精确短语）；
- 1 字查询/无结果：`LIKE '%q%'` 回退，limit 5；
- 结果按 turn 去重；snippet 围绕命中位置截取；
- M1 只搜 `hot_raw` + `note`；`processed`/`summary` M2 加；`cold` M3；
- 目标：20k turn 查询 p95 ≤100ms；工具结果 p95 ≤350 字。

---

## 9. 回收站

- 软删：`deleted_at/deleted_by/delete_reason/purge_after`；默认 30 天，可配 7/30/90/365/永久。
- 默认检索/ brief/ recent 排除已删；CLI `--include-deleted` 可查。
- 还原：清空删除字段 + 审计。
- purge：到期/手动；删 hot 数据 + 关联 note/artifact；M3 连带冷层原文；备份按备份保留期处理。
- 审计：每次删/还原/purge 写 `audit`。
- 删除 turn 时，关联自动 note 标 `source_deleted`，进控制台复核（M2）。

---

## 10. 自动收录（M1b）

- 适配器订阅 `session/event`（post-commit）；
- 只收 ES 会话的 user/assistant 文本 + brief/report；过滤 reasoning/工具/系统；
- 先写 `raw_event`，再归一化；失败可重放；
- 回填 `sessionQuery`；幂等；
- GM 报告：若已有 `subagent/end`，解析报告文本写 `message.kind=report`；M1b 可先不做，等 GM 出现再加；
- 顾问/DM/worker 不收录。

---

## 11. 运行与打包

### 核心

- `secretary_core` Python 包；只用标准库；
- 数据目录 `%USERPROFILE%\.secretary-office`；
- 单实例：`.run/core.json`；CLI/host 读取；
- 日志 `logs/core.log`；轮转；
- 备份 `backups/`；导出 `exports/`。

### Python 定位

- 优先 DSH 自带 Python：`~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`；
- 回退系统 `python`/`py -3`；
- `doctor` 报告实际路径；找不到则明确报错，不静默。

### DSH bundle（M1b）

- `@local/dsh-office`：`package.json` + `cordis.patch.yml` + `host/` + `presets/` + `core/`；
- 安装进 `desktop` profile；不新建 profile；
- host 插件：启动核心、健康检查、采集、工具桥；
- `secretary` 预设：5 个工具 + persona（M1 先简单）；
- 不依赖 Agent Teams（已关闭）。

### 无 DSH 时

- `python -m secretary_core serve/ingest/search/export` 可独立运行；
- 这是数据逃生口；DSH 坏了仍可查/导出/手动压缩（M2）。

---

## 12. 验收

### M1a

- `doctor` 通过；`init` 建库；100 条 fake 事件入库；
- `search` 20 个问题有合理结果；工具/搜索输出不超限；
- 重启后数据可查；`export` 可导出；`purge` 可清理；
- 无任何 DSH import；用系统 Python 3.11+ 可跑；
- 单实例/端口/token 正常；WAL 写入无丢。

### M1b

- DSH 打开后核心自动启动；真实 ES 会话自动入库；
- 20 个 turn 后 ES 可检索；重启 DSH 后可查；回填不重复；
- 5 个工具在 `secretary` 预设可见且可用；
- 关闭 DSH 后 CLI 仍可查/导出；
- 不出现 team/subagent 工具冲突。

---

## 13. 目录结构（提议）

```
D:\a\dsh\team\secretary-office\
├─ README.md
├─ docs\
│  └─ v1-spec.md
├─ core\
│  ├─ pyproject.toml
│  ├─ secretary_core\
│  │  ├─ __init__.py
│  │  ├─ __main__.py
│  │  ├─ cli.py
│  │  ├─ config.py
│  │  ├─ db.py
│  │  ├─ schema.sql
│  │  ├─ tokenizer.py
│  │  ├─ search.py
│  │  ├─ events.py
│  │  ├─ recycle.py
│  │  ├─ server.py
│  │  ├─ logging_setup.py
│  │  └─ tools.py
│  └─ tests\
│     ├─ fixtures\events.jsonl
│     ├─ test_tokenizer.py
│     ├─ test_db.py
│     ├─ test_events.py
│     ├─ test_search.py
│     ├─ test_recycle.py
│     ├─ test_api.py
│     ├─ test_logging.py
│     └─ test_cli.py
├─ scripts\
│  ├─ acceptance.py
│  └─ bench_memory_contentless.py
└─ (M1b) dsh\
   ├─ package.json
   ├─ cordis.patch.yml
   ├─ host\
   │  ├─ index.js
   │  └─ python-locator.js
   ├─ presets\
   └─ client\        # M2/M3
```

---

## 14. M1 任务清单

### M1a（核心，约 6–8 天）— ✅ 已完成

- [x] 1. 骨架 + `doctor` + 配置/数据目录 + 单实例（0.5d）
- [x] 2. schema/migrations + WAL + tokenizer + FTS 测试（1d）
- [x] 3. raw_event + 归一化 + 幂等 + fake 事件（1d）
- [x] 4. search/ranking/snippet + 限长 + 测试（1d）
- [x] 5. tools 逻辑 + HTTP API + token 鉴权（1d）
- [x] 6. CLI 全部命令 + export（1d）
- [x] 7. 回收站 + 审计（0.5d）
- [x] 8. 端到端验收 + 文档 + 指标（1d）

M1a 验收结果：84 tests 通过；100 条 fake turn 验收 20/20 查询有结果，p95 ≈ 2–5ms，热库约 250KB；验收覆盖 export、强制 purge、FTS rowid 清理、schema 迁移 v1→v4、日志、`--include-deleted` 与备份。

### M1a 收口（工程底座）— ✅ 已完成

- [x] schema migrations v1→v4（event_type / advice / unique live turn；迁移前自动备份）
- [x] 文件日志与轮转（`logs/core.log`，RotatingFileHandler）
- [x] `--include-deleted`（search/get/recent + CLI/API）
- [x] 工具限长对齐（search ≤5、snippet ≤160、recent 每条 ≤120、`memory_get` 含 brief/report）
- [x] `backup` 命令（SQLite online backup）
- [x] 评测文档复现口径（contentless benchmark 脚本）

### M1b（适配器，约 3–5 天）— 🟡 冒烟通过，20-turn soak 待做

- [x] 1. bundle 骨架 + 安装到 desktop profile + Python locator（1d）
- [x] 2. host 采集 `session/event` + 回填 + 原始事件（1d）
- [x] 3. 5 个工具桥接 + `secretary` 预设（1d）
- [x] 4. 真实会话端到端 + 重启/回填 + 文档（1d）— 冒烟通过：8 tools、5 real turns；T1 重启后回填、T2 实时写入；20-turn soak 待做

M1b 代码验证：13 个 Node 测试通过（turn 组装/过滤、项目映射、核心启动、事件写入、回填、5 工具注册与执行、GM/顾问/控制台）。真实 DSH 会话工具列表为 8 个（5 memory + ask_user + load_workspace_dependencies + working_directory）；核心收录 5 条 turn，raw_event 与 turn 均为 5、无重复。已修复：工具必须声明 `output.render`（否则 DSH 拒绝注册，只剩全局 3 个工具）；会话中途切换预设时 `header.agentPreset` 不变，适配器改跟踪 `agent-preset/selected` 并**用 effective preset 标记 payload**。剩余：20-turn soak 与 ES 主动调用 memory_search 的行为观察。

### M2（控制台 + 手动压缩）— 🟡 左侧栏面板已确认；规则质量与真实 confirm 待修

- [x] 规则压缩器（本地确定性提取，不调用 LLM；保守提取决策/偏好/事实/待办/未决）
- [x] 手动压缩 dry-run + 显式 confirm；失败不标 processed
- [x] summary/note/artifact 索引、brief 更新、turn `processed_at/summary_id/state=processed`
- [x] summary 加入 FTS 检索与 `memory_get(S-...)`；`stats` 增加 summaries/processed_turns
- [x] CLI `compress --dry-run/--confirm` 与 API `GET /v1/compress/preview`、`POST /v1/compress`
- [x] 左侧栏「秘书办公室」独立面板（项目/brief/搜索/最近/压缩/归档/回收站/角色/建议）+ 同源 `/office-console/api` 代理
- [ ] 刷新页面确认视觉/交互（页面已加载，`/office-console/api` 已 200）

验证：84 Python tests + 15 Node tests 通过；真实 dsh-team 项目 dry-run 已验证（不会写入）。`core_llm` 预留，当前规则引擎是自动降级路径。规则引擎暂不抽 artifact、不做决策冲突 supersede；这两项留到 M2 质量迭代/M3。控制台 404 已修复：host 行 office-core 重新启用，路由延迟注册；当前 projects/stats/roles/preview 均 200。

### M3（冷备 + advisor）— 🟡 冷层完成，advisor 最小闭环完成，真实 session_search 待验收

- [x] 冷层归档：已压缩 turn 原文写 `cold/<project>/T<id>.json.gz`，写 `cold_index`，清热字段/消息/FTS，state=`cold`
- [x] 冷层读取：`memory_get(T...)` 解压读回；默认搜索/最近排除冷层
- [x] 回收站 purge 连带删除冷文件与 `cold_index`
- [x] CLI `archive --project [--now]`、API `POST /v1/archive`、控制台“归档已压缩原文”
- [x] advisor 根会话预设、只读 transcript（`@deepseek-ai/dsh-tool-session-query`）、只读 memory 工具、`submit_advice` 建议 inbox；**顾问与用户直接对话，ES 不可见**；用户采纳后只追加 `advice.accepted` 的 hot turn（未压缩），不自动写 brief/note、不触发 compress；pending/拒绝不进 ES
- [ ] advisor 自动通知（下一轮主动注入未读建议）仍是 brief 一行，未做独立通知通道
- [ ] 冷层慢搜 `scope=all`（可选，当前只按 id 精确读）

验证：84 Python tests + 15 Node tests 通过；冷层归档/读取/purge、advisor 只读工具/建议 inbox 已有单测与 API 测试。

### M4（GM / 部门 / worker）— 🟡 预设已声明，待真实委派验收

- [x] ES 预设挂 `gm` subagent 工具；GM 挂 `dm`；DM 挂 `worker`；`maxDepth=3`
- [x] ES 自动收到项目 brief（≤400 字）；ES/GM/DM 挂 `list_agents`/`send_message`/`interrupt_agent`，可监控/纠偏下级
- [x] worker 预设挂 `fs/run/sh/pwsh`；GM/DM 不挂文件/命令，只负责拆解/验收
- [x] 适配器收录 `secretary` + `gm` 的 turn（ES↔GM 报告进主记忆）；DM/worker 不收录
- [ ] 真实 ES→GM→DM→worker 委派、完成通知、报告链验收
- [ ] 角色/模型策略（控制台可写）、预算/权限

验证：84 Python + 15 Node 测试；适配器已有 GM 收录/排除 DM 的单元测试。

---

## 15. 风险与待验证

1. `session/event` 实际字段/顺序；适配器先用 raw_event 兜底。
2. `subagent/end` 的 payload 与完成唤醒；M1b 先验证，失败退回“用户下次问再报”。
3. DSH Python 路径变化；`doctor` + 系统 Python 兜底。
4. 单实例/端口/杀进程残留；`.run/core.json` + pid 检查。
5. DSH 的 `desktop` profile 与 agentkit 共存；已移除 team bundle，安装后跑一次冲突检查。
6. 逐子会话权限（M2 以后）；M1 不涉及。
7. 手动压缩大积压成本/质量（M2）；必须 dry-run + 分批 + 可取消。
8. 回收站 purge 与冷层/备份的边界（M3）；M1 只处理热层。

---

## 16. 一句话

**M1 只做“记得住”：独立核心 + 自动收录 + bigram 检索 + 回收站；不碰编排、不碰控制台、不碰冷备。**
