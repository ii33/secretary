# 复审修复记录（P0/P1）

复审对象：`out/project-current-review.md`  
本次修复时间：2026-10-23  
测试：**84 Python + 15 Node** 全过；acceptance 通过。

## P0 已修

1. **顾问建议标记已读 404**
   - `console-proxy.js` 的 POST 分支增加 `/advice/{id}/delivered` 动态路由；
   - Node console-proxy 测试覆盖提交建议 + 标记已读；
   - 待重启 host 后生效。

2. **preset 元数据用错（generic）**
   - live `TurnBuffer` 改用 `effectivePresets.get(session.id) ?? header.agentPreset`；
   - `eventsToEnvelopes` 的 `makeBuffer(activePreset)` 使用切换段当前 preset；
   - 新增测试断言 `generic → secretary` 后 payload.preset=secretary；
   - 历史已有 T1/T2 的 raw payload 仍是 generic，无法无损反推，后续新 turn 正确。

3. **purge turn 不级联 summary/note/artifact**
   - `recycle._purge_turn_links`：删除 `source_turn` 关联 note、artifact；删除 `source_turn_ids` 包含该 turn 的 summary；
   - 同步清 `note_fts` / `summary_fts`；
   - 冷层测试覆盖 summary/note/artifact/FTS 全部不可查。

4. **旧库缺 `ux_turn_session_seq`**
   - 新增 schema v4 迁移：先按 `(session_id, seq)` 去重（保留最小 id），再建 live turn 唯一索引；
   - 迁移测试覆盖 v3→v4 去重与索引存在；
   - 当前 `SCHEMA_VERSION=4`，重启自动备份并迁移。

## P1 已修

- 规则压缩器：`todo/open_question` 只从**用户原话**提取，助手的能力介绍/反问不再污染 brief；真实 5-turn dry-run 已无这两类误报。
- `search`：`kind=summary/note` 无结果时不再回退 turn LIKE。
- `compress.remaining`：按真实 pending 总数计算，不再按 50 上限估算。
- `summary.scope`：`manual`（与 manual 压缩语义一致）。
- `compress_fts`：只索引 summary 正文，不再塞 notes JSON 键。
- `compress.apply`：在写事务内重新读取 pending，降低并发 confirm 双写风险。
- advisor brief 截断：先为“顾问建议”行预留长度，长 brief 不再吞掉建议。
- 回填：仅 live session 跳过未闭合 turn，非 live 会 flush。
- webServer 注册：不再 5 秒后永久放弃，持续重试（unref timer，插件销毁时清理）。
- `CoreManager`：自定义 dataDir 时同步 `SECRETARY_OFFICE_HOME`，tools 半边可读到同一目录。
- `coreDir` 从 bundle patch 移除，host 默认用 bundle 同级 `core`（当前 link 安装适用）。

## ES 角色修正（用户澄清）

- 执行秘书不是传声筒，而是与用户同层的**全局把控者**：看 brief、决定路线、下发 GM 指令、验收/纠偏/叫停。
- 已加：
  - ES 自动 brief 注入（≤400 字，`systemPrompt.context` + brief 缓存）；
  - ES/GM/DM 挂 `list_agents` / `send_message` / `interrupt_agent`；
  - ES persona 明确“全局把控、不吸 DM/worker 全文、只留 brief/报告/证据”。
- 历史“3 tools vs 8 tools”是同会话切换工具集的调试现象，不作为 ES 能力/错误证据。

## 顾问建议决策（用户）

- 顾问与用户直接对话，**ES 看不到这段对话**；pending/已读/拒绝都不进 ES。
- 建议状态：`new` → `delivered`（已读）→ `accepted` / `rejected`（用户决定）；新增 `decided_at`（schema v5）。
- 控制台「顾问建议」页由用户点**采纳/不采纳**；`POST /v1/advice/{id}/decision`。
- 用户采纳后：只追加一条 `event_type=advice.accepted`、`state=hot_raw`、`processed_at=NULL` 的 turn（session `advice:<id>`），内容为用户决定 + 建议正文；**不写 note/brief，不触发 compress**。ES 通过 `memory_recent/search` 看到这条未压缩历史；拒绝/pending 不生成 turn。
- 测试覆盖：pending 不可见 → delivered 仍不可见 → accepted 只增 hot turn → rejected 不增；brief 不变；proxy 路由测试。

## 任务板（v9）

- `taskboard_item`：section=long_term/stage/current，title/detail/status/position；
- 用户控制台点击标题编辑，按钮「达成 / 挂起 / 恢复 / 移除」；也可新增；
- ES `taskboard_read` / `taskboard_add` / `taskboard_update` / `taskboard_remove`；
- 顾问/GM/DM 只 `taskboard_read`（可见性到 DM）；worker 不挂；

## 项目约定（独立 v9）

- 独立 `convention_item` 表、独立控制台 tab、独立 `/v1/conventions` API；
- kind=avoid（应避免）/ follow（应遵循）；
- 用户/ES 可新增、编辑、挂起、恢复、移除；没有“达成”；
- ES `convention_read/add/update/remove`；顾问/GM/DM 只读；worker 不可见。

## 梳理 → 压缩

- CLI/API/控制台主入口改为 `compress`（`summarize` 保留 alias）；
- 压缩文本只保留目标/问题、决策/约束、结论/证据、未决/下一步，过滤寒暄、工具清单、重复句；
- 仍手动 dry-run + confirm，不自动触发。

## 人员架构 + 预设

- 「人员架构」tab：host 用 `sessionQuery`/`sessionController` 建项目会话树，显示 title/preset/running；节点「查看预设」读 registry YAML，「进入会话」用 client `uiWorkspace.openSession(sessionId)`。
- 「角色」tab：项目自定义预设（secretary/gm/dm/worker/advisor）与全局预设分组；可查看/导出 YAML；导入写 `~/.secretary-office/presets/imported-<id>.yml` 草稿，明确标注需安装/重载后才生效。
- 项目预设默认放在「角色」栏，不再单开预设 tab。

## 人员架构实例名（v10）

- `agent_name(session_id, project_id, name, ...)`：每个会话实例一个可编辑名字；
- 默认名 `预设名+序号`（如“执行秘书1”“通用环境2”）；同 preset 多实例可区分；
- 控制台点击名字或「改名」编辑；右侧仍显示 preset 名；
- 节点主标题=自定义名+DSH 会话标题；blank 会话过滤，顶层只显示真实会话；
- 名字接口 `GET/POST /v1/agent-names`。

## 项目预设隔离（v11）

- `project_preset(project_id,id,name,description,content)`：项目本地预设草稿；
- 导入 `.yml` 只写项目表，**不自动写全局 registry**；
- 角色 tab 分「项目自定义预设（草稿）」「已安装项目预设」「全局预设」；
- 项目草稿可查看/导出，但真正参与 agent 仍需显式安装/重载；控制台不自动提升到全局。

## 仍未完成

- session_search 真实建库/顾问 transcript 验收（profile 已覆盖为 `first-search` + durable path）；
- M4 真实 ES→GM→DM→worker 委派；
- 冷层真实数据路径（当前真实库 summary=0/cold=0）；
- 20-turn soak、ES 主动 `memory_search`；
- 硬编码 `session-search.db` 绝对路径、profile 的 `link:` 安装路径；
- role_policy 写入、GM 报告/任务持久表、advisor 主动通知。

## 结论

P0 四项与主要 P1 已修；真实运行仍以 **重启后 0.5.1-m4 / schema v4** 为准。不要因静态预设把 M4 说成完成。
