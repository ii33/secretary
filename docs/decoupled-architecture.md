# 与 DSH 解耦：核心 / 适配器 / 控制台

> 第三轮修订。承接 [secretary-memory-design.md](D:/a/dsh/team/secretary-memory-design.md)。
> 你的新约束：**程序尽量不依赖 DSH 环境；DSH 还是早期版本，常有破坏性变更。**
> **第四轮修订（见第 10 节）：前端走 DSH Desktop 的 `desktop` profile（客户端插件）；不自带运行时，核心用 DSH 自带 Python。Desktop 0.2.1-rc.2 只认 `desktop` profile，独立 profile 需要 `DSH_HOME` 变通。**
> 本文只设计，不实施。

---

## 0. 先记下你的决定

| 项 | 决定 |
|---|---|
| 记忆范围 | 只 ES↔用户 + ES↔GM 报告；worker/DM 过程不进库 |
| 写入权限 | 程序自动（不靠 ES 手动调 `memory_note`） |
| 删除 | 回收站机制，保留时间可选 |
| 权限 | 默认权限 + 控制台手动配置 |
| 最小记忆浏览/删除 | 跟控制台一起上线，M1 不做 |
| 长任务回复 | 先“已派发”，完成后再报（待验证 DSH 唤醒） |
| dots 历史导入 | 先不导入 |

---

## 1. 新约束的含义：哪些必须依赖 DSH，哪些不必

| 能力 | 归属 | 是否依赖 DSH |
|---|---|---|
| 记忆库、检索、笔记、回收站、备份 | 核心服务 | **否** |
| 控制台、记忆浏览、角色/权限配置 | 独立 Web 控制台 | **否** |
| 记忆工具（search/get/note/brief） | 核心服务，MCP 暴露 | **否**（任何 MCP 客户端可用） |
| 事件采集（ES 会话消息） | DSH 适配器 | 是 |
| Agent 执行（ES/GM/DM/worker、subagent、压缩） | DSH + 适配器 | 是 |
| 角色权限的最终执行 | DSH 适配器 | 是 |
| 长任务完成唤醒 ES | DSH 适配器 | 是 |
| 聊天窗口 | DSH Web UI | 是 |

结论：**把“记忆 + 控制面”做成独立程序，把“执行 + 采集”压成一层薄适配器。** DSH 升级/破坏时，核心数据、控制台、记忆检索都活着；只需重写适配器。

这也顺手解决了之前的一个风险：**SQLite 不再需要跑在 Electron/Node 里**，核心用独立 Python + 标准库 `sqlite3`/FTS5，稳定、可测试、无原生模块。

---

## 2. 三层架构

```
┌─────────────────────────────────────────────┐
│ 控制台（独立本地 Web）                       │
│ 记忆浏览 / 回收站 / 角色权限 / 任务 / 报告   │
│ 聊天：跳到 DSH 会话（可选以后嵌入）          │
└───────────────▲─────────────────────────────┘
                │ HTTP 127.0.0.1 + token
┌───────────────┴─────────────────────────────┐
│ 核心服务（不 import 任何 DSH 包）            │
│ project / agent(ref) / turn / note /         │
│ task / report / artifact / role_policy /     │
│ recycle / FTS(bigram) / brief / 自动提炼     │
│ SQLite + 原始事件仓 + JSONL 导出             │
└───────────────▲─────────────────────────────┘
                │ HTTP 或 MCP
┌───────────────┴─────────────────────────────┐
│ DSH 适配器（薄插件，唯一 DSH 相关代码）      │
│ session/event → 原始事件                     │
│ subagent/start|end → task/report             │
│ 核心工具 → MCP（或薄 HTTP 工具）             │
│ 角色配置 → preset/model/permission           │
│ 完成通知 → 唤醒 ES                           │
└───────────────▲─────────────────────────────┘
                │ DSH API（可能变）
┌───────────────┴─────────────────────────────┐
│ DSH 运行时：ES / GM / DM / worker / 顾问     │
└─────────────────────────────────────────────┘
```

### 2.1 数据目录

