# 秘书办公室（secretary-office）

DSH 上的「执行秘书 + 项目记忆」实现。当前：**M1a/M1b 完成；M2 控制台可用；M3 冷层 + advisor 最小闭环完成；M4 GM/部门经理/worker 预设已实现，待重启验收**。

## 执行秘书定位

执行秘书不是传声筒，而是**与用户同一层的全局把控者**：

- 像用户一样看项目简报、目标、决策、未决项；顾问对话不可见，用户采纳的建议才进入未压缩历史；
- 决定路线、下发指令给 GM，验收 GM 报告，发现偏差就纠正/叫停；
- 比 GM 更总览全局：GM 只看一棵任务树，ES 看项目记忆、用户意图、顾问意见和跨会话状态；
- 主动维护自己的上下文：只保留 brief、GM 报告、决策和证据，不把 DM/worker 的完整过程塞进上下文；
- 通过 `list_agents` / `send_message` / `interrupt_agent` 监控和纠偏 GM，而不是 fire-and-forget。
- **不直接读 GM 的完整会话**，只接收 GM 的 brief/报告；`list_agents` 用来判断 running/inactive，失败原因看完成通知/报告。
- GM 停了用 `send_message` 唤醒/补指令；要终止整个 GM 任务，用 `list_agents({scope:"descendants"})` 看全树后逐层 `interrupt_agent`（interrupt GM 只停当前轮，后代不会自动停）。

实现上：ES 预设自动注入项目 brief（≤400 字），并挂 subagent 控制工具；GM/DM 也有同样的下级控制工具。历史“3 个工具 vs 8 个工具”的原话是同会话切换工具集的调试现象，不作为 ES 能力判断依据。

## 先读

- [v1-spec.md](docs/v1-spec.md) —— M1 的唯一执行口径（范围、数据模型、API、CLI、工具、任务清单）。
- [dsh/README.md](dsh/README.md) —— M1b 适配器：安装、预设、验收、排错。
- 设计背景：[dots-office-architecture.md](../dots-office-architecture.md)、[secretary-memory-design.md](../secretary-memory-design.md)、[decoupled-architecture.md](../decoupled-architecture.md)、[bigram-evaluation.md](../bigram-evaluation.md)。

## 当前状态

| 阶段 | 状态 |
|---|---|
| M1a 核心（无 DSH 可跑） | ✅ 已实现：SQLite/bigram FTS、raw event、归一化、5 个工具、HTTP API、CLI、回收站、审计、迁移/日志/备份 |
| M1b DSH 薄适配器 | ✅ 冒烟通过：8 个工具可见；5 条真实 turn 自动入库；重启后 T1 回填、T2 继续收录；20-turn soak 待做 |
| M2 控制台 + 手动压缩 | 🟡 核心压缩 + CLI/API + 左侧栏「秘书办公室」独立面板；`/office-console/api` 200；左侧栏截图确认 |
| M3 冷层 + advisor | 🟡 冷层归档/读取/purge 完成；advisor 根会话预设 + 只读 transcript/记忆 + advice inbox 已完成（自动提醒仅 brief 一行） |
| M4 GM/部门/worker | 🟡 ES→GM→DM→worker 预设与 subagent 工具已声明；只有 GM turn 进主记忆；待重启做真实委派验收 |

M1a 验证：84 个 Python 测试通过；100 条 fake turn 验收：20/20 查询有结果，p95 ≈ 2–5ms，热库 250KB；覆盖 export、强制 purge、FTS rowid 清理、schema 迁移 v1→v11、日志、`--include-deleted` 与备份。
M1b 验证：13 个 Node 测试通过（turn 组装、核心启动、事件写入、回填、5 工具注册/执行、console proxy）；真实 DSH 会话已出现 8 个工具，核心收录 5 条 turn（T1 在重启后由回填写入，T2 重启后实时写入），raw_event 与 turn 均为 5、无重复。此前“只有 3 个工具”的根因是 DSH 要求工具声明 `output.render`；另支持会话中途切换预设（跟踪 `agent-preset/selected`）。
M2 验证：规则压缩器 `compress` 支持 dry-run/confirm、summary/note/brief/FTS/processed 状态；CLI 与 API 已接通；左侧栏「秘书办公室」独立面板已实现，`/office-console/api` 已返回 200（此前 404 是 `office-core` host 行未启用/注册失败，已修复并重新启用）；项目 dsh-team、T1/T2、搜索/预览入口由截图确认。当前 84 Python + 15 Node 测试通过。
M3 验证：`archive` 把已压缩 turn 原文写入 `cold/<project>/T<id>.json.gz`，写 `cold_index`、清空热字段/消息/FTS、`state=cold`；`memory_get` 从冷层读回，默认搜索/最近排除冷层，purge 连带删除冷文件与索引。advisor 与用户直接对话且 ES 不可见；用户采纳后只追加一条 `advice.accepted` 的 hot turn（未压缩），**不自动写 brief/note、不触发 compress**；pending/拒绝不进入 ES。84 Python + 15 Node 测试通过。
M4 验证：ES 预设新增 `gm` 工具；GM 预设 `dm` 工具；DM 预设 `worker` 工具；worker 挂 fs/run/sh/pwsh。适配器只收录 `secretary` 与 `gm` 的 turn（GM 的 user=ES brief，assistant=GM report），DM/worker 过程不进主记忆。预设已声明，待重启后真实委派验收。

