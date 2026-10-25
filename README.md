# 秘书办公室（secretary-office）

> 2026-10-25 从 `D:\a\dsh\team\` 被 DSH 更新误删后的恢复重建。
> **文档 + 测试为原文件恢复**；**源码为按测试契约重建**（功能等价，非逐字原版）。

## 目录结构

```
secretary-office/
├── core/                        # Python 核心（独立进程，仅用标准库）
│   ├── pyproject.toml           # 包配置（secretary-core 0.5.10-m4）
│   └── secretary_core/
│       ├── __init__.py
│       ├── cli.py               # 入口：serve --data-dir <dir>
│       ├── db.py                # SQLite 持久层（turns/notes/taskboard/conventions/advice/summaries）
│       ├── server.py            # 本地 HTTP REST（/v1/*）
│       └── schema.sql           # 数据库 schema
├── plugin/                      # DSH 插件（@local/dsh-office）
│   ├── package.json
│   ├── index.js                 # 宿主适配器 apply(ctx,{coreDir,dataDir})
│   ├── tools.js                 # 按角色注册工具 apply(ctx,{dataDir,role})
│   ├── client.js                # UI 模块（控制台面板 + 侧栏）
│   ├── lib/
│   │   ├── core.js              # CoreManager / pythonCandidates
│   │   ├── client.js            # CoreClient
│   │   ├── console-proxy.js     # /office-console/api 白名单代理
│   │   ├── project.js           # projectForCwd / readProjectConfig
│   │   └── turns.js             # TurnBuffer / eventsToEnvelopes
│   └── test/                    # 7 个 Node 测试（API 契约，原文件）
├── docs/                        # 13 个设计文档（原文件）
└── fixtures/events.jsonl        # 测试数据（原文件）
```

## 运行

### Python 核心
```bash
cd core
python -m secretary_core.cli serve --data-dir "%USERPROFILE%\.secretary-office"
```
启动后监听 127.0.0.1:<随机端口>，并把端口写入 `<data-dir>/.run/core.json`。

### 测试
```bash
cd plugin
node --test test/*.test.mjs
```

## 核心概念

| 概念 | 说明 |
|---|---|
| turn | 一次用户↔助手的完整对话，落库后可检索 |
| note | 持久记忆条目（`N-` 前缀） |
| taskboard | 项目任务板（`T-` 前缀） |
| convention | 项目约定（`C-` 前缀） |
| advice | 顾问建议（`A-` 前缀）；采纳后转成一条 turn |
| summary | 批量摘要（`S-` 前缀） |
| project | 由 `<workspace>/.dsh/office.json` 的 `project` 字段决定，缺省用目录名 |

## 角色工具

- **secretary**：13 个工具（记忆读写 + 任务板 + 约定）
- **advisor**：只读 + `submit_advice`
- **gm / dm**：只读（`taskboard_read`、`convention_read`）

## 重要提醒

**不要把这个项目放回 `D:\a\dsh\`** —— 那是 DSH 安装目录，electron-builder 更新时会整体替换并删除非清单文件，这正是本次数据丢失的原因。建议放在独立目录并纳入 git。

## 许可证

[MIT](LICENSE) © 2026 ii33
