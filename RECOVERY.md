# 恢复记录（2026-10-25）

> 起因：插件原本装在 `D:\a\dsh\team\secretary-office\dsh`（DSH **安装目录内**），
> 2026-10-23 16:00 的 DSH 更新（electron-builder）整体替换了 `D:\a\dsh`，非清单文件被删，
> 插件与旧库一并丢失。磁盘恢复 + 源码重建后放在 `D:\secretary-office`。

## 结论

插件**已重新接入并可运行**：宿主行 active、四个角色预设可选、控制台 API 全部 200、
Python 核心在跑、历史记忆已迁回。

## 恢复做了什么

### 1. 依赖：失效链接 → 重新安装

profile 里原本是：

```json
"@local/dsh-office": "link:D:/a/dsh/team/secretary-office/dsh"   // 目标已不存在
```

`plugin_manager remove_bundle` → `install_bundle D:\secretary-office\plugin`，
现在为 `@local/dsh-office 0.5.11-m5 <- D:\secretary-office\plugin`（link）。

### 2. bundle 清单（重建时缺失）

`plugin/package.json` 补上 `dsh` 字段（原来完全没有，所以它无法作为 bundle 安装，
客户端半面也不会被加载）：

```json
"dsh": {
  "bundle": { "patch": ["./cordis.patch.yml"] },
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-layout"] }
}
```

### 3. 接入补丁（重建时缺失）

新建 `plugin/cordis.patch.yml`：

| 行 | 作用 |
|---|---|
| `office-core`（宿主行，`@local/dsh-office`） | 启动/复用 Python 核心；`coreDir`、`dataDir`、`python` 三个配置 |
| `preset-secretary` / `preset-advisor` / `preset-gm` / `preset-dm` | 四个角色预设，各挂 `@local/dsh-office/tools`（`role` 决定工具集） |

`python` 显式指向 DSH 自带解释器（`…\dsh-runtimes\…\dependencies\python\python.exe`），避免 MSYS python 的路径差异。

### 4. index.js 两处重建遗漏

| 问题 | 现象 | 修复 |
|---|---|---|
| **没有注册 `/office-console/api` 代理** | 控制台页面能加载但接口 404（原评审记录过这个历史问题） | 补回 `registerConsoleRoutes(ctx.get('webServer'), manager, helpers)`，webServer 未就绪时持续重试（unref timer，销毁时清理），并补齐 `org` / `presets` / `presetDocument` 三个 helpers |
| `systemPrompt.context()` 缺 `name` / `order` | 宿主行**加载即失败**：`TypeError: prompt context "undefined" order must be a finite number` | 传 `name: 'office:project-brief'`、`order: 100`（rc.3 要求有限 order） |

### 5. 历史记忆迁移

旧库 `%USERPROFILE%\.secretary-office\office.db`（表名单数 `turn`/`note`/`advice`，project 记作 `dsh-team`）
与新核心用的 `core.db`（表名复数，project 由目录名推导为 `team`）**schema 不同**，新核心读不到旧数据。

`scripts/migrate-office-db.py`（可重跑、带备份）负责桥接：

- **turn 不迁**：`index.js` 的 `backfillHistory` 已从会话日志重建出 9 条，避免重复；
- **note / advice 迁移**：`--map dsh-team=team` 做项目名归一（两者是同一工作区 `D:\a\dsh\team` 的两代命名，
  不归一就会变成两个项目，而 `dsh-team` 因无 turn 不进项目列表 → 迁移的 note/advice 看不见）；
- 旧库的 `taskboard` / `summary` / `convention` 为空，无损。

迁移结果：`notes 1`、`advice 1`（status `delivered`）、`turns 9`，全部归属 `team`。

## 验证

| 项 | 结果 |
|---|---|
| 宿主行 | `include:office-core` → `fiberPhase: active` |
| 角色预设 | `preset-secretary/advisor/gm/dm` → 全部 `active`；`/office-console/api/presets` 列出 秘书/顾问/总经理/部门经理 |
| Python 核心 | pid 252，端口 51974，`core.json` 已写；用 DSH 自带 python |
| 控制台 API | `/projects` `/presets` `/taskboard` `/conventions` `/org` 均 **200**，返回真实数据 |
| 数据 | `projects: [{id:"team", turns:9}]`；`notes/advice` 已可见于 `team` |
| 插件单测 | 15/15 通过 |
| 运行时简报 | 会话上下文里已出现「## 项目简报 / 项目：…」 |

## 仍需你处理/确认

1. **刷新页面一次**（Ctrl+R）：客户端模块在页面加载时才注册，刷新后左侧栏出现「秘书办公室」入口
   （`sidebar.panellist` 的 id = `office-console`，主面板 key = `office-console`，两者在 rc.3 的 slot 契约都已确认存在）。
2. **简报目前是全局注册的**：`systemPrompt.context` 挂在宿主行上，所以**所有** preset 的会话都会收到
   「## 项目简报」（本会话也能看到）。若只想给 secretary/gm/advisor/dm，在 `text(arg)` 里按
   `arg.agent.session.header.agentPreset` 过滤返回空串即可（一行改动）。
