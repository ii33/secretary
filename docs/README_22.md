# @local/dsh-office（M1b）

DSH 宿主适配器：给「执行秘书」预设提供项目记忆。

- 启动/复用独立的 Python `secretary-core` 进程（不把核心塞进 DSH）；
- 订阅 `session/event`，把 `secretary` 预设的 turn 收录为 `raw_event`；
- 启动时用 `sessionQuery` 回填历史；
- 在 `secretary` 预设里注册 5 个工具：`memory_search / memory_get / memory_recent / memory_note / memory_brief`。

核心代码仍是 `../core`，数据默认在 `%USERPROFILE%\.secretary-office`。

## 安装

本机已通过插件管理器安装到 `desktop` profile：

```text
@local/dsh-office 0.5.10-m4 <- D:\a\dsh\team\secretary-office\dsh
```

换机器/重装时，在 DSH 插件页安装这个目录（或 `plugin_manager install_bundle <目录>`），然后**重启 DSH** 一次，确保 host 行、预设与工具完整加载。

> DSH Desktop 0.2.1-rc.2 只认 `~/.dsh/profiles/desktop`，所以这里不新建 profile；bundle 装进现有 `desktop`。

## 使用前

工作区根目录放一个项目标记（没有也能跑，会退回目录名）：

```text
<workspace>/.dsh/office.json
{ "project": "coating-sim" }
```

然后在新会话的预设选择器里选「执行秘书」。

## 工作方式

1. host 行启动核心（若 `.run/core.json` 已存在且健康，就复用）；
2. `session/event` 里只处理 `header.agentPreset === 'secretary'` 的会话；
3. 每个 turn/end 生成一条 `turn.completed`：
   - 用户文本：只取 `source.kind === 'user'` 的消息；
   - 助手文本：只取 assistant message 的 `text` block，**不取 reasoning/tool**；
   - 发到核心 `/v1/raw-events`，核心按 `(session, seq, event_type)` 幂等去重；
4. 启动回填：`sessionQuery.listSessions` → `readSession` → 同样的 turn 组装；
5. 工具调用走核心 HTTP（127.0.0.1 + token），项目从当前会话 cwd 的 `.dsh/office.json` 解析。

## 测试

```bash
cd secretary-office/dsh
node --test
```

覆盖：turn 组装、reasoning/time-context 过滤、项目映射、核心进程启动、事件写入、回填、5 个工具注册与执行、console proxy 路由与确认压缩。需要本机有 DSH 自带 Python（测试会跳过没有 Python 的环境）。

## 验收（M1b 第四项，待重启后做）

1. 重启 DSH；
2. 在一个工作区（含 `.dsh/office.json`）新建会话，选「执行秘书」；
3. 发几轮消息；检查：
   - `%USERPROFILE%\.secretary-office\logs\core.log` 有记录；
   - `python -m secretary_core --data-dir "%USERPROFILE%\.secretary-office" stats --project <id>` 的 turn 数增加；
4. 问秘书「上次我们说过什么？」，它应调用 `memory_search`；
5. 重启 DSH，再问一次，数据仍在；
6. 用 `python -m secretary_core ... search ... --project <id>` 验证回填/去重。

## 控制台（M2）

重启 DSH 后，点击左侧栏的「秘书办公室」图标（独立主面板）：

- 项目切换、brief、记忆搜索、最近轮次；
- 「压缩」页先预览（dry-run），确认后才写 summary/notes/brief 并标 `processed`；
- 「任务板」列表由用户点击编辑/达成/挂起/恢复/移除；ES 有 `taskboard_add/update/remove`，顾问/GM/DM 只读，worker 不可见；
- 「项目约定」独立 tab：应避免/应遵循；用户/ES 可编辑/挂起/恢复/移除；顾问/GM/DM 只读，worker 不可见；
- 「人员架构」tab 用 host 的 `sessionQuery`/`sessionController` 构建项目会话树；节点可查看 preset YAML、用 `uiWorkspace.openSession` 进入会话；
- 「角色」tab 列项目/全局 preset；项目 preset（secretary/gm/dm/worker/advisor）优先；支持查看/导出；导入写 `~/.secretary-office/presets/imported-*.yml` 草稿，需安装/重载生效。
- 「归档已压缩原文」把 processed turn 写冷层（gzip + cold_index），之后 `memory_get` 仍可读；
- 回收站列表与还原；
- 角色策略只读（M3 再配置）；
- 顾问建议 inbox（由用户采纳/不采纳）。

控制台不直接访问核心端口，也不持有 token；它请求同源 `/office-console/api/*`，由 host 半边的白名单代理转发到核心。规则压缩器本地运行，不调用 LLM；`core_llm` 是后续可选引擎。

CLI 等价入口：

```bash
python -m secretary_core --data-dir "$env:USERPROFILE\.secretary-office" compress --project dsh-team --batch 20
python -m secretary_core --data-dir "$env:USERPROFILE\.secretary-office" compress --project dsh-team --batch 20 --confirm
```