- 核心数据：`%USERPROFILE%\.secretary-office\`（独立于 `~/.dsh`）。
  - `office.db`：项目、记忆、角色、任务、报告、回收站。
  - `raw/`：适配器上报的原始事件（按日期分文件/表），用于重放。
  - `exports/`：JSONL 导出/备份。
- 备份：`exports/` 定期快照；可选 SFTP 到 NAS。
- 不用 DSH 的 `~/.dsh/projects`，避免 DSH 升级/清理误伤。

### 2.2 ID 与引用

- 核心自己生成 `project_id`、`agent_id`、`turn_id`。
- DSH 的 session id、workspace 路径、会话 URL 只存为 `external_ref`，**不作为主键/外键**。
- 适配器升级或 DSH 换版本时，核心数据不用迁移。

---

## 3. 核心服务（独立 Python 程序）

### 3.1 运行时与打包

- Python 3.12，只用标准库 `sqlite3`、`http.server`/`json`、`argparse`；不 import DSH。
- 打包：PyInstaller one-folder，或 embeddable Python + 启动脚本；不依赖系统 Python。
- 运行方式：后台服务 + 托盘/开机启动；控制台用浏览器打开 `http://127.0.0.1:<port>`。
- 依赖策略：M1 零第三方依赖；自动提炼接 LLM 时再加一个 OpenAI-compatible HTTP 客户端（自己配 key，不走 DSH）。

### 3.2 API（HTTP，本地 token）

```
POST /v1/projects
GET  /v1/projects
POST /v1/raw-events          # 适配器上报原始事件（可重放）
POST /v1/events              # 已归一化的 turn/message/report
POST /v1/search              # 查询记忆
GET  /v1/turns/{id}
POST /v1/notes               # 自动/手动笔记
GET  /v1/brief?project=...
POST /v1/recycle             # 软删
POST /v1/restore
POST /v1/purge
GET  /v1/roles
PUT  /v1/roles               # 控制台写入
GET  /v1/tasks
POST /v1/reports
GET  /v1/artifacts
GET  /v1/health
```

MCP 服务（stdio 或 HTTP）暴露同一组记忆工具：`memory_search`、`memory_get`、`memory_recent`、`memory_note`、`memory_brief`、`memory_forget`。DSH 通过 MCP client 连接；以后 Codex/Claude/CLI 也能用。

### 3.3 原始事件仓：DSH 变更的缓冲层

适配器不要直接写“turn”，而是先写**原始事件**：

```json
{
  "source": "dsh",
  "source_version": "0.2.1-rc.2",
  "event_type": "user/message",
  "external_session": "session-...",
  "external_seq": 42,
  "payload": { "...": "适配器看到的原始字段" },
  "received_at": 1792596532
}
```

核心再异步/同步归一化成 `message/turn`。好处：

- DSH 事件结构变了，适配器先把能拿到的原始 JSON 存下来，归一化逻辑可以后改、重放；
- 适配器写失败或崩溃，原始数据不丢；
- 核心的归一化器有 `normalizer_version`，可对历史原始事件重跑；
- 核心不依赖 DSH 的类型定义，只依赖一个稳定的信封。

代价：多存一份原始事件（文本量级，很小）；M1 可只存必要字段，不存完整流式 chunk。

### 3.4 自动记忆写入（按你选的“程序自动”）

三段式，避免每轮都烧 LLM：

1. **Tier 0：自动索引**（每轮，零 LLM）
   - 用户消息、ES 回复、GM 报告、压缩摘要 → `turn/message`；
   - 规则识别“记住/以后都/决定/不要/偏好” → 候选 note；
   - 全部带 `source_turn`，可追溯。
2. **Tier 1：规则提炼**（每轮，零 LLM）
   - 决策句式 → `decision` 候选；
   - 待办/未决 → `todo/open_question` 候选；
   - 与已有 note 做相似去重，避免重复。
3. **Tier 2：LLM 提炼**（批量/每日，可选）
   - 对当天/本任务 turn 做摘要，抽取事实、偏好、决策、实体；
   - 写 `status=auto`（低风险）或 `proposed`（高风险/需确认）；
   - 需要独立配置一个 OpenAI-compatible endpoint；不依赖 DSH。
4. **Tier 3：合并/过期**（每日/每周）
   - 合并重复 note；标记被新决策取代的旧决策（`superseded_by`）；
   - 刷新项目 brief。

M1 只做 Tier 0 + 规则 Tier 1；LLM 提炼等核心稳定后再加。ES 仍可手动 `memory_note`，但不是主路径。

### 3.5 回收站

- 所有可删记录带 `deleted_at`、`deleted_by`、`delete_reason`、`purge_after`。
- 默认保留 30 天，可选 7/30/90/365/永久（控制台配置）。
- 默认检索/ brief 排除已删；控制台回收站可看、可还原、可立即清空。
- 每日 purge 任务；清空写审计。
- 备份里可能仍有已删数据，按备份保留策略处理；文档里写清楚。
- 删除 turn 时，关联的自动 note 标记 `source_deleted`，进入待复核队列，不静默留着。