3. **过期的 workspace 条目**：`workspaceRegistry` 里仍有 `D:\a\dsh\team`（目录已被删），`/org` 会列出来。
   建议在 DSH 里删除或改指向新目录。
4. **不要再放回 `D:\a\dsh`**：那是安装目录，更新会整体替换。当前用 `link:D:\secretary-office\plugin`，
   意味着**该路径必须长期存在**；建议把这个目录纳入 git。

## 相关文件

| 文件 | 说明 |
|---|---|
| `plugin/package.json` | 补 `dsh.bundle` / `dsh.client`；版本 0.5.10-m4 → **0.5.11-m5** |
| `plugin/cordis.patch.yml` | 新建：宿主行 + 四个角色预设 |
| `plugin/index.js` | 补控制台代理接线；`systemPrompt.context` 补 `name`/`order` |
| `plugin/client.js` | 重写：**去 ESM 语法**（见下）、`slots.register(options, Component)` 两参形式、真实控制台 UI |
| `scripts/migrate-office-db.py` | 新旧库迁移（`--dry-run` / `--map`） |
| `%USERPROFILE%\.secretary-office\core.db.bak-*` | 迁移前自动备份 |

## 第二次事故：`dsh.client` 让整个应用起不来（2026-10-25 06:41）

加上 `dsh.client` 后重启，DSH 弹「应用无法启动」：

```
web boot: 1 entry did not activate
@local/dsh-office: import failed
renderer console: Uncaught SyntaxError: Unexpected token 'export'  @local/dsh-office/client.js:52
```

**根因**：DSH 把客户端插件当**普通脚本**注入（不是 ESM 模块）。重建的 `client.js` 结尾有
`export { install, MODULE_ID }` → 语法错误 → web boot 失败 → 整个应用起不来。
agentkit 的 `client.js` 一直是零顶层 `export`，所以从未触发。

**修复与教训**：

1. 去掉顶层 `export`，整段包进 IIFE（避免与其它插件顶层 `const` 撞名）；
2. 判断能否上线的校验**不能只靠 Node 单测**——单测是 ESM，恰好掩盖了差异。
   现在改为：`new vm.Script(src)` 按**普通脚本**解析 + 用 `vm.Script` 执行后拿到 spec，
   再用真实 React 做一次 SSR 渲染（1274 字符、含标题）才算通过；
3. 顺带修正两处 rc.3 契约不符：`ctx.slots.register(options, Component)`（组件是第二参数，不是
   options 里的 `render`）、`ctx.locale.register(ns, { zh, en })`。

**自愈的副作用**：那次崩溃后 DSH 的恢复流程把 `@local/dsh-office` 以及
`dsh-experimental-inspector-profile`、`dsh-experimental-agent-team-profile` 从
`dsh.profile.bundles` 里摘掉了（用户自己的 `cordis.patch.yml` 未被改动，已确认完好）。
office 已用 `set_bundle` 重新选中；另外两个 bundle 需要时同样一句 `set_bundle` 加回。

## 第三个问题：面板点进去空白

`main` 槽里 `office-console` 已注册且 `active`，但重建的 `client.js` 只渲染一行占位文字。
现在 `OfficeConsole` 是一个可用的最小控制台：项目列表（含 turn 数）+ 选中项目的任务板 + 约定，
全部走 `/office-console/api`；加载失败会在面板里显示红色错误行，不再静默空白。

（后续重建已把它换成完整控制台：项目/任务板/约定/搜索/最近/压缩/回收站/角色/人员架构/建议，
SSR 渲染 3870 字符、9 个区块齐全。）

## 第四次修改：验收发现的 4 项（2026-10-25 15:0x）

重建后的验收通过，但留下 4 个问题；已全部修掉并逐条复验：

| # | 问题 | 修法 | 复验 |
|---|---|---|---|
| 1 | 代理未暴露 `DELETE /taskboard/{id}`、`DELETE /conventions/{id}`、`GET /audit`（核心支持，代理 404） | `lib/console-proxy.js` 增加两条 `DELETE` 动态路由 + `/audit` GET | 建→删→读空：`{"status":"removed"}`；`/audit` 返回真实审计条目 |
| 2 | `stats.brief_chars` 恒为 0（只查 `brief` 表，而 brief 常常是实时拼装的） | `db.py:stats()` 改为 `len(build_brief(conn, project))` | `team` 的 `brief_chars=311`，与 `/brief` 文本长度一致 |
| 3 | `tools.test.mjs` 清理阶段 `EPERM`（SQLite 未释放），单测每次必红一行，掩盖真回归 | `rmSync` 补 `maxRetries: 5, retryDelay: 100`（与 `host.test.mjs` 一致） | 全量 **15/15 通过** |
| 4 | 版本号混乱：plugin `0.5.11-m5`、`core/__init__.py` 与 `cli.py` 各写 `0.5.10-m4`（`cli.py` 另有一份硬编码，是重复真源） | 三处统一 `0.5.12-m6`；`cli.py` 改为 `from . import __version__`（单一真源） | `cli --version` / `package.json` / `__init__.py` / `pyproject.toml` 四处一致 |

