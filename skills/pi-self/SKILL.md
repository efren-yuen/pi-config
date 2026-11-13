---
name: pi-self
description: 维护 ~/.pi/agent 全局配置、CLI、技能和扩展时使用，包含同步检查、验证与生效要求。
---

# 维护 Pi 全局配置

以下配置路径均相对 `~/.pi/agent/`，命令使用完整路径。

## CLI 同步与工具依赖

- 修改或删除 CLI 时，检索 `AGENTS.md`、`skills/`、`agents/`、`prompts/`、`extensions/` 中的实际引用，只同步受影响处，不固定“两处”或“三处”。
- `fd`、`rg` 是 Pi 的工具依赖，不作为自写脚本随意删除；不要仅凭文件是否在 `bin/` 或 PATH 中判断归属。
- 权限网关不维护 CLI 命令白名单，新增 CLI 不需要添加白名单。

## LSP 维护

- 配置只认内置默认与全局 `lsp/servers.json`，不读取项目 `.pi/lsp.json`。
- 修改 `bin/lsp` 后先停止旧 daemon，下一次调用才会加载新代码；停止会影响其他会话正在使用的实例：

```bash
~/.pi/agent/bin/lsp stop
```

- 修改 LSP 协议层前后都运行：

```bash
node ~/.pi/agent/lsp/test/protocol-test.js
```

## 配置验证与生效

- 修改 JSON 后先验证语法，例如：

```bash
python3 -m json.tool ~/.pi/agent/settings.json >/dev/null
```

- 修改配置、技能或扩展后执行 `/reload`；验证默认加载效果时使用新会话。LSP daemon 按上一节单独停止。

## 扩展权限与工具范围

- `extensions/permission-gate.ts` 是按工具名称和类型执行检查的黑名单，不是沙箱；新扩展工具不会自动获得所有路径和命令保护，必须检查权限处理、非交互行为及 subagent 可见范围。
- 需要交互的操作自行检查上下文是否支持 UI；无 UI 时不得假定能弹窗确认。
- agent 应显式声明 `tools:`。`--tools` 默认仍保留 MCP 工具，不能据此认定 MCP 已被排除；需要限制时检查 MCP 专用过滤规则。

## subagent 分叉维护

`extensions/subagent/` 是上游示例的本地分叉，不会随 Pi 升级自动合并修复。升级后比较上游差异，再决定同步内容，不以固定差异数量判断是否过时。例如：

```bash
diff -u /usr/lib/node_modules/pi/packages/coding-agent/examples/extensions/subagent/index.ts \
        ~/.pi/agent/extensions/subagent/index.ts
```

## MCP 约定

- CBM 只通过 MCP 使用，不恢复 CLI 调用指令或独立技能。
- 本机全局 `mcp.json` 定义公共服务并默认关闭；需要的项目在 `.pi/mcp.json` 中用同名服务设置 `enabled: true`，无需重复命令配置。
- 项目配置在获得项目信任后加载；启用服务不等于跳过权限检查和人工确认。
