---
description: 已有确认计划时只调 worker 实施；无确认计划时先 scout → planner 再实施。
---

针对以下需求实施：$@

先判定走哪条路径。判定标准从严：必须本次会话内 `/plan` 已返回过计划，且用户在随后的消息中明确确认（带修改意见的确认也算）。只要有任何不确定，一律走路径 B。

## 路径 A：已有用户确认的计划

跳过 CBM 预检——计划已基于预检结果产出，不重复。

用 subagent 工具的 single 模式调用 `worker`（`agent: "worker"`），不要用 `chain`。task 中必须包含：

1. 用户确认的那份计划**逐字原文**。worker 是独立进程，看不到本会话，概括、删减或重排等于丢失变更点。
2. 用户确认时附加的修改意见（若有），并说明它覆盖原计划的哪一条。
3. 本次需求原文。

不得调用 scout，不得调用 planner，不得重新生成计划。worker 只能在这份确认计划的范围内实施并验证，不得扩大范围。

## 路径 B：无确认计划，用户明确授权直接实施

先由当前主 Agent 按 `cbm` skill 的「三步预检」做一次只读体检
（`codebase-memory-mcp cli list_projects` → `check_index_coverage` → 体检通过才追加 `get_architecture` / `search_code`）。
规则和禁忌以 skill 为准，这里不重复；体检不过、覆盖不明、CBM 不可用或返回空就立刻停止 CBM，不再补搜索。
纯配置、文档或 CBM 不适用时直接跳过。

把 `【CBM 预检结果】`（内容清单见 `cbm` skill）传入 scout。存在未索引、`parse_partial`、`skipped`、
覆盖不明或空结果时，要求 scout 用 `read`、`grep`、`find`、`ls` 兜底，不得把 CBM 空结果当成代码不存在。

用 subagent 工具的 `chain` 参数按以下顺序执行：

1. 调用 `scout` 收集相关上下文，并对 CBM 线索做文件级核实。
2. 调用 `planner`，使用 `{previous}` 生成实施计划。
3. 调用 `worker`，使用 `{previous}` 在计划范围内实施并验证，不得扩大范围。

若尚未确认也没有明确授权，改用 `/plan`：它完成 scout → planner 后必须等待用户确认。此模板不绕过 Pi 的项目信任、权限确认或操作系统安全授权。
