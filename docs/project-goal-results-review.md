# 项目目标与当前成果审核报告

审核对象：`secretary-office/` 及根目录设计、评测脚本  
审核方式：规格比对、源码审阅、测试/验收复跑、关键缺陷最小复现  
结论日期：本次审核

> 更新（M1a 收口后）：审核报告第 4–5 节列出的第一组高/中优先级问题已修复。当前 45 个单元/接口测试全部通过；强化 acceptance 覆盖 20/20 查询、export、强制 purge 与 FTS rowid 清理。以下正文中的 39 tests 与缺陷复现结果为修复前证据，保留用于追溯。
>
> **第二轮更新（工程底座）**：第 5 节第二组已补齐——schema v1→v2 迁移（迁移前自动备份）、文件日志/轮转、`--include-deleted`、工具限长、`backup` 命令、contentless 评测复现脚本；当时 **51 tests** 通过。M1b 随后开始。
>
> **第三轮更新（M1b）**：`@local/dsh-office` 适配器已实现并安装进 `desktop` profile：host 启动独立核心、`session/event` 采集、`sessionQuery` 回填、5 个工具 + `secretary` 预设；13 个 Node 测试通过。修复 `output.render` 缺失（此前只剩 3 个全局工具）与会话中途切换预设的 `agent-preset/selected` 跟踪。真实冒烟：DSH 会话显示 8 个工具；核心收录 5 条 turn，T1/T2 在重启后回填、实时写入，raw_event/turn 均为 5 无重复。20-turn soak 与 ES 主动 `memory_search` 观察待做。
>
> **第四轮更新（M2）**：规则梳理器 + dry-run/confirm + summary/query/`processed` 状态 + brief/note/FTS；CLI/API 接通。设置页「秘书办公室」控制台（项目、搜索、最近、梳理、回收站、角色只读）与同源 `/office-console/api` 代理已实现。75 Python + 13 Node 测试通过；控制台页面已加载并截图确认项目/统计/搜索/tab，初次 404 已修复（office-core host 行重新启用、路由延迟注册），projects/stats/roles/preview 均 200。
>
> **第五轮更新（M3）**：冷层完成（processed turn → `cold/<project>/T<id>.json.gz` + `cold_index`；`memory_get` 读回；默认搜索/最近排除冷层；purge 连带删冷文件）。advisor 最小闭环完成：新增「顾问」预设（同工作区根会话），只读 memory + session-query transcript + `submit_advice`；建议进独立 `advice` 表，控制台建议页可查，ES brief 显示一行；advisor 不写主记忆/无 fs/shell。75 Python + 13 Node 测试通过。剩余：20-turn soak、advisor 自动通知、GM/部门/worker 真实委派验收。
>
> **第六轮更新（M4）**：ES→GM→DM→worker 预设链已声明：ES 挂 `gm`，GM 挂 `dm`，DM 挂 `worker`，worker 挂 fs/run/sh/pwsh；GM/DM 只拆解/验收，不碰文件；适配器只收 `secretary` + `gm` 的 turn，DM/worker 过程不入主记忆。预设待重启后做真实委派验收；角色/模型策略仍待控制台可写。
>
> **第七轮更新（可用性/顾问检索）**：控制台从设置页移到**左侧栏独立主面板**（`sidebar.panellist` + `main`）；顾问 `session_search` 报 disabled 的根因是 base/Web 把 `session-query-sqlite` 设为 `openAt: never`，已在 profile patch + bundle patch 覆盖为 durable path + `first-search`，首次搜索会建 `~/.dsh/session-search.db`。待顾问会话重试和侧栏面板验收。

---

## 1. 结论摘要

项目当前目标是 M1 的“记得住”：

- 独立 Python 核心服务；
- SQLite + bigram FTS；
- 原始事件仓与归一化；
- 5 个记忆工具；
- HTTP API、CLI、回收站与审计；
- 后续通过 M1b 薄适配器接入 DSH，自动收录真实执行秘书会话。

审核结论：

1. **M1a 的功能骨架已经真实闭环**。SQLite/FTS、事件收录、5 个工具、HTTP token、CLI、回收站、审计均可运行；39 个单元/接口测试全部通过。
2. **M1b 尚未实施**，因此系统还不能证明“真实 DSH 会话自动入库、重启回填、工具可用”的端到端目标。
3. **M1a 无阻断项，但不建议直接进入真实高频使用**。当前存在 turn 层重复入库、删除联动缺失、purge/FTS 清理不完整、服务停止残留等问题。
4. 建议完成度判断：
   - **M1a 功能完成度：约 85%**；
   - **M1 总体完成度：约 60%**；
   - **生产可用度：未达标**，主要缺口是 M1b 与真实数据验收。

