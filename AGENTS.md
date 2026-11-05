# AGENTS.md

简体中文回答，代码注释中文，commit message 中文。

## 干活方式

单文件改动、查询、解释 —— 自己做完，不要起 subagent。
跨文件改动、影响面不清楚 —— 先按 `prompts/plan.md` 的流程出方案（scout → planner），等我确认后再按 `prompts/implement.md` 实施。

「不要起 subagent」只免去子代理，不免去任务清单：3 步以上的活（含调研），先建 todo 再动手。

动手前先说清楚要改哪里、为什么。

## 查文档

库/框架/SDK 文档走 context7 MCP。要整段文档用 `bin/c7 docs <id> <主题> --tokens 16000`（MCP 没有 tokens 参数），429 限流时设 `CONTEXT7_API_KEY`。

## 数据库

所有库操作走 tabularis MCP（`mcp__tabularis__*`：`list_connections` → `list_tables` / `describe_table` → `run_query`），不要另找 SQL 入口。MCP 侧默认只读，写操作需要我在客户端里开。

## 改动纪律

只改任务要求改的文件。顺手发现的问题写进结论，不要顺手改。
保持文件原有风格，不重构无关代码。
计划和实际代码对不上时停下来说明，不要自行补齐。

## 收尾

说三件事：改了什么、影响谁、要不要测。
验证跑过就贴命令和结果；没跑过直说没跑，不要用"应该没问题"糊过去。