### 3.6 权限（默认 + 控制台配置）

核心存 `role_policy`，不直接执行，由适配器落到 DSH：

| 角色 | 默认沙箱 | 文件写 | shell | 网络 |
|---|---|---|---|---|
| ES | read-only | 否 | 否 | 否（记忆工具除外） |
| 顾问 | read-only | 否 | 否 | 可选 |
| 档案室 | read-only | 否 | 否 | 否 |
| GM | read-only | 否 | 否 | 否 |
| 部门经理 | workspace-write | 工作区 | 受限 | 可选 |
| Worker/文书 | workspace-write | 工作区 | 受限 | 可选 |

控制台可按角色覆盖。适配器创建子会话时尽量应用；如果 DSH 不支持逐子会话权限，就退化为“工具级限制 + 全局沙箱”，并在控制台标明“未完全生效”。**不要让 worker 默认继承当前的 danger-full-access。**

---

## 4. DSH 适配器（唯一 DSH 相关层）

### 4.1 职责

1. **采集**：订阅 `session/event`；识别 ES/顾问/GM 会话；把 user/assistant/compaction/brief/report 归一化后 POST 给核心；同时写原始事件。
2. **回填**：启动时用 `sessionQuery` 扫历史，补齐核心缺失的 turn；断点续传。
3. **工具**：把核心的 MCP server 挂到预设（或退化为薄 HTTP 工具）；ES/档案室只看到记忆工具。
4. **角色/模型/权限**：从核心读 `role_policy`，spawn 子代理时映射到 DSH 的 preset/model/permission。
5. **完成通知**：监听 `subagent/end`，把报告写核心，再尝试唤醒 ES 开新一轮；唤醒失败就退回“用户下次问时再报”。
6. **状态**：把 agent running/idle、token、耗时上报核心，供控制台显示。

### 4.2 会话识别

- ES：`agentPreset == secretary` 且 cwd = 项目 workspace；
- 顾问：`agentPreset == advisor`；
- GM/部门/worker：从 ES 的子代理链（`parentSessionId`/`subagent` 目录）推导；
- 其他 preset 的同 workspace 会话默认不采集；可在控制台手动加入/排除。
- 若用户中途换 preset，以会话创建时/首次识别为准，控制台可纠正。

### 4.3 容错与版本

- 适配器只使用 DSH 的稳定事件/服务；对 `session/event`、`subagent/end` 等做能力探测，缺了就降级（例如退回 `sessionQuery` 轮询、或只采集用户消息）。
- 记录 `dsh_version`；升级后跑适配器契约测试；不通过就停在旧版 DSH 或禁用适配器。
- 适配器崩溃不影响核心；核心数据完整；重启后回填。
- 适配器升级只改适配器，不改核心 schema。

---

## 5. 控制台（独立 Web）

- 由核心服务直接托管静态页面，浏览器打开；不注册 DSH 客户端插件、不依赖 DSH UI API。
- 页面：
  - 项目/记忆：搜索、时间线、turn 详情、引用；
  - 回收站：还原/清空/保留期；
  - 笔记：自动笔记复核、手动编辑、标为过期；
  - 角色/权限：preset、模型、沙箱、工具开关；
  - 任务/报告/artifact：看板、详情、文件链接；
  - 状态：ES/GM/DM/worker 的 running/idle、token、耗时（由适配器上报）；
  - 设置：备份、导出、保留期、LLM 提炼 endpoint。
- 聊天：先“打开 DSH 会话”链接；不在控制台里重写聊天。以后若要内嵌，走适配器的稳定 API，而不是 DSH UI 内部接口。
- 认证：本地 token；只监听 127.0.0.1；不暴露公网。

---

## 6. M1 重排（核心优先）

### M1a 核心服务（不装 DSH 也能跑）

- SQLite schema + bigram FTS + 原始事件仓；
- `POST /v1/raw-events`、`/v1/events`、`/v1/search`、`/v1/notes`、`/v1/recycle`、`/v1/restore`、`/v1/brief`；
- MCP server（五个记忆工具）；
- CLI：`init`、`ingest`（喂测试事件）、`search`、`export`、`purge`；
- 测试：fake 事件源跑 20 个回忆问题；无 DSH import；断网可用。

### M1b DSH 适配器（薄）