顺带修掉的既有缺陷：`core/pyproject.toml` 的 `version` 行在重建时被写坏成嵌套引号
（`version = "version = "version = …`），已恢复为合法 TOML；`tomllib` 解析通过。

重启方式（改的是宿主行代码与 Python 核心）：`set_plugin include:office-core` 关再开即可，
不必重启整个应用。

## 第五次：补上核心测试 + 一处误判更正（2026-10-25 15:2x）

### 1. `core/tests/test_smoke.py`（新增，8 个用例）

`core/` 此前 0 个 Python 测试，44 KB 的 `db.py` 状态机没有回归网。新增的冒烟测试只用标准库
（`unittest` + `urllib`），自起一个临时数据目录的 core 子进程，**不碰** `%USERPROFILE%\.secretary-office`：

```bash
cd D:\secretary-office\core
python -X utf8 tests\test_smoke.py
```

覆盖：`/v1/health`、事件入库 → `compress` 预览/确认（`hot_raw → processed`、`S-` 摘要可回读）、
中文 FTS 检索（命中 + **真阴性** + 空查询）、`brief` 与 `stats.brief_chars` 一致性（守住第 2 项修复）、
`archive → cold → recycle → restore → purge` 全链路、任务板/约定的建-改-删、笔记与 `get`、未知路由 404。

结果：**8/8 通过，0.854s**。（Windows 控制台里中文 docstring 可能显示成乱码，是 cp936 输出编码问题，
加 `-X utf8` 即可，不影响断言。）

### 2. 更正：控制台的删除按钮**本来就有**

上一轮我说「任务板/约定还没有删除按钮」——**这个判断是错的**。当时我只 grep 了 `DELETE`，
就以为 UI 没有删除路径。实际 UI 用的是 `remove: true` 约定：

- `client.js:327` `removeTask` / `:369` `removeConvention` → `POST /taskboard|/conventions {project, id, remove: true}`
- `client.js:620` 渲染「移除」按钮
- 核心 `server.py:184-186`、`211-213` 明确处理 `body.get("remove")` → `db.remove_task/remove_convention`

端到端实测（经 `/office-console/api`）：建 `T-708404ca2316` → `{"status":"removed"}` → 列表为空；
约定同理。**所以 UI 不需要改。**

### 3. 新增的两条代理 `DELETE` 路由定位

它们不是 UI 的依赖，而是**接口对称性**：REST 语义上删除就该有 `DELETE /{id}`（核心 `server.py:202`
与 `229` 本来就支持）。实测 `DELETE /office-console/api/taskboard/{id}` → `{"status":"removed"}`。
保留即可，不影响既有 UI 路径。

**教训（与前面几次一致）**：判断"某功能缺失"必须**看调用链两端**——这次只看了一端的 `DELETE` 关键字，
就漏掉了另一端的 `remove:true` 约定。grep 一个词不等于验证一条路径。

## 一键验收：`scripts/check.ps1`（2026-10-25 15:3x）

```powershell
pwsh -File D:\secretary-office\scripts\check.ps1
# 或跳过静态门只跑测试
pwsh -File D:\secretary-office\scripts\check.ps1 -SkipStatic
```

自动定位 DSH 自带 node/python（找不到则回落 PATH），从脚本位置推导仓库根，**可在任意目录运行**。
五道门，全绿则退出码 0，任一失败退出码 1 并打印该门输出尾部：

| 门 | 内容 | 存在理由（都对应一次真实事故） |
|---|---|---|
| 1a 静态 | `client.js` 用 `vm.Script` 按**普通脚本**解析，顶层 `export`/`import` 必须为 0 | 2026-10-25 06:41 加了顶层 `export` 导致 **web boot 失败、应用起不来** |
| 1b 静态 | `pyproject.toml` 合法 TOML + 四处版本号一致 | `pyproject` 曾被写坏成嵌套引号；`cli.py` 曾自带重复的版本常量 |
| 2 体检 | `doctor`：python / sqlite / **fts5** / 数据目录可写 | FTS 不可用时检索会静默退化成 LIKE |
| 3 核心门 | `core/tests/test_smoke.py`（8 用例，自起隔离核心） | `db.py` 44 KB 状态机此前**零 Python 测试** |
| 4 契约门 | `plugin/test/*.test.mjs`（15 用例） | 宿主适配器/代理/工具面的既有契约 |

实测：**5/5 全绿，约 7 秒**（1a 186ms / 1b 119ms / doctor 300ms / 核心 1115ms / 契约 5278ms）。

**负面验证（证明门会红）**：把整棵树复制到临时目录，在 `client.js` 顶部注入 `export const injected = 1`，
运行结果为 `1a FAIL`、`4 契约门 FAIL`、`结果：2 门失败 / 共 5 门`、退出码 **1**；副本已删除，
真树的 `client.js` 顶层 `export` 仍为 0。




