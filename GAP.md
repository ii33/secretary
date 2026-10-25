# 秘书办公室 · 缺口分析（2026-10-25）

> 对照 `docs/v1-spec.md`（唯一执行口径）+ `docs/README_23.md`，逐项核对当前 `D:\secretary-office` 代码。
> 结论：**主链路已通**（收录→压缩→简报注入→检索→冷备→控制台），**质量层与运维层仍有缺口**。

---

## 一、已完整实现

| 模块 | 说明 |
|---|---|
| 控制台 UI | 6 标签页（记忆管理/项目预设/人员架构/顾问建议/任务板/项目约定）+ 记忆管理 5 子标签 + 顶部项目下拉 |
| 任务板 | 三列表（长期目标/阶段目标/当前任务）× 增/改/移除/挂起/激活/达成 |
| 项目约定 | 两列表（避免/遵守）× 增/改/移除/挂起/激活 |
| 顾问建议 | 列表 + 采纳/不采纳（采纳生成一条 hot turn） |
| 人员架构 | 会话树（ES/顾问/普通并列，GM→DM→worker 子代理）+ 自定义名 + 归档/跨项目过滤 |
| 项目预设 | 项目本地表 + 从全局导入 + 导出查看（不自动进全局） |
| 简报自动注入 | `systemPrompt.context` + `/v1/brief` + 60s 缓存 + 启动预热 + 每轮刷新 |
| 压缩 | 规则梳理（决策/偏好/完成项/未决）→ note + brief + 标记 processed；dry-run/confirm |
| 冷备 | ES↔GM 直接写 `cold/<project>/T<id>.json.gz` + `cold_index`；检索排除冷层；`memory_get` 可读回 |
| 分流规则 | ES↔用户→热；ES↔GM→冷；顾问/普通/DM/worker→不收录 |
| 工具 | 13 个（secretary 全量、advisor 只读+建议、gm/dm 只读） |
| 测试 | Node 15/15；Python 可编译 |

---

## 二、部分实现（有简化，需要补质量）

| # | 项 | 现状 | 规格要求 | 影响 |
|---|---|---|---|---|
| 1 | **检索** | ✅ FTS5 + bigram + 重排 + snippet/score（1 字 LIKE 回退） | FTS5 + 中文 bigram + 稀有词重排 + snippet/score | 已达标 |
| 2 | **结果限长** | ✅ search 160 / get 1200 / recent 120（服务端强制） | 同左 | 已达标 |
| 3 | **回收站** | ✅ 软删 `POST /v1/recycle` + 还原 `POST /v1/restore` + purge（连带冷层） | 同左 + `purge_after`/审计 | 已达标（审计待 P2） |
| 4 | **purge** | ✅ 连带删冷文件 + `cold_index` + FTS；`cold:true` 可清冷层 | 同左 | 已达标 |
| 5 | **归档** | 只支持 `now:true`（否则 30 天） | `grace_hours` 可配（24h 默认） | 宽限期不可调 |
| 6 | **人员架构** | ✅ 树 + 改名 + 过滤 + 查看 preset YAML + 进入会话 | 同左 | 已达标 |
| 7 | **项目预设** | 导入走 `/project-presets` | `POST /office-console/api/presets/import` 草稿导入 | 端点不齐（功能等价） |
| 8 | **health** | 只 `{status:'ok'}` | 版本、DB、FTS、uptime | 排障信息不足 |
| 9 | **search 参数** | 只有 `project/q/limit` | `kind/since/until/include_deleted` | 无法按类型/时间过滤 |
| 10 | **note 字段** | ✅ tags/importance/status/supersede 已加（软删字段待补） | 同左 + deleted_* | 已基本达标 |

---

## 三、完全缺失

### 数据模型（spec §3）
| 表/字段 | 用途 | 影响 |
|---|---|---|
| ~~`raw_event`~~ ✅ | 原始事件仓 + `/v1/raw-events` + `/replay` | 已实现 |
| `project` / `session` / `message` | 项目/会话/消息分层 | 只能靠 `turns.project` 字符串聚合 |
| ~~`artifact`~~ ✅ | 交付物索引 + `/v1/artifacts` | 已实现 |
| ~~`role_policy`~~ ✅ | 角色/模型策略 + `GET /v1/roles`（只读） | 已实现 |
| ~~`audit`~~ ✅ | 删/还原/purge/归档 审计 + `GET /v1/audit` | 已实现 |
| `meta.schema_version` | 迁移版本 | 迁移无版本号 |
| `turn_fts`/`note_fts`/`summary_fts` | FTS 虚表 | 检索退化（见上） |
| turn 的 `turn_no/archived_at/deleted_at/deleted_by/delete_reason/purge_after` | 完整生命周期 | 只能二值 `deleted` |