- 订阅 `session/event`，识别 ES，写原始事件 + 归一化；
- `sessionQuery` 回填；
- 把 MCP server 挂到 `secretary` 预设（或先做 HTTP 工具 fallback）；
- 一个真实 ES 会话跑通：聊天 → 自动入库 → ES 用记忆工具 → 重启后仍可查。

### M1c 自动规则

- 规则识别决策/偏好/待办，写 `auto/proposed` note；
- 不做 LLM 提炼、不做控制台、不做回收站 UI（API 先有）。

### 验收

- 核心在**没有 DSH 的目录/进程**下可启动、可检索、可导出；
- 适配器停用后核心数据不丢；重启用回填补齐；
- ES 重启/新会话后能检索旧记忆；
- 工具结果 p95 ≤350 字；查询 p95 ≤100ms（20k turn）；
- 删除进回收站，可还原；保留期到期可 purge。

---

## 7. 版本、迁移、备份

- `schema_version`、`normalizer_version`、`adapter_version` 分开记。
- 迁移脚本只前向；迁移前自动备份。
- 原始事件仓保留 ≥90 天，便于重放。
- `export` 出 JSONL（项目/turn/note/task/report），`import` 可恢复。
- 备份：每日 `office.db` 快照 + exports；每月 restore 演练。
- DSH 升级流程：先跑适配器契约测试；通过再切；失败回退旧适配器，核心不动。

---

## 8. 开放问题

1. **MCP 是否可用**：DSH 有 `dsh-mcp-client`，需要验证本地 stdio/HTTP MCP server 能否按预设暴露工具、工具名/审批是否可接受。不行就退化为薄 HTTP 工具，核心不变。
2. **运行时**：核心用 DSH 自带 Python（不自带运行时），系统 Python 兜底，可以吗？还是希望核心也用 Node，减少一种语言？
3. **自动提炼的 LLM**：Tier 2 需要独立配一个 OpenAI-compatible endpoint；现在做，还是等核心稳定？
4. **回收站默认保留期**：30 天可以吗？选项 7/30/90/365/永久。
5. **权限落地**：DSH 能否逐子会话设沙箱？如果只能全局，接受“工具级限制 + 控制台记录意图”吗？
6. **控制台聊天**：前端走 DSH profile 后，聊天复用原生会话（控制台只做记忆/角色/状态），可以吗？
7. **ES 的 `memory_note` 工具**：程序自动后，还保留手动写记忆吗？我建议保留（用户说“记住”时立即写，自动提炼兜底）。
8. **控制台是否也要能在没有 DSH 时使用**：记忆浏览/回收站/角色配置应该可以；聊天/状态需要适配器。这个边界你认可吗？

---

## 9. 一句话

**核心是独立程序，DSH 只是“执行 + 采集”的一个适配器。** DSH 变了，换适配器；记忆、控制台、数据不动。

---

## 10. 第四轮修订：前端走 DSH Desktop，不自带运行时

你的选择：控制台不做独立 Web，也不打包运行时；前端作为 DSH 桌面里的客户端插件，核心用 DSH 自带 Python。用“部署依赖 DSH”换“一个窗口、零额外运行时”。

### 10.1 先纠正一个事实：Desktop 只认 `desktop` profile

DSH CLI 支持 `--profile`，但 **Desktop 0.2.1-rc.2 的 `lib/main.js` 把 profile 路径硬编码为 `~/.dsh/profiles/desktop`**，没有 profile 选择器。所以“desktop 形式 + 独立 `dots` profile”目前不能直接做到。三个选项：

| 方案 | 做法 | 评价 |
|---|---|---|
| **A（推荐）** | 把 `@local/dsh-office` 装进现有 `desktop` profile；正常双击 DSH，侧边栏出现控制台入口 | 一个窗口、无浏览器；和 agentkit/team 共用 profile，用 bundle/preset 命名空间隔离 |
| B（实验） | 独立 `DSH_HOME` + 独立 Electron `--user-data-dir` 的快捷方式，第二套桌面实例 | 真正隔离，但未官方支持；要测单实例锁、登录、设置 |
| C（不选） | `dsh --profile dots` + 浏览器/独立 Web 壳 | 不符合“不用浏览器” |

结论：**先走 A（已确认）**；如果以后确实需要隔离，再验证 B。核心数据目录始终独立，不受 A/B 影响。

### 10.2 形态（方案 A）

