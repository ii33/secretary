# 项目复审（M1b–M4 后）

复审时间：本次复审  
复审对象：`secretary-office/` 核心、`dsh/` 适配器、desktop profile 安装、真实 `~/.secretary-office` 数据  
复审方式：源码审阅、测试/验收复跑、真实数据库核对、控制台路由实探、文档口径比对  

---

## 0. 结论先行

**M1a 已经可靠；M1b 主链路可用但验收未完成；M2/M3 有真实代码和测试，但仍有控制台断点与质量问题；M4 只是静态预设骨架，尚未完成运行时验收。**

不建议把当前状态表述为“M4 已完成”。更准确的表述是：

> M1a 完成；M1b 冒烟通过、20-turn soak 未做；M2/M3 代码完成、部分真实验收未做；M4 预设链已声明、真实委派未验收。

主观完成度估计：

| 阶段 | 估计完成度 | 判断 |
|---|---:|---|
| M1a 核心 | 95% | 测试、验收、迁移、日志、备份均闭环 |
| M1b 适配器 | 75–80% | 真实 5 turn 已入库；20-turn soak、工具主动调用、元数据修正待做 |
| M2 梳理 + 控制台 | 60–65% | 代码和测试在；真实 summary 未跑；规则提取有明显误报；控制台部分交互未验收 |
| M3 冷层 + advisor | 55–60% | 冷层测试在但真实数据未归档；advisor 建议已有 1 条；session_search 未验证；建议已读路由坏了 |
| M4 GM/DM/worker | 20–25% | 预设静态链正确；没有真实 GM/DM turn、没有任务/报告表、没有角色策略 |
| 总体 | 约 60–65% | 可继续开发，不应宣称生产完成 |

---

## 1. 本次实测基线

### 1.1 自动测试

```text
Python: 66 tests, OK (19.291s)
Node:   12 tests, 12 pass, 0 fail
Acceptance: 100 turns, 20/20 queries, p95=6.63ms,
            after restart=99 turns, DB=266240 bytes,
            purge={turn:1, note:1}, FTS 100→99
```

结论：**自动化层面没有发现阻断级回归**。

### 1.2 真实数据

用 DSH 自带原生 Python 读取 `C:/Users/sakuay/.secretary-office/office.db`：

```text
projects=1  sessions=2  turns=5  raw_events=5  raw_errors=0
hot_turns=5  processed_turns=0  summaries=0  notes=0
cold_turns=0  advice=1  role_policy=0
```

真实 turn 分布：

- T1/T2：同一 ES 会话，早期工具数量从 3 个纠正到 8 个；
- T3/T4/T5：另一 ES 会话；
- 没有 GM、DM、worker 的 turn。

这证明 M1b 的“启动→采集→检索→重启回填”主链路确实跑过，但也说明 M4、M2 的 confirm、M3 冷层还没有真实业务样本。

### 1.3 控制台

```text
GET  /office-console/api/projects  → 200
POST /office-console/api/advice/A-test/delivered → 404
```

控制台主路由可用；顾问“标记已读”不可用。

---

## 2. M1a：已可靠，文档口径需要收口

已证实：

- schema v3，迁移前备份；
- 51/66 测试口径不一致，但**实际 66 Python tests 全过**；
- acceptance 覆盖 export、强制 purge、FTS rowid 清理；
- 备份、日志、`--include-deleted` 都已接线。

遗留问题主要是文档，不是功能：

- `README.md:21` 仍写 51 tests；
- `v1-spec.md:452` 写 51 tests，而 `:482` 写 66；
- `TASKS.md` #7 也写 51；
- `pyproject.toml:8` 描述仍是 M1，版本已是 `0.5.0-m4`。

**判断：M1a 可以视为完成；文档计数应一次改齐。**

---

## 3. M1b：主链路可用，但不能算完整验收

### 3.1 已证实