建议先完成 4 项收口：turn 幂等约束、turn 删除联动 note、purge 清理 FTS、serve 关闭逻辑；然后开始 M1b。

---

## 2. 项目目标核对

`secretary-office/docs/v1-spec.md` 冻结的 M1 目标是：

> M1 只做“记得住”：独立核心 + 自动收录 + bigram 检索 + 回收站；不碰编排、不碰控制台、不碰冷备。

### 2.1 M1a 范围

规格要求：

- SQLite schema、迁移、WAL、bigram FTS；
- 原始事件仓和归一化；
- HTTP API 与本地 token；
- `memory_search`、`memory_get`、`memory_recent`、`memory_note`、`memory_brief`；
- CLI；
- 回收站与审计；
- fake 事件源与完整测试；
- 核心代码不 import DSH。

### 2.2 M1b 范围

规格要求：

- `@local/dsh-office` bundle 安装进现有 `desktop` profile；
- 订阅 `session/event` 自动收录 ES 会话；
- 使用 `sessionQuery` 回填；
- 5 个工具挂到 `secretary` 预设；
- 真实会话端到端验证：自动入库、检索、重启/回填不丢。

当前目录中没有 `secretary-office/dsh/`、host 适配器、bundle、preset 接入代码，因此 **M1b 尚未开始**。

---

## 3. 已验证成果

### 3.1 单元/接口测试

执行命令：

```bash
cd secretary-office/core
python -m unittest discover -s tests -v
```

结果：

```text
Ran 39 tests in 17.489s
OK
```

覆盖内容包括：

- FTS5 与项目表；
- raw event 幂等与失败事件保留；
- 中文 bigram 检索；
- 5 个记忆工具；
- HTTP 鉴权与 API；
- CLI；
- 回收站、还原、purge；
- tokenizer、snippet、限长等。

### 3.2 M1a 验收脚本

执行命令：

```bash
cd secretary-office
python scripts/acceptance.py
```

本次结果：

```json
{
  "status": "ok",
  "turns": 100,
  "ingest_ms": 229.6,
  "queries": 20,
  "nonempty_queries": 20,
  "search_p50_ms": 5.91,
  "search_p95_ms": 10.57,
  "max_snippet_chars": 56,
  "restart_ok": true,
  "db_bytes": 249856,
  "after_restart_turns": 100
}
```

这证明 fake 数据下：

- 100 个 turn 可入库；
- 20 个查询均有结果；
- 重启后数据仍可查；
- 搜索延迟远低于 100ms 目标；
- 热库体积约 250KB。

### 3.3 无 DSH 依赖

源码检索未发现核心包 import DSH、Cordis 或 DeepSeek Harness 包。对 DSH 的使用仅限于文件路径探测，例如：

- `config.py` 读取 `DSH_HOME`；
- 探测 `~/.dsh/dsh-runtimes/.../python.exe`。

因此“DSH 损坏后仍可用 CLI 查询/导出”的核心隔离原则基本成立。

---

## 4. 关键问题与复现证据

本次编写并执行了最小复现脚本：

```bash
python out/verify_m1a_issues.py
```

### 4.1 高优先级：turn 层缺少业务幂等约束

位置：

- `secretary-office/core/secretary_core/events.py:14`
- `events.py:135-151`

问题：

- raw event 的唯一键包含 `event_type`；
- `turn.completed` 和 `turn.recorded` 都属于支持事件；
- 同一外部 turn 如果以两种事件类型到达，会生成两条 turn 和多条 message。

复现结果：

```json
{
  "first": {"status": "ok", "turn_id": 1},
  "second": {"status": "ok", "turn_id": 2},
  "turn_rows": 2,
  "message_rows": 4
}
```

影响：

- 实时事件与回填并发时可能产生重复记忆；
- recent/search 出现重复条目；
- `turn_no` 当前用 `COUNT(*) + 1` 计算，乱序或重复到达时也可能重号。

最小修复：

1. 增加 turn 层唯一约束：

```sql
CREATE UNIQUE INDEX ux_turn_session_seq
ON turn(session_id, seq)
WHERE deleted_at IS NULL;
```

2. 归一化时使用 `INSERT OR IGNORE` 或插入前查询；
3. 命中重复时返回 `duplicate`，不再写 message/FTS；
4. `turn_no` 改为当前 session 的 `COALESCE(MAX(turn_no), 0) + 1`。