## 快速开始

```bash
cd secretary-office/core

# 检查（Python / SQLite FTS5 / 数据目录 / DSH Python 候选）
python -m secretary_core --data-dir "D:/tmp/office" doctor

# 建项目、灌入 fake 事件、检索
python -m secretary_core --data-dir "D:/tmp/office" init --project demo --workspace "D:/work/demo"
python -m secretary_core --data-dir "D:/tmp/office" ingest --project demo --file tests/fixtures/events.jsonl
python -m secretary_core --data-dir "D:/tmp/office" search "窗口 两级" --project demo
python -m secretary_core --data-dir "D:/tmp/office" stats --project demo

# 本地 HTTP API（写 .run/core.json，返回端口和 token），以及备份
python -m secretary_core --data-dir "D:/tmp/office" serve --port 0
python -m secretary_core --data-dir "D:/tmp/office" backup --label manual
```

- 默认数据目录：`%USERPROFILE%\.secretary-office`；可用 `--data-dir` / `SECRETARY_OFFICE_HOME` 覆盖。
- 核心只用标准库；DSH 自带 Python、系统 Python 均可运行。
- 无 DSH 依赖：`doctor`、`init`、`ingest`、`search`、`export`、`serve` 都可独立执行。

## 测试与验收

```bash
cd secretary-office/core
python -m unittest discover -s tests -v

cd ../dsh
node --test

cd ..
python scripts/acceptance.py
```

## 目录

```
secretary-office/
├─ docs/v1-spec.md          # M1 执行规格
├─ core/
│  ├─ secretary_core/      # 核心（不 import DSH）
│  │  ├─ schema.sql
│  │  ├─ db.py / tokenizer.py / search.py
│  │  ├─ events.py / tools.py / recycle.py
│  │  ├─ server.py / cli.py / config.py / logging_setup.py
│  └─ tests/
├─ scripts/
│  ├─ acceptance.py
│  └─ bench_memory_contentless.py
└─ dsh/                      # @local/dsh-office M1b bundle（已装进 desktop profile）
   ├─ README.md
   ├─ package.json
   ├─ cordis.patch.yml       # office-core host 行 + preset-secretary
   ├─ index.js / tools.js / client.js
   ├─ lib/                   # core manager / client / turn 组装 / project / console proxy
   └─ tests/                 # node --test
```

## M1b 状态

1. ✅ `@local/dsh-office` bundle 已装进现有 `desktop` profile（不新建 profile）；
2. ✅ host 适配器订阅 `session/event`，把 ES 会话写入核心 `raw_event`；
3. ✅ 用 `sessionQuery` 回填、核心侧幂等；
4. ✅ 5 个工具挂到 `secretary` 预设（主包 `mode: tools`；DSH `register` 所需 `output.render` 已补）；
5. ✅ 真实 ES 会话冒烟：8 tools、5 turns、重启后回填 T1；⏳ 20-turn soak 与“ES 主动调用 memory_search”观察待做。

注意：安装后插件管理器提示需要重启；核心进程已被拉起，但预设/工具以重启后加载为准。

## M2 手动压缩 + 控制台

```bash
# 预览（默认就是 dry-run，不写库）
python -m secretary_core --data-dir "C:/Users/you/.secretary-office" compress --project dsh-team --batch 20

# 确认写入：summary + notes + brief，并把 turn 标 processed
python -m secretary_core --data-dir "C:/Users/you/.secretary-office" compress --project dsh-team --batch 20 --confirm
```

规则压缩器只做保守提取（明确决策/偏好、带数字的完成项、未决问题），不调用 LLM；预览结果里能看到将要写的 notes 和 brief。API 对应 `GET /v1/compress/preview` 与 `POST /v1/compress {confirm:true}`。

## 任务板

项目任务板是**列表**，每条属于一个分区：

- **长远规划**（long_term）
- **阶段目标**（stage）
- **当前任务**（current）

每条有标题、详情、状态：

- `active` 进行中
- `done` 已达成
- `suspended` 已挂起

操作：

- **用户**：控制台「任务板」列表点击标题编辑；每条可「达成 / 挂起 / 恢复 / 移除」；也可新增；
- **ES**：`taskboard_read`、`taskboard_add`、`taskboard_update`、`taskboard_remove`；
- **顾问 / GM / DM**：`taskboard_read` 只读；DM 是可见性最下层；
- worker 不挂任务板。

API：`GET /v1/taskboard?project=...` 返回 `{items:[...]}`；`POST /v1/taskboard`：
`{project,section,title,detail}` 新增、`{project,id,title?,detail?,status?}` 编辑/改状态、`{project,id,remove:true}` 移除。标题 ≤500，详情 ≤4000。

## 项目约定（独立）

项目约定是**独立栏目**，不在任务板里。每条有：

