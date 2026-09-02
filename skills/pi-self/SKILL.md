---
name: pi-self
description: 修改 pi 自身配置时使用（~/.pi/agent 下的 bin/、skills/、agents/、extensions/、settings.json）。包含几处必须同步改动的位置，以及改完之后的生效条件。
---

# 维护 pi 自身

`~/.pi/agent` 有几处隐性耦合，改错顺序会表现成「改了但没生效」。

## 改 CLI 调用形式 → 三处必须同步

动了 `bin/c7`、`bin/web`、`bin/lsp` 的子命令或选项，以下三处都要跟着改：

1. `skills/<name>/SKILL.md` 的命令清单
2. `agents/scout.md` 和 `agents/reviewer.md` 里的可用命令列表
3. `extensions/permission-gate.ts` 的子命令与选项白名单

漏任何一处，subagent 调用时就会拿到 `Denied`。

## 改完 bin/lsp 必须 `lsp stop`

语言服务器由常驻 daemon 托管，不停掉它还在跑旧代码。这是最容易浪费时间的一条。

## 动 LSP 协议层前后都跑测试

```bash
node /home/efren/.pi/agent/lsp/test/protocol-test.js
```

假语言服务器 + 20 条断言，覆盖分帧、握手、**服务器→客户端请求必须全部被应答**（漏答会让服务器静默挂起，表现成客户端超时）、文档重开、按符号定位。

## settings.json 改完先校验语法

```bash
python3 -c "import json; json.load(open('/home/efren/.pi/agent/settings.json')); print('OK')"
```

语法错会静默丢配置，重启会话前先过一遍。

## 扩展是 .ts，走 node 的 type-stripping

`extensions/*.ts` 不经编译直接加载，只能用可以纯剥离类型的语法。不要用 enum、namespace、构造器参数属性、装饰器。

## registerTool 类扩展不过 permission-gate

网关只挂在 `tool_call`（write/edit/read/grep/find/ls/bash/powershell）和 `user_bash` 上。
扩展用 `pi.registerTool()` 注册的工具**完全不经过它**——`bin/web` 那套「交互放行、subagent 拒绝」
的分流对自定义工具无效。

所以新增这类工具时，两件事必须自己做：

1. 在 `execute` 里判 `ctx.hasUI`（print/json 模式为 `false`，subagent 走 `--mode json -p`），
   需要限交互的能力自己返回错误。
2. 确认哪些 agent 会继承到它。`extensions/subagent/index.ts:307` 只有在 agent 声明了
   `tools:` 时才传 `--tools`（严格白名单，扩展工具一并挡掉）；**不声明 `tools:` 的 agent
   会拿到全部内置工具 + 全部扩展工具**，包括 `subagent` 自己（可递归）。四个 agent 现在都声明了。

（历史：`extensions/external-agents.ts` 桥接 claude/codex 就是踩了这两条，已删除。）

## extensions/subagent 是上游 example 的分叉

`extensions/subagent/` 复制自 pi 自带的
`/usr/lib/node_modules/pi/packages/coding-agent/examples/extensions/subagent/`。
`agents.ts` 与上游完全一致；`index.ts` 只改了两处 tool description 文案
（澄清 `{previous}` 必须字面写、说明 parallel/chain 按数据依赖选）。

`pi update` 之后上游修的 bug 不会自动进来，而且没有任何提示。升级后查一次漂移：

```bash
diff -u /usr/lib/node_modules/pi/packages/coding-agent/examples/extensions/subagent/index.ts \
        ~/.pi/agent/extensions/subagent/index.ts
```

只看到那两个 hunk 就是没漂；多出别的说明上游改了，需要手工合。

## 新能力写 skill + CLI，不装 MCP server

pi 已经彻底去掉 MCP。要加外部能力就写一个 CLI 放 `bin/`，配一份 SKILL.md 说明用法，再进网关白名单。

注意「调用某个 MCP 端点」和「挂一个 MCP server」是两回事——前者一个 HTTP POST 就够，不需要跑进程。

## bin/ 下有两类文件，只有一类能删

pi 托管的（**不要删**）：`fd`、`rg`。

内置 `find` 工具的实现就是 fd（`core/tools/find.js`），拿不到 fd 就抛 `fd is not available and could not be downloaded`。查找顺序是 `bin/<name>` → 系统 PATH（`fd` 认 `fdfind`）→ 从 GitHub 下载最新 release，交互模式启动时还会 `ensureTool()` 预热一次。本机没装对应系统包时，删掉就会在下次启动重新下一遍。

`find` 属于只读工具集（`createReadOnlyTools`）。pi 写死的默认集是 read/bash/edit/write（`dist/core/sdk.js:139`），不含 find；本机在 `settings.json` 的 `defaultTools` 里补上了 grep/find/ls，四个 agent 也都在 `tools:` 里声明了 `find`，**所以主 Agent 和全部 subagent 都依赖 fd**。

自写的（可以删，但要连带清理）：`c7`、`web`、`lsp`。删之前先按上面「三处同步」把 skill、agents、permission-gate 白名单一起处理掉。

判断某个二进制是不是 pi 托管的，看 `utils/tools-manager.js` 的 `TOOLS` 表，不要靠「是否在 PATH」或「是否在网关白名单」推断——内置工具（find/read/grep 等）不走 bash，网关对它们只做凭据路径拦截，不查命令白名单。