- bundle 已以 `link:D:/a/dsh/team/secretary-office/dsh` 装进 desktop profile；
- 12 个 Node 测试通过；
- host 能启动/复用核心、写 raw_event、回填；
- 真实 5 个 turn、2 个 session、无重复、无 raw error；
- 5 个 memory 工具注册和执行路径有测试；
- 顾问角色不注册 `memory_note`，只读约束有测试。

### 3.2 真实缺陷

**P0：preset 元数据与实际会话不一致。**

- `index.js:113` 创建 TurnBuffer 时使用 `session.header.agentPreset`，没有使用 `effectivePresets.get(session.id)`；
- `turns.js:138` 的 `makeBuffer()` 也固定使用 `header.agentPreset`，即使 `:142-155` 已经算出 `activePreset`。
- 结果：真实库里 2 个 ES session 的 `preset` 都是 `generic`，raw payload 的 T1/T2 也写 `preset: generic`，但 session cache 显示 `agentPreset=secretary`。

影响：

- 记忆的角色归属错误；
- 后续按 preset 做统计、审计、M4 角色链判断时会误判；
- 当前过滤逻辑用 effective map，所以“能收录”，但**数据标签是错的**。

**P1：20-turn soak 和 ES 主动调用 `memory_search` 仍未完成。**

规格 M1b 验收要求 20 个 turn 后 ES 可检索、重启后可查、5 工具可用；当前只有 5 个真实 turn，T1 还是“只有 3 个工具”的历史错误回答。不能据此宣称 M1b 已完全验收。

**P1：控制台路由注册有可靠性隐患。**

- `index.js:125-143` 对 webServer 只重试 5 次、每次 1 秒，之后永久放弃；
- `host.log` 只看到 `webServer unavailable; retry 1`，没有成功注册记录；
- 当前 `/office-console/api/projects` 返回 200，说明这次最终可用，但启动时序没有可靠保证。

**P1：硬编码路径。**

- `cordis.patch.yml:14`：`C:/Users/sakuay/.dsh/session-search.db`
- `cordis.patch.yml:22`：`D:/a/dsh/team/secretary-office/core`
- profile `package.json:6`：`link:D:/a/dsh/team/secretary-office/dsh`

换机器/用户名/仓库路径即失效。当前是原型可接受，但不应作为交付形态。

**P2：host 与 tools 的 dataDir 来源不一致。**

- host 可从 `config.dataDir` 启动核心；
- `tools.js:36` 只拿 preset 的 `{mode:'tools'}`，没有继承 `dataDir`；
- 用户一旦配置自定义数据目录，工具可能连接默认库。

**P2：回填不 flush 未闭合 turn。**

- `index.js:173-176` 使用 `flushOpen:false`；
- 实时路径有 `flush` 机制，回填路径没有；
- 中断会话的尾部内容可能丢失。

---

## 4. M2：代码完成，真实质量和控制台交互仍有缺口

### 4.1 已证实

- 规则梳理器 `summarize` 有 dry-run / confirm；
- summary、note、brief、processed 状态、summary FTS、`memory_get(S-...)` 有测试；
- CLI/API 接通；
- 控制台主面板已注册，projects 路由 200。

### 4.2 真实质量缺陷

**P1：规则梳理器“保守提取”名不副实。**

用真实 5 turn 跑 dry-run，产出两条候选 note：

```text
todo:       需要我查项目状态、拉最近进度，还是接新需求？
open_question: 1. 查档案 —— 检索项目记忆（决策、偏好、待办、未决）...
```

两者都来自助手自己的提问/能力介绍，不是用户决策或未决事项。

根因：`summarize.py:136-146` 对 assistant 句子也做 `_OPEN_RE` / `_TODO_RE` 匹配，且正则过宽。若用户直接点“确认写入”，brief 会被这些误报污染。

**P1：控制台“顾问建议”页的标记已读不存在。**

- `client.js:359` 发 `POST /office-console/api/advice/{id}/delivered`；
- `console-proxy.js:18-25` 的 `POST_ROUTES` 没有这个路由；
- `console-proxy.js:56-66` 把 `/advice/.../delivered` 只放在 GET 分支。
- 实测返回 404。

