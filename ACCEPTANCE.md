# 验收记录（2026-10-25 14:10）

> 环境：DSH 未运行；手动起核心（端口 49632）跑只读验收，跑完已停并清理 `core.json`。

## 环境检查（`doctor`）

| 项 | 结果 |
|---|---|
| python | 3.13.14 |
| sqlite | 3.53.1 |
| fts5 | ok |
| data_dir | `C:/Users/sakuay/.secretary-office` 可写 |
| core.db | 262144 字节 |

启动时自动补建 `artifact`、`role_policy` 两张表，FTS 索引 9 条。

## 只读 API（全部 200）

| 端点 | 结果 |
|---|---|
| `/v1/health` | `{status: ok}` |
| `/v1/projects` | team(9) + default-workspace(2) |
| `/v1/stats?project=team` | turns 6 / hot_raw 6 / cold 3 / notes 1 / advice 0 |
| `/v1/search?q=任务` | **4 条**，带 snippet（bigram 生效） |
| `/v1/search?q=窗口` | 0 条（team 无此词） |
| `/v1/search?q=测试&scope=all` | **5 条**，kinds=[note, cold, cold]（冷层慢搜生效） |
| `/v1/cold?project=team` | 3 |
| `/v1/audit` | 0（尚无删/还原操作） |
| `/v1/artifacts?project=team` | 0 |
| `/v1/roles?project=team` | 0 |
| `/v1/brief?project=team` | 真实简报（含最近记忆） |
| `/v1/advice?project=team` | 1 |
| `/v1/taskboard` / `/v1/conventions` | 0 / 0 |
| `/v1/agent-names?project=team` | `{}` |

## 日志

新格式生效：

```
2026-10-25 14:10:40,054 INFO core listening on 127.0.0.1:49632 data_dir=C:/Users/sakuay/.secretary-office
```

## 迁移 dry-run

```
notes: 1 行 → 迁移 1 行
advice: 1 行 → 迁移 1 行
audit: 6 行 → 迁移 6 行
project/session/message：由 turns.project + 会话日志回填表达，无需迁移
turns: 11 行（回填）
```

## 数据库最终表（12 + 3 FTS）

```
advice, agent_name, artifact, audit, brief, cold_index, conventions,
notes, project_preset, raw_event, role_policy, summaries, taskboard, turns
+ note_fts, summary_fts, turn_fts
```

## 结论

**P0–P4 全部通过验收。** 用户下次打开 DSH 会自动起新核心，复用这套代码。

## 待用户确认（需要开 DSH 才能看）

1. 人员架构树是否正常（ES/顾问/普通并列，GM→DM→worker 子代理，归档会话已过滤）
2. 控制台 6 标签 + 记忆管理 5 子标签是否正常切换
3. 任务板/约定/项目预设/顾问建议的交互
4. 真实会话跑一轮，确认自动收录（ES 热 / GM 冷 / 其他不收录）与简报注入
