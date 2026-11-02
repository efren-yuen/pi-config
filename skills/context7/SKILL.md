---
name: context7
description: 用 context7（MCP）查库、框架、SDK、CLI 工具的最新官方文档与代码示例（Vue、Spring Boot、React、Prisma 等）。涉及 API 语法、配置、版本迁移、库特定的报错排查时使用，不要凭记忆回答。
---

# Context7 文档查询

默认走 MCP：`mcp__context7__resolve_library_id` → `mcp__context7__query_docs`。
需要大段文档时用 CLI `/home/efren/.pi/agent/bin/c7 docs <id> <主题> --tokens 16000`（MCP 没有 tokens 参数）。

## 两步走

```js
// 1. 拿 id
const r = await tools.mcp__context7__resolve_library_id({ libraryName: "Vue Router", query: "navigation guards" });
text(r.content.map((c) => c.text).join("\n"));

// 2. 取文档
const d = await tools.mcp__context7__query_docs({ libraryId: "/vuejs/vue-router", query: "navigation guards" });
text(d.content.map((c) => c.text).join("\n"));
```

- 工具名是**下划线**：`resolve_library_id`、`query_docs`，不是 `resolve-library-id`。
- `resolve_library_id` 的 `query` 必填，写清“要用它做什么”，比只给库名准。
- `query_docs` 可选 `language`（如 `"TypeScript"`），同语言示例排前。
- 库名用官方写法：`Next.js` 而不是 `nextjs`。

## 选 id 的依据

返回里有 `Code Snippets`、`Source Reputation`（High/Medium/Low）、`Benchmark Score`。
名字精确匹配优先，其次看三者都高的。需要特定版本时把版本拼进 id：`/org/project/版本`（版本列表要用 CLI `c7 search` 才看得到）。

## 什么时候用 CLI

- 要通读某个模块、拉大段文档：`c7 docs /vuejs/vue-router navigation guards --tokens 16000`
- 要找版本列表：`c7 search vue router`
- MCP 被限流（429）：CLI 走同一后端，配 `CONTEXT7_API_KEY` 可提额

## 注意

- 匿名调用有速率限制，被限流会提示 429；高频用时设 `CONTEXT7_API_KEY`。
- 文档接口偶尔慢（个别库 20s+），MCP 的 timeout 是 60s。
- 查不到库时不要硬猜 id，换关键词重新 resolve（例如用 "next.js" 而不是 "nextjs"）。
- 适用范围：库/框架/SDK/CLI 的用法与配置。重构、业务逻辑调试、代码审查这类问题不需要它。
