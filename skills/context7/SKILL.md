---
name: context7
description: 用 c7 CLI 查库、框架、SDK、CLI 工具的最新官方文档与代码示例（Vue、Spring Boot、React、Prisma 等）。涉及 API 语法、配置、版本迁移、库特定的报错排查时使用，不要凭记忆回答。
---

# Context7 文档查询

CLI 在 `/home/efren/.pi/agent/bin/c7`（不在 PATH 里，用绝对路径调用）。

## 两步走：先 search 拿 id，再 docs 取正文

```bash
/home/efren/.pi/agent/bin/c7 search vue router
# /vuejs/vue-router | Vue Router | trust=9.7 bench=66 snippets=266
# /websites/router_vuejs | Vue Router | trust=10 bench=84 snippets=863

/home/efren/.pi/agent/bin/c7 docs /vuejs/vue-router navigation guards
```

```bash
/home/efren/.pi/agent/bin/c7 search spring boot
/home/efren/.pi/agent/bin/c7 docs /spring-projects/spring-boot actuator endpoints --tokens 8000
```

## 选 id 的依据

`search` 每行给出 `id | 标题 | trust=可信度 bench=文档质量 snippets=片段数`。按名字精确匹配优先，其次看 trust / bench / snippets 都高的；带版本需求时用 `search` 输出里的 `versions`，拼成 `/org/project/版本` 传给 `docs`。

## 选项

- `--tokens N`：`docs` 返回的文档规模，默认 5000；主题窄可以调小，要通读某个模块再调大。
- `--json`：`search` 输出原始 JSON（一般不需要）。
- 主题词直接跟在 id 后面，多个词用空格：`c7 docs /prisma/docs migrations in production`。

## 注意

- 匿名调用有速率限制，被限流会提示 HTTP 429；需要高频使用时设 `CONTEXT7_API_KEY` 环境变量。
- 文档接口偶尔慢（个别库 20s+），CLI 超时设的是 60s，失败会打印 HTTP 状态码并以非 0 退出。
- 查不到库时不要硬猜 id，换关键词重新 `search`（例如用 "next.js" 而不是 "nextjs"）。
- 适用范围：库/框架/SDK/CLI 的用法与配置。重构、业务逻辑调试、代码审查这类问题不需要它。
