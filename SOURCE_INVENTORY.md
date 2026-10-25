# 秘书办公室 (secretary-office) 源码缺口清单

> 生成时间：2026-10-25
> 来源：从 winfr 恢复出的 7 个测试文件 + 13 个设计文档反推
> 原路径：`D:\a\dsh\team\`（**注意：这个位置在 DSH 安装目录内，每次更新都会被删，恢复后务必移出去**）

## 一、已恢复（22 个文件，281KB）

| 目录 | 内容 |
|---|---|
| `docs/` | 13 个设计文档（见下） |
| `tests/` | 7 个 Node 测试（API 契约的唯一权威来源） |
| `config/pyproject.toml` | Python 包配置（secretary-core 0.5.10-m4） |
| `fixtures/events.jsonl` | 测试用事件样本 |

### docs/ 说明
- `README_23.md` —— 主 README（秘书办公室概述）
- `README_22.md` —— `@local/dsh-office` 宿主适配器说明
- `v1-spec.md` —— v1 规格（M1 唯一执行口径）
- `TASKS.md` —— 任务面板（M1–M4 进度，含已完成的 12 项）
- `decoupled-architecture.md` —— 核心/适配器/控制台解耦架构
- `dots-office-architecture.md` —— 执行秘书-总经理-部门多代理架构
- `secretary-memory-design.md` —— 永久记忆与工具设计
- `bigram-evaluation.md` —— 中文 bigram 检索评估
- `dsh-rc3-compatibility.md` —— DSH 0.2.1-rc.3 兼容性检查
- `project-current-review.md` / `project-current-review-fixes.md` / `project-goal-results-review.md` —— 三轮复审
- `SKILL_5.md` —— office-render skill（文档渲染）

## 二、缺失源码（需恢复或重建）

### JS 插件（@local/dsh-office）
| 文件 | 导出 | 职责（来自测试） |
|---|---|---|
| `index.js` | `apply(ctx, opts)` | 宿主适配器：监听 `session/event`、注册 `systemPrompt` 上下文（含"项目简报"）、用 `sessionQuery` 回填历史、写 `<dataDir>/.run/core.json`。opts: `{coreDir, dataDir}` |
| `tools.js` | `apply(ctx, opts)` | 按角色注册工具。opts: `{dataDir, role}` |
| `lib/core.js` | `CoreManager`, `pythonCandidates` | `CoreManager({coreDir,dataDir})`: `start()/sendRawEvent()/request(method,path,body)/dispose()`；`pythonCandidates(env)` 返回候选 Python 路径数组 |
| `lib/client.js` | `CoreClient` | `CoreClient({dataDir})`: `ensure()/request()` |
| `lib/console-proxy.js` | `registerConsoleRoutes(webServer, manager, helpers)` | 注册路由 `/office-console/api`，白名单端点见下 |
| `lib/project.js` | `projectForCwd(cwd)`, `readProjectConfig(cwd)` | 读 `.dsh/office.json` 的 `project`；否则用目录名（非法字符替换为 `-`） |
| `lib/turns.js` | `TurnBuffer`, `eventsToEnvelopes` | 事件折叠：丢 reasoning / time-context，保留 user/assistant 文本；按 preset 定 role；`targetPresets` 过滤 |
| `client.js`（根） | — | UI 模块：`window.__ModuleLoader__.load({id:'@local/dsh-office', factory})`；factory 注入 `['slots','locale','uiWorkspace']`；注册 `main`(key=`office-console`) + `sidebar.panellist`(id=`office-console`) |
| `package.json` | — | 插件清单（未恢复） |

### 工具清单（按角色）
- **secretary（全量）**：`memory_search` `memory_get` `memory_recent` `memory_note` `memory_brief` `taskboard_read` `taskboard_add` `taskboard_update` `taskboard_remove` `convention_read` `convention_add` `convention_update` `convention_remove`
- **advisor（只读+建议）**：`memory_search` `memory_brief` `taskboard_read` `convention_read` `submit_advice`
- **gm / dm（只读）**：`taskboard_read` `convention_read`
- 所有工具必须声明 `output.render`

### 控制台 API（`/office-console/api/*`）
`GET /projects`、`GET /org?project=`、`GET /presets/:id`、`GET /summarize/preview`、`POST /summarize`、`GET|POST /taskboard`、`GET|POST /conventions`、`POST /archive`、`POST /advice`、`POST /advice/:id/delivered`、`POST /advice/:id/decision`；未知路径 → 404

### Python 包（secretary_core/）
| 文件 | 说明 |
|---|---|
| `secretary_core/cli.py` | 入口 `main`（pyproject `[project.scripts]` 指向） |
| `secretary_core/schema.sql` | 包数据（SQLite schema） |
| 其余模块 | 未知（未恢复）。须实现核心 REST：`GET /v1/search?project=&q=` → `{results}`；`POST /v1/summarize` → `{status:'ok', summary_id}`；`POST /v1/advice/:id/decision` → `{status}`；事件入库、FTS、note(N- 前缀)、taskboard、convention、advice(A- 前缀)、archive/purge |

### 数据/ID 约定（来自测试）
- note id 以 `N-` 开头；advice id 以 `A-` 开头
- 数据目录默认 `%USERPROFILE%\.secretary-office`
- 事件 envelope：`{source, source_version, event_type, external_session, external_seq, project, occurred_at, payload:{role,preset,user_text,assistant_text}}`
- 项目配置：`<workspace>/.dsh/office.json` → `{"project": "..."}`

## 三、恢复路径（二选一）

### A. 用 winfr regular 模式找回源码（保留原样，最优）
管理员身份运行：
```
winfr D: C:\RecoveredTeam2 /regular /n \a\dsh\team\
```
- regular 模式按 MFT 恢复，能捞回 extensive 模式跳过的 `.py/.js/.json` 文本文件
- 只扫 `\a\dsh\team\`，输出很小
- 前提：这些文件的 MFT 记录尚未被覆盖（删于 10-23，越快越好）

### B. 按本清单从测试+文档重建（保底）
7 个测试文件是完整的 API 契约，可据此重写 JS 插件 + Python 核心。工作量较大，且是"功能等价的新实现"，非原文件。

## 四、重要教训
**不要把项目放在 `D:\a\dsh\` 下** —— 那是 DeepSeek Harness 的安装目录，electron-builder 更新时会整体替换并删除非清单文件。恢复后请放在 `D:\secretary-office\`（当前整合位置）等独立目录，并纳入 git 管理。