### 4.2 高优先级：软删 turn 不联动 note

位置：

- `secretary-office/core/secretary_core/recycle.py:91-97`

规格要求：删除 turn 时，关联自动 note 标记为 `source_deleted`，进入 M2 控制台复核。

复现结果：

```json
"note_status_after_turn_soft_delete": "active"
```

影响：来源 turn 已进入回收站，但相关 note 仍以 active 状态参与检索，可能继续传播已删除上下文。

最小修复：

```sql
UPDATE note
SET status = 'source_deleted'
WHERE project_id = ?
  AND source_turn = ?
  AND deleted_at IS NULL;
```

该更新应与软删 turn 放在同一事务并写审计。还原 turn 时不建议自动恢复 note，留给 M2 控制台复核。

### 4.3 中优先级：purge 不清理 contentless FTS 行

位置：

- `secretary-office/core/secretary_core/recycle.py:91-101`

当前 purge 删除 `turn`/`note` 等业务表，但没有删除 FTS rowid。

复现结果：

```json
"turn_fts_rows_before_purge": 2,
"turn_fts_rows_after_purge": 2
```

影响：

- contentless FTS 中残留脏 rowid；
- FTS 库持续膨胀；
- BM25 文档统计可能被污染。

最小修复：purge turn/note 时同步删除 FTS：

```sql
INSERT INTO turn_fts(turn_fts, rowid, body)
VALUES('delete', ?, NULL);

INSERT INTO note_fts(note_fts, rowid, body)
VALUES('delete', ?, NULL);
```

### 4.4 中优先级：`purge --now` 语义未真正实现

位置：

- `secretary-office/core/secretary_core/recycle.py:104-137`
- `secretary-office/core/secretary_core/cli.py:262-276`

`recycle.purge()` 接收 `now` 参数，但函数内部始终按 `purge_after <= now_ms()` 过滤。默认保留 30 天时，即使调用 `purge --now` 也不会立即清理未到期记录。

复现结果：

```json
{
  "status": "purged",
  "counts": {"turn": 0, "note": 0, "artifact": 0},
  "live_turns_after_purge_now": 2
}
```

最小修复：

- `now=True` 且未指定具体记录时，对所有 `deleted_at IS NOT NULL` 的记录执行强制 purge；
- 或明确引入 `--force`，避免误把普通到期清理变成强制清理。

### 4.5 中优先级：serve 同线程 shutdown 可能死锁

位置：

- `secretary-office/core/secretary_core/server.py:401-409`

当前 `serve()` 在 `serve_forever()` 所在线程捕获中断后，又在 finally 中调用 `httpd.shutdown()`。Python 文档不建议在 serve_forever 所在线程调用 shutdown。

影响：

- Ctrl+C 或宿主停止时可能卡住；
- `.run/core.json` 不清理；
- 后续启动误判已有实例或需要人工清理。

最小修复：

- 独立守护线程调用 `shutdown()`；
- 或 finally 中只执行 `server_close()` 与 `clear_run_info()`，不调用同线程 `shutdown()`。

---

## 5. 其他规格缺口

### 5.1 验收脚本口径不完整

位置：`secretary-office/scripts/acceptance.py`

问题：

- docstring 声称覆盖 export/purge；
- 实际没有断言 export 文件；
- 没有执行 purge；
- 通过门槛是 `nonempty >= 15`，但文档声称 20/20。

本次运行确实得到 20/20，但这是结果，不是脚本的严格验收条件。

建议：

- 门槛改为 `nonempty == 20`；
- 增加 export 文件存在、JSONL 行数和可解析校验；
- 增加一次到期 purge 或强制 purge 测试。

### 5.2 缺少迁移机制

位置：`secretary-office/core/secretary_core/db.py:36-57`

当前初始化依赖 `CREATE TABLE IF NOT EXISTS` 和 `CREATE INDEX IF NOT EXISTS`，没有基于 `schema_version` 的前向迁移步骤。旧库需要加列、改索引时无法升级。

建议：

- 读取 `meta.schema_version`；
- 维护版本号到迁移函数的映射；
- 迁移前备份数据库；
- 迁移后更新版本号。

### 5.3 缺少文件日志与轮转

规格要求 `logs/core.log`，当前主要依赖 stdout，且 HTTP handler 静默访问日志。后台隐藏运行后排错信息不足。

建议使用标准库：

- `logging`；
- `RotatingFileHandler`；
- 输出到 `paths.logs / "core.log"`。

### 5.4 缺少 `--include-deleted`

