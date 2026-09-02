---
description: 在用户已确认范围内执行 scout → planner → worker 实施流程。
---

仅当用户已经确认计划或明确授权直接实施时，针对以下需求使用 subagent 工具的 `chain` 参数：$@

如果确认的计划中没有可复用的 CBM 结果，先由当前主 Agent 按 `cbm` skill 的「三步预检」做一次只读体检
（`codebase-memory-mcp cli list_projects` → `check_index_coverage` → 体检通过才追加 `get_architecture` / `search_code`）。
规则和禁忌以 skill 为准，这里不重复；体检不过、覆盖不明、CBM 不可用或返回空就立刻停止 CBM，不再补搜索。
纯配置、文档或 CBM 不适用时直接跳过。

把 `【CBM 预检结果】`（内容清单见 `cbm` skill）传入 scout。存在未索引、`parse_partial`、`skipped`、
覆盖不明或空结果时，要求 scout 用 `read`、`grep`、`find`、`ls` 兜底，不得把 CBM 空结果当成代码不存在。

1. 调用 `scout` 收集相关上下文，并对 CBM 线索做文件级核实。
2. 调用 `planner`，使用 `{previous}` 生成或核验实施计划。
3. 调用 `worker`，使用 `{previous}` 在已确认范围内实施并验证；worker 只能使用确认计划和已核实上下文，不得扩大范围。

若尚未确认，改用 `/plan`：它完成 scout → planner 后必须等待用户确认，再执行 worker。此模板不绕过 Pi 的项目信任、权限确认或操作系统安全授权。
