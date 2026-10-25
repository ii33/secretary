# DSH 0.2.1-rc.3 插件兼容性检查

检查对象：`@local/dsh-office 0.5.10-m4`  
目标运行：DSH Desktop `0.2.1-rc.3`（pending installer，尚未安装成功）  
检查方式：解包 pending 安装器里的 `app.asar`，比对包版本、插件清单、服务名与配置项；本地 84 Python + 15 Node 测试。

## 结论

**静态兼容性通过，但有一个 peer 版本约束必须修。**

### 已修

`dsh/package.json` 原来：

```json
"peerDependencies": {
  "@deepseek-ai/dsh": "0.2.1-rc.2"
}
```

这是精确版本，DSH 升到 rc.3 后会被判为不兼容。已改为：

```json
"@deepseek-ai/dsh": ">=0.2.1-rc.2 <0.2.2"
```

同时版本升到 `0.5.10-m4`，DSH 更新后会重新加载。

## rc.3 中确认存在的依赖

以下包在 rc.3 中都存在，版本均为 `0.2.1-rc.3`：

- `@deepseek-ai/dsh-tool-subagent`（`maxDepth` 仍在）
- `@deepseek-ai/dsh-tool-subagent-control`（`list-agents` 导出仍在）
- `@deepseek-ai/dsh-agent-preset-registry`
- `@deepseek-ai/dsh-agent-preset`
- `@deepseek-ai/dsh-client-ui-workspace`（`openSession` 仍在）
- `@deepseek-ai/dsh-client-ui-settings`（client inject 仍存在）
- `@deepseek-ai/dsh-session-title`
- `@deepseek-ai/dsh-workspace`
- `@deepseek-ai/dsh-api-workspace-controller`
- `@deepseek-ai/dsh-session-query`

rc.3 `app.asar` 中仍能查到我们使用的服务/入口字符串：

- `systemPrompt.context`
- `agentPresets`
- `sessionController`
- `sessionQuery`
- `sessionTitle`
- `workspaceRegistry`
- `uiWorkspace`
- `maxDepth`
- `tool-subagent-control/list-agents`

## 未做/风险

- 没有把 rc.3 真正安装后跑端到端；安装器目前因 `D:\a\dsh` 被运行中的 app 锁定而回滚。
- DSH UI 的 Slot 细节（main/sidebar 面板）仍需在 rc.3 实际加载后目视确认。
- 如果 rc.3 对 client plugin 的 `immediately`/`inject` 处理有变化，可能需要在 DSH 更新后重新安装 bundle；当前 manifest 字段未被移除。

## 建议顺序

1. 先彻底退出 DSH（包括后台进程），手动安装 pending 的 rc.3；
2. 安装完成后确认 `0.2.1-rc.3` 启动；
3. 用 `plugin_manager` 重新确认 `@local/dsh-office` 已启用；
4. 打开控制台检查人员架构/角色/任务板；
5. 再跑 `npm`/Node 与 Python 测试确认回归。

当前更新失败的根因不是插件，而是安装器无法重命名被锁定的 `D:\a\dsh`；见安装器日志。