规格要求 CLI 可查已删除数据，目前 search/get/recent 均硬编码排除 `deleted_at`。

建议为 search/get/recent 增加 `include_deleted` 参数，并在 CLI 暴露 `--include-deleted`。

### 5.5 限长细节与规格不完全一致

包括：

- `MAX_SEARCH_LIMIT = 8`，规格要求 search 默认最多 5 条；
- snippet 加省略号后可能达到 162 字；
- recent 的 user 和 assistant 各 120 字，单条合计可达 242 字；
- `memory_get` 只拼接 user/assistant，没有包含 brief/report message。

这些不是阻断项，但应在 M1a 收口时统一修正。

---

## 6. 评测证据审核

### 6.1 bigram 方向结论可信，但部分数字当前不可完全复现

输入语料存在：

```text
D:\dl\conversation-export-2026-10-15-to-2026-10-21.txt
```

复跑：

```bash
python bench_memory.py
```

得到：

- 消息数 1888；
- 文档数 1281；
- bigram 的 known-item 与自然问句表现明显优于 raw unicode61；
- bigram turn retrieval：hit1 36/60，hit5 49/60。

因此“bigram 明显优于原生 unicode61”的方向性结论成立。

### 6.2 存储数字与文档不一致

`bigram-evaluation.md` 声称：

- contentless bigram：1.74MB；
- raw：1.38MB；
- trigram：3.30MB。

但当前 `bench_memory.py` 创建的是包含 `docs` 表和普通 FTS 的库，并不是 contentless 索引。本次复跑结果为：

- raw：约 2.00MB；
- bigram：3.08MB；
- trigram：4.56MB。

当前工作区也没有保存 `bench_bigram_20k.db` 或对应的 20k 构造脚本，因此文档中的：

- 20k 查询 p50 32ms；
- p95 70ms；
- embedding/hybrid 的若干结果；

暂时不能仅凭当前脚本完整复现。

建议：

1. 将数据生成、建库、查询、结果保存拆成可重复脚本；
2. 在结果 JSON 中记录 SQLite 版本、Python 版本、索引类型、机器环境；
3. 明确区分“实测值”“外推值”“合成语料结果”；
4-07-29; restore 演练。当前只有目录创建，没有备份动作。M1 是否要求自动备份可再确认，但文档与实现应一致。

---

## 7. 建议的下一步顺序

### 第一组：M1a 收口，建议 0.5–1 天

1. 增加 `turn(session_id, seq)` 唯一约束和归一化幂等；
2. 修复 `turn_no` 生成；
3. 软删 turn 时联动 note 为 `source_deleted`；
4. purge 时删除对应 FTS rowid；
5. 修复 `purge --now` 或改名为明确的 force 语义；
6. 修复 serve shutdown 逻辑。

### 第二组：补齐工程底座，建议 0.5–1 天

1. 增加 schema migration；
2. 增加文件日志与轮转；
3. 增加 `--include-deleted`；
4. 修正所有工具限长；
5. 强化 acceptance：20/20、export、purge 都必须断言。

### 第三组：M1b 适配器，建议按规格 3–5 天

1. 建立 `@local/dsh-office` bundle；
2. 安装进现有 `desktop` profile；
3. 实现 Python locator 与核心进程管理；
4. 订阅 `session/event` 写入 raw event；
5. 使用 `sessionQuery` 回填；
6. 将 5 个工具桥接到 `secretary` 预设；
7. 用真实 ES 会话完成端到端验收。

### M1b 验收门槛

- DSH 启动后核心自动启动；
- 至少 20 个真实 ES turn 自动入库；
- ES 能检索历史内容；
- 重启 DSH 后数据可查；
- 回填不产生重复 turn/message；
- 5 个工具可见、可用；
- 关闭 DSH 后 CLI 仍可查询和导出；
- 不与 team/subagent 工具产生命名或能力冲突。

---

## 8. 最终判断

**当前成果不是空架子：M1a 的核心能力、测试和性能数据均有实证；但项目还没有完成 M1 的最终目标。**

在 M1b 未实施前，系统只能证明“fake 事件下核心可工作”，不能证明“DSH 中的执行秘书拥有持续、自动、跨重启的项目记忆”。

建议决策：

- **不要跳过 M1a 收口直接大规模使用或接入真实会话**；
- **先修高优先级幂等和删除联动问题**；
- **随后实施 M1b，并用真实 ES 数据重新做 30–50 题评测**；
- M2 控制台、M3 冷备和 advisor 继续后置，不应提前扩大范围。