## 顾问 transcript（session search）

advisor 需要跨会话读历史；基础组合默认把 `session-query-sqlite` 设为 `openAt: never`，所以 `session_search` 会报 `session search is disabled in this deployment`。本 bundle 的 patch 覆盖为：

```yaml
- id: session-query-sqlite
  config:
    path: 'C:/Users/sakuay/.dsh/session-search.db'
    openAt: first-search
```

重启后首次 `session_search` 会建索引；索引是派生库，可删可重建。换机器/用户名时改这个绝对路径。

## M4 组织（ES → GM → DM → worker）
- ES 预设新增 `gm` 工具；GM 预设挂 `dm`；DM 预设挂 `worker`；worker 挂 fs/run/sh/pwsh。
- `maxDepth=3`；GM/DM 只拆解/验收，不碰文件；worker 只做单一任务并回报证据。
- ES/GM/DM 都挂 `list_agents` / `send_message` / `interrupt_agent`；ES 可监控/纠偏 GM，不是 fire-and-forget。
- ES **不读 GM 完整会话**，只收 GM brief/报告；`list_agents` 查 running/inactive，`send_message` 唤醒 GM，`interrupt_agent` 停当前轮；终止整棵任务要 `scope:"descendants"` + 逐层中断（interrupt GM 不自动停后代）。
- ES 自动收到项目 brief（≤400 字）；ES 的上下文只保留 brief、GM 报告、决策与证据，不吸 DM/worker 全文。
- 适配器只收 `secretary` + `gm` 的 turn（GM 的 user=ES brief，assistant=GM report）；DM/worker 过程不写主记忆。
- 重启 DSH 后，在 ES 会话里让 ES 用 `gm` 下发一个真实小任务，检查完成通知、GM 报告、主记忆里的 GM turn。

## 验收记录（2026-10-22）

- 执行秘书会话的工具列表：8 个（5 memory + ask_user_question + load_workspace_dependencies + working_directory）。
- 核心收录 5 条真实 turn：T1 在 DSH 重启后由 `sessionQuery` 回填写入，T2 重启后实时写入。
- `raw_event=5`、`turn=5`、`raw_errors=0`，重启回填未产生重复。
- 剩余：20-turn soak；观察 ES 是否会主动调用 `memory_search`（工具已注册，核心 search 已验证返回 T1）。
- M2：84 Python tests、15 Node tests 通过；真实 dsh-team 的 `compress` dry-run 已验证，未写入；左侧栏控制台已截图确认，`/office-console/api` 的 projects/stats/roles/preview 均 200。
- M3 冷层：`archive` 写 `cold/<project>/T<id>.json.gz` + `cold_index`，`memory_get` 可读回，purge 连带删冷文件；控制台“压缩”页有归档按钮。
- M3 advisor：新增「顾问」预设（同工作区根会话），与用户直接对话；ES 看不到这段对话，也看不到未采纳建议。顾问只挂只读 memory + `session-query` + `submit_advice`；用户采纳后只追加一条 `advice.accepted` 的 hot turn（未压缩），**不自动写 brief/note、不触发 compress**；pending/拒绝不进入 ES。advisor 不写主记忆、无 fs/shell。

## 排错

- **只有 3 个工具（ask_user_question / load_workspace_dependencies / working_directory）**：这是 5 个记忆工具注册被拒的典型症状。DSH 的 `ctx.tools.register` 要求每个工具声明 `output.render`，只给 `output.schema` 会抛错，插件按单个工具 try/catch 后只剩全局工具。当前版本已补 `render`，并把 preset 行从 `@local/dsh-office/tools` 改成主包 `mode: tools`；更新后重启 DSH，并**新建会话**验证（已有会话保留旧预设 revision）。
- 会话中途切换预设：`session.header.agentPreset` 是创建时的值，不会随切换变化；适配器会跟踪 `agent-preset/selected`，回填也按该事件切段，所以中途切到「执行秘书」的会话仍会被收录。
- **控制台显示“加载失败：404 Not Found”**：说明客户端页面已加载，但 host 行 `office-core` 没有注册 `/office-console/api`。检查 `%USERPROFILE%\.secretary-office\host.log`（host 启动/路由错误会写这里）；确认插件页里 `@local/dsh-office` 的 `office-core` 行 enabled 且 fiber active。host 行失败时核心也不会启动，所以重启后先看这个日志。
- 核心起不来：看 `logs/core.log`；运行 `python -m secretary_core --data-dir ... doctor`；确认 `cordis.patch.yml` 里的 `coreDir` 指向 `secretary-office/core`。
- 工具报 “office core is not running”：host 行没加载；重启 DSH，检查插件页里 `@local/dsh-office` 是否启用。
- 没有收录：当前会话预设不是 `secretary`，或会话没有 cwd；检查 `.dsh/office.json`/日志。
- Python 路径：host 会优先找 `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`，可用 `DSH_PYTHON` 覆盖。