这会让 advisor 建议永远停在 `new`，并且 ES 的 brief 一直显示同一条“顾问建议”。

### 4.3 其它中等风险

- `summarize.apply` 先事务外取 pending rows，再开事务，`:343-347` 无条件更新 processed；并发 confirm 可能生成两个 summary；
- `search.py:292-295` 在 `kind=summary/note` 无结果时仍回退 `_search_turns_like`，过滤契约失效；
- `summarize.py:232` 的 `remaining` 只按 50 条上限估算，积压大时数字错误；
- `summarize.py:303-307` 写 `scope='batch'`，与文档的 day/week/milestone/manual 不一致；
- `summarize.py:320-322` 把 notes JSON 的键也写入 FTS，可能命中摘要正文里看不到的词。

---

## 5. M3：冷层与 advisor 都有代码，真实闭环不足

### 5.1 已证实

- cold 归档、cold_index、清空热字段/消息/FTS、state=cold；
- `memory_get(T...)` 冷读；
- purge 连带删冷文件；
- 测试覆盖归档、宽限期、幂等、缺文件、purge；
- advisor 已有 1 条真实建议 `A-11b64240a1`，说明 submit 链路可用。

### 5.2 真实缺陷

**P0：purge turn 不级联 summary / 关联 note / artifact，summary FTS 永久残留。**

- `recycle.py:113-136` 的 turn purge 只处理 cold、turn_fts、message、turn；
- `recycle.py:70-83` 只在软删时把 note 标 `source_deleted`，不删除；
- `summarize.py:319-322` 写 `summary_fts`，但没有 summary 的删除/清理路径。

影响：

- 用户以为 purge 已彻底删除，但 summary 正文/索引/关联笔记仍可能存在；
- 隐私边界和“回收站 purge”语义被破坏。

**P1：`session_search` 还没有真实证据。**

- `C:/Users/sakuay/.dsh/session-search.db` 当前不存在；
- advisor 的 transcript 能力尚未真正跑过；
- TASKS #32 仍是待验收。

**P1：advisor 自动提醒仍未实现。**

TASKS #28 明确待做；当前只有 `memory_brief` 末尾一行建议，不是独立通知/未读机制。

**P1：advice brief 行可能被 400 字截断吞掉。**

`search.py:539-553` 先取 brief，再追加 `顾问建议：...`，最后统一截 400；brief 接近上限时建议会消失。测试只覆盖短 brief。

**P2：冷层测试与真实数据脱节。**

真实库 `summary=0`、`cold=0`，冷层只被测试覆盖，尚未验证真实归档后搜索/读取/purge 的用户路径。

---

## 6. M4：静态编排正确，运行时仍是空的

### 6.1 静态上成立

- ES 预设挂 `gm`；GM 挂 `dm`；DM 挂 `worker`；
- `maxDepth=3` 的绝对深度语义正确；
- worker 挂 fs/run/sh/pwsh；
- 适配器目标 preset 默认包含 `secretary`、`gm`，排除 DM；
- 12 个 Node 测试覆盖 GM 收录、DM 排除和工具注册。

### 6.2 运行时没有证据

真实库中：

- 0 个 GM turn；
- 0 个 DM turn；
- 0 个 worker turn；
- `role_policy=0`；
- 没有 `task`/`report` 表。

TASKS #30 仍是待验收，README 也写“重启后检查”。**当前 M4 只是一个可选择的预设树，不是已运行的组织架构。**

### 6.3 结构性缺口

即使真实委派跑通，当前 M4 还缺原架构的关键面：

- 没有结构化 `submit_report`/报告契约；
- 没有 task/report 持久表；
- 没有角色级模型/预算/权限策略写入（role_policy 只读、0 行）；
- 没有子任务并发/写作用域/冲突处理；
- 没有完成通知/唤醒；
- 没有独立验证部门或证据复核。

如果目标是“dots 式多代理架构”，M4 目前只是**预设骨架**，不能算完成。

