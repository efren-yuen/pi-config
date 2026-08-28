---
description: 只读执行 scout → planner，输出计划并等待用户确认，不实施。
---

针对以下需求使用 subagent 工具的 `chain` 参数：$@

在调用 subagent chain 之前，当前主 Agent 先做一次只读 CBM 预检：

- 仅对代码、依赖、调用关系、架构或变更影响相关任务使用 CBM；纯配置、文档或 CBM 不擅长的内容可直接使用文件工具。
- CBM 通过 `cbm` skill 的命令行使用（`codebase-memory-mcp cli <工具>`），按需选择 `get_architecture`、`search_graph`、`trace_path`、`detect_changes`、`check_index_coverage` 等只读查询；不得为了使用 CBM 擅自安装、启动或索引项目。
- 检查索引覆盖。遇到未索引、`parse_partial`、`skipped`、覆盖范围不明或空结果时，不得把它当成“代码不存在”，后续交给 scout 用 `read`、`grep`、`find`、`ls` 兜底。
- 将精简结果以 `【CBM 预检结果】` 传入 scout，至少包含已确认的路径/符号、关键关系、使用的查询类型和覆盖缺口；CBM 不可用时明确写“CBM 不可用”，不要编造结果。

然后按以下顺序执行：

1. 调用 `scout`，只读收集所有相关上下文，并结合主 Agent 传入的 CBM 结果做文件级核实。
2. 调用 `planner`，将 scout 输出通过 `{previous}` 传入，生成实施计划；要求 planner 同时考虑 CBM 结果和文件工具核实结果。

只执行这两个步骤，绝不调用 worker、绝不修改文件。返回计划后必须明确等待用户确认；只有用户在后续消息中确认该计划，才可执行 worker。CBM 预检、scout 和 planner 都必须保持只读。此模板仅定义协作流程，不能替代 Pi 的项目信任、权限确认或操作系统安全授权。