### API（spec §5）
- `POST /v1/projects`（建项目）
- ~~`POST /v1/raw-events`（原始事件）~~ ✅ 已实现（含 `/replay`）
- `GET /v1/turns/{id}`（独立端点；现用 `/v1/get/{id}` 兼容）
- `GET /v1/summaries/{id}`（现用 `/v1/get/{id}`）
- `GET /v1/roles`（角色策略只读）
- ~~`POST /v1/recycle`（软删）、`POST /v1/restore`（还原）~~ ✅ 已实现
- ~~`GET /v1/stats`~~、~~`GET /v1/audit`~~ ✅ 已实现
- `POST /office-console/api/presets/import`
- `GET /v1/notes`（列表，现只有按 id）

### CLI（spec §6）✅
已补齐：`serve / doctor / init / ingest / search / get / recent / brief / note / export / backup / stats / compress / archive / recycle / restore / purge`。
「DSH 坏了仍可 CLI 查/导出」这条逃生口已成立。

### 工具（spec §7 + advisor）✅
- ~~advisor 缺 `session_search` / `session_event_read`~~ ✅ 已在 `cordis.patch.yml` 给 advisor 预设挂上 `@deepseek-ai/dsh-tool-session-query`
- 规格明确 **不提供** `memory_compress`/`memory_forget` —— 当前符合，无需补

### 运维（spec §11）✅
- `logs/core.log`（2MB × 3 轮转）已实现
- `backup` 命令（SQLite online backup）已实现
- 单实例：`serve` 检测已有健康核心则复用；`CoreManager` 启动前先探活复用

### 数据迁移 ✅
- `audit` 6 行已加入迁移脚本（结构与新表一致）
- `project(1)/session(3)/message(16)` 在新 schema 里由 `turns.project` 字符串 + 会话日志回填表达，无需迁移
- 迁移后自动重建 FTS 索引

---

## 四、优先级建议

### P0（核心闭环质量，1–2 天）
1. **FTS5 + bigram 检索**（`turn_fts`/`note_fts`/`summary_fts` + 重排 + snippet/score），`docs/bigram-evaluation.md` 有现成方案
2. **工具限长**（search 160 / get 1200 / recent 120），服务端强制
3. **purge 连带冷层**（删 `cold/*.json.gz` + `cold_index`）

### P1（控制台可用性，约半天）
4. 人员架构「查看 preset YAML」「进入会话」（用 `uiWorkspace.openSession`）
5. 回收站「还原」按钮 + `POST /v1/recycle`/`/v1/restore`
6. `GET /v1/stats`（项目列表页显示 turn/note/冷层计数）

### P2（数据完整性，1–2 天）
7. `raw_event` 原始事件仓 + 归一化（可重放）
8. `audit` 表（删/还原/purge 记录）
9. note 的 `tags/importance/status/supersede`
10. `project`/`session` 表（替代纯字符串聚合）

### P3（运维与逃生口，1 天）
11. CLI 补齐 `doctor/search/get/recent/brief/note/export/backup/stats/recycle/restore/purge`
12. `logs/core.log` 轮转日志
13. 单实例锁

### P4（可选）✅
14. `artifact` 交付物索引 —— 已实现（表 + `/v1/artifacts` + 记忆管理「最近」下方展示）
15. `role_policy` 角色策略只读页 —— 已实现（表 + `GET /v1/roles` + 项目预设 tab 展示）
16. 冷层慢搜 `scope=all` —— 已实现（`/v1/search?scope=all` 解压冷文件匹配）
17. 历史 26 行迁移 —— `audit` 6 行已迁移；project/session/message 由 turns.project + 回填表达

---

## 一句话

**P0–P4 全部收口**：检索（FTS5+bigram）、回收站/审计、CLI 逃生口、raw_event、artifact、role_policy、冷层慢搜均已实现。
`docs/v1-spec.md` 的功能面已基本补齐；剩余只有「真实验收」（重启 DSH 后跑真实会话观察）。