---

## 7. 文档与真实状态不一致

这是本次复审最明显的“表面完成度”问题：

| 文档 | 写法 | 实际 |
|---|---|---|
| `README.md:21` | 51 个 Python 测试 | 66 个 |
| `README.md:22` | 10 个 Node 测试 | 12 个 |
| `README.md:22` | 核心收录 2 条真实 turn | 5 条 |
| `dsh/README.md:108` | 2 条真实 turn | 5 条 |
| `v1-spec.md:452` | 51 tests | 66 tests |
| `v1-spec.md:484` | M3 “advisor 未开始” | 同节 `:490-494` 已写 advisor 完成 |
| `v1-spec.md:285` | `summarize --dry-run` 返回未实现 | 已实现 |
| `v1-spec.md:152-155` | cold/summary 只建表不写入 | 已写入 |
| `README.md:17` | M2 待刷新确认 | TASKS #23 已勾选截图确认 |
| `pyproject.toml:8` | 描述 M1 | 版本 `0.5.0-m4` |

另外：

- `cordis.patch.yml:2` 注释仍写 M2 console；
- README 说 advisor 建议“可标记已读”，实际 404；
- README 对 session-search 的绝对路径说明本身承认不可移植。

---

## 8. 建议的修复顺序

### P0：先修，否则不要宣称 M2/M3/M4 完成

1. **修 `advice delivered` 路由**
   - 把 `POST /advice/{id}/delivered` 加入 POST 白名单；
   - 补 proxy 200 测试。

2. **修 preset 元数据**
   - `index.js:113` 使用 `effectivePresets.get(session.id) ?? header.agentPreset`；
   - `turns.js` 的 `makeBuffer` 接收 `activePreset`；
   - 补“generic→secretary 切换段”测试，断言 payload.preset=secretary。

3. **修 purge 级联**
   - 明确 turn→summary/note/artifact 的删除策略；
   - summary 增加可清理的 source_turn 关联；
   - purge 时同步删 summary_fts、notes、artifacts；
   - 补“purge 后 summary/note/artifact 不可检索”测试。

4. **补 v4 迁移**
   - 老 v1 库迁移到 v3 后没有 `ux_turn_session_seq`；
   - 新增 v4：去重后建唯一索引；迁移测试断言索引存在。

### P1：随后修

5. 规则梳理器降低误报：todo/open_question 只从用户原话提取，过滤疑问句/能力介绍；
6. M4 真实委派验收：ES→GM→DM→worker，检查 GM turn 入库、DM/worker 不收录、报告链；
7. `session_search` 首次建库与 advisor transcript 验收；
8. 硬编码路径去本机化（`dshHomePath`、相对 coreDir、安装器生成 link）；
9. host webServer 注册改为 inject/服务事件，不以 5 秒重试为上限；
10. host/tools 统一 dataDir；
11. 20-turn soak + ES 主动调用 memory_search。

### P2：收口

12. summarize 并发抢占、`remaining`、`scope`、summary FTS JSON 键；
13. backup 空库、schema RuntimeError 友好提示、kind 回退过滤；
14. advice brief 截断、options 上限、cold 孤儿文件/校验和；
15. 文档计数与阶段状态统一。

---

## 9. 最终判断

**当前成果不是空架子，M1a 与 M1b 主链路有真实验证；但“M4 预设 + 侧栏控制台已加载”不能等同于“项目目标已完成”。**

更准确的里程碑应写成：

- M1a：完成；
- M1b：代码 + 冒烟完成，20-turn soak 与元数据修正待做；
- M2：代码 + 单测完成，规则质量与真实 confirm 待验收；
- M3：代码 + 单测完成，冷层真实路径、session_search、advisor 通知待验收；
- M4：静态预设完成，真实委派、报告契约、角色策略均未完成。

下一步建议先做 **P0 四项**，再决定是否继续扩展 M4。否则继续加角色/控制台只会把已有的数据语义问题放大。
