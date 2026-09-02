---
description: 只读执行 scout → planner，输出计划并等待用户确认，不实施。
---

针对以下需求使用 subagent 工具的 `chain` 参数：$@

在调用 subagent chain 之前，当前主 Agent 先按 `cbm` skill 的「三步预检」做一次只读体检
（`codebase-memory-mcp cli list_projects` → `check_index_coverage` → 体检通过才追加 `get_architecture` / `search_code`）。
规则和禁忌以 skill 为准，这里不重复；体检不过、覆盖不明、CBM 不可用或返回空就立刻停止 CBM，把检索完整交给 scout。

把 `【CBM 预检结果】`（内容清单见 `cbm` skill）传入 scout。存在未索引、`parse_partial`、`skipped`、
覆盖不明或空结果时，要求 scout 用 `read`、`grep`、`find`、`ls` 兜底，不得把 CBM 空结果当成代码不存在。

然后按以下顺序执行：

1. 调用 `scout`，只读收集所有相关上下文，并结合主 Agent 传入的 CBM 结果做文件级核实。
2. 调用 `planner`，将 scout 输出通过 `{previous}` 传入，生成实施计划；要求 planner 同时考虑 CBM 结果和文件工具核实结果。

只执行这两个步骤，绝不调用 worker、绝不修改文件。返回计划后必须明确等待用户确认；只有用户在后续消息中确认该计划，才可执行 worker。CBM 预检、scout 和 planner 都必须保持只读。此模板仅定义协作流程，不能替代 Pi 的项目信任、权限确认或操作系统安全授权。