- `kind`：`avoid` 应避免 / `follow` 应遵循
- `title` / `detail`
- `status`：`active` / `suspended`

操作：

- **用户**：控制台「项目约定」列表点击标题编辑；可新增、挂起、恢复、移除；
- **ES**：`convention_read`、`convention_add`、`convention_update`、`convention_remove`；
- **顾问 / GM / DM**：`convention_read` 只读；
- worker 不可见。

API：`GET /v1/conventions?project=...`；`POST /v1/conventions` 新增/编辑/挂起/移除。

## 人员架构与预设

控制台「人员架构」tab 以树展示当前项目会话/代理：

- 根节点是 ES / 顾问等主会话；
- 子节点按 `parentSessionId` 展开 GM → DM → worker；
- 每个实例有**可编辑的自定义名字**（一个 preset 可建多个实例）；
  - 默认名字自动生成：`预设名 + 序号`，如“执行秘书1”“通用环境2”；
  - 点击名字或「改名」可编辑，保存到 `agent_name` 表；
  - 右侧仍显示 preset 名；
- 节点显示“自定义名字 · 会话标题”；会话标题来自 DSH `session/title`；
- blank/空会话不进入树，避免重复项；
- 「查看预设」读取该 agent 的 preset YAML 组成；
- 「进入会话」用 DSH `uiWorkspace.openSession(sessionId)` 直接打开该会话。

「角色」tab 现在同时管理预设：

- **项目自定义预设**默认列在「项目自定义预设」，存 `project_preset` 表；
  - 导入 `.yml` 只写入项目表，**不会自动进入全局 preset registry**；
  - 项目预设可查看、导出；
- **已安装项目预设**（`secretary/gm/dm/worker/advisor`）单独标注；
- **全局预设**只有非项目来源的 registry 条目；
- DSH preset registry 本身只读；项目草稿要真正参与 agent，需要显式安装/重载，控制台不会自动提升到全局。

API：

- `GET /office-console/api/org?project=...`
- `GET /office-console/api/presets`
- `GET /office-console/api/presets/{id}`
- `POST /office-console/api/presets/import`
- `GET /office-console/api/agent-names?project=...`
- `POST /office-console/api/agent-names` → `{project,session_id,name}`
- `GET /office-console/api/project-presets?project=...`
- `POST /office-console/api/project-presets` → 项目本地预设，不自动全局

控制台入口：DSH 左侧栏的「秘书办公室」图标（独立主面板，不再藏在设置里）。页面提供项目切换、简报、记忆搜索、最近、压缩预览/确认、归档已压缩原文、回收站、角色、人员架构、顾问建议、任务板和项目约定。控制台通过同源 `/office-console/api` 代理访问核心，不把 token 暴露给浏览器。



## M3 冷层

```bash
# 只归档已压缩、且超过 24h 宽限期的 turn
python -m secretary_core --data-dir "C:/Users/you/.secretary-office" archive --project dsh-team

# 忽略宽限期（测试/手动整理）
python -m secretary_core --data-dir "C:/Users/you/.secretary-office" archive --project dsh-team --now
```

- 原文写到 `cold/<project>/T<id>.json.gz`；`cold_index` 记录文件/长度/sha256；turn 只留元数据 + `cold_ref`，state=`cold`。
- 默认搜索/最近不碰冷层；`memory_get(T42)` 自动从冷文件读回。
- purge 连带删除冷文件和 `cold_index`。
- `backup` 目前只快照 SQLite；冷层原文在 `cold/`，需要单独打包/备份（M3 后续可加统一导出）。
- 控制台「压缩」页有“归档已压缩原文”按钮。
- **advisor 最小闭环**：新会话选「顾问」预设（同工作区）→ 与用户直接深聊；`session_search`/`session_event_read` 读完整 ES↔用户历史 + `memory_*` 读项目记忆 + `submit_advice` 写建议；不挂 fs/shell，不写主记忆。**ES 看不到顾问与用户的对话，也看不到未采纳建议**；建议进入独立 `advice` 表，控制台由用户采纳/不采纳；用户采纳后只生成一条 **未压缩的 turn**（`event_type=advice.accepted`，`state=hot_raw`，`processed_at=NULL`），ES 用 recent/search 可见；**不自动写 brief/note，也不触发 compress**。

## M4 GM / 部门 / worker

预设链：

```text
ES（secretary）--gm--> GM --dm--> 部门经理 --worker--> worker
```

- ES 用 `gm` 工具下发 brief；GM 用 `dm` 工具拆部门任务；DM 用 `worker` 工具拆单一任务。
- worker 挂 `fs/run/sh/pwsh`，只做被分配的任务并回报证据。
- GM/DM 不直接碰文件/命令；需要用户拍板时在报告里写 `needs_decision`。
- 只有 `secretary` 和 `gm` 的 turn 进主记忆；DM/worker 过程不收录。
- ES 自动收到项目 brief（≤400 字）；ES/GM/DM 都挂 `list_agents` / `send_message` / `interrupt_agent`，可以监控和纠正下级；subagent 是受管理的，不是一次性转发。
- 预设已声明，待重启 DSH 后做真实委派验收（`maxDepth=3`）。