```
DSH Desktop（desktop profile）
├─ 客户端插件：控制台页面（记忆/回收站/角色权限/任务/状态）
├─ 宿主插件：DSH 适配器 + 核心进程管理
├─ presets：secretary / gm / dm-* / worker-* / advisor / archivist
└─ MCP/工具配置
        │ HTTP（127.0.0.1 + token）
        ▼
独立核心服务（Python，DSH 自带解释器；代码不 import DSH）
        │
        ▼
%USERPROFILE%\.secretary-office\office.db
```

- 不新建 profile；`@local/dsh-office` 是一个 bundle，装进 `desktop` profile。
- 同一个 DSH 窗口里既有控制台页面，也有原生聊天；聊天复用原生会话/子代理 UI。
- 核心仍独立进程：host 插件启动 `python core/main.py`，用 DSH 自带 Python；数据独立；DSH 退出时核心可继续跑，或随插件停止（可配）。
- 不自带运行时；不写 PyInstaller。

### 10.3 好处

- **一个窗口**：控制台 + 聊天 + 子代理浏览都在 DSH 里，不用两个 UI。
- **复用原生能力**：会话打开、子代理续聊、preset/model 选择、状态投影、审批卡片，不用重写。
- **零额外运行时**：用 DSH 自带 Python 3.12；核心只用标准库。
- **不用第二套 DSH home**：比 B 少一套登录、设置、会话目录。
- **核心仍可搬走**：核心代码不 import DSH，数据独立；没有 DSH 时，任意 Python 3.11+ 仍可跑核心/导出数据。

### 10.4 代价与缓解

| 代价 | 缓解 |
|---|---|
| 控制台 UI 绑定 DSH client plugin/slot API，DSH 破坏性变更会打到前端 | UI 逻辑放在 `api.ts` + 通用 React 组件；DSH 只做壳；必要时可套一个独立 Web 壳 |
| 和 agentkit/team 共用 `desktop` profile，可能互相影响 | bundle 开关 + preset 命名空间；office 不依赖 team 的宿主级工具；必要时把 team bundle 从 desktop 拿掉，或再走 B |
| 运行时依赖 DSH 自带 Python；DSH 路径变了要适配 | locator 多路径探测（复用 agentkit 的 Python 定位逻辑）；系统 Python 兜底；核心零第三方依赖 |
| 聊天/状态/权限仍 DSH 绑定 | 核心/数据不绑定；DSH 坏了，记忆和控制台数据仍在，换适配器即可恢复 |

### 10.5 包与启动

- `@local/dsh-office` bundle 安装到 `desktop` profile；host 插件负责启动/健康检查/停止核心进程。
- client 插件注册 `main` 页面（key: `office`）+ `sidebar.panellist` 图标 + 可选 `settings.section`。
- 预设通过 bundle 的 `cordis.patch.yml` 声明；角色配置存核心，适配器 spawn 时读。
- 数据目录 `%USERPROFILE%\.secretary-office`；profile 只放配置和代码。
- 启动方式 A：正常双击 DSH；控制台入口在侧边栏，不需要改快捷方式。
- 若以后走 B：新快捷方式设置 `DSH_HOME` + `--user-data-dir`，先验证单实例与登录。

### 10.6 M1 影响

- **M1a 核心**不变：独立 Python + SQLite + MCP/HTTP；可用任意 Python 测试。
- **M1b 适配器/BUNDLE**：建 `@local/dsh-office` bundle + host 适配器，装进 `desktop` profile；控制台页面后置。
- **M1c 规则提炼**不变。
- 控制台（记忆浏览/回收站/角色权限）作为 client 插件在 M2/M3 加页面，不用另建 Web 工程。
- 不自带运行时；不写 PyInstaller。

### 10.7 仍待验证

- DSH client plugin 的页面/侧边栏/设置页插槽（agentkit 已有现成模板，可直接参考）。
- host 插件定位 DSH Python 的稳定路径；系统 Python 兜底。
- MCP 还是 host 工具：MCP 更可移植；host 工具更简单。先做 host 薄工具，MCP 作为二期也行。
- 控制台页面与原生会话的跳转：根会话、任意深度子会话的地址与权限。
- 与 agentkit/team 在同一个 `desktop` profile 里共存的冲突；必要时先移除 team bundle。
- 方案 B 的单实例锁、`--user-data-dir`、第二套登录是否真的可用（只在需要真隔离时验证）。

### 10.8 一句话

**前端住进 DSH Desktop 的 `desktop` profile，核心住自己的数据目录；一个窗口用，数据/核心不被 DSH 绑死。** 真正的 profile 隔离要等 DSH Desktop 支持，或走实验的 `DSH_HOME` 方案。
