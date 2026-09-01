---
description: 在用户已确认范围内执行 scout → planner → worker 实施流程。
---

仅当用户已经确认计划或明确授权直接实施时，针对以下需求使用 subagent 工具的 `chain` 参数：$@

如果确认的计划中没有可复用的 CBM 结果，先由当前主 Agent 通过 `cbm` skill 的命令行（`codebase-memory-mcp cli <工具>`）做一次只读 CBM 预检。预检的职责是**判断 CBM 的结论现在可不可信**，不是替 scout 做检索——固定三步，任一步不过就让 CBM 退场：

1. `list_projects` 拿项目名。**若本仓库出现多个 `root_path` 相同的项目，逐个跑 `check_index_coverage` 比较 `indexed_at` 和 `generation_matches`，选新鲜的那个**，并写明选了哪个、为什么。
2. 对计划涉及的 1-3 个路径跑 `check_index_coverage --project <项目名> --paths '<路径>'`。**禁止用 `index_status` 判覆盖**——它的 `ready` 只说明解析没报错，不代表索引跟得上当前代码。
3. 体检通过才允许追加查询，且限 `get_architecture` 和 `search_code`；`search_graph` 仅在已知英文符号名、要追调用关系时用，**禁止拿中文业务词喂 `--query`**。

体检不通过、覆盖不明、CBM 不可用或返回空 → 立刻停止 CBM，不再补搜索。纯配置、文档或 CBM 不适用时直接跳过。不得擅自安装、启动或索引项目。

将 `【CBM 预检结果】`（所选项目名与理由、索引时间与体检结论、执行过的查询、已确认路径/符号、覆盖缺口，或明确的“索引陈旧/CBM 不可用，全部走文件工具”）传入 scout。**不得把 `index_status` 的 `ready` 当成覆盖完好**；存在未索引、`parse_partial`、`skipped`、覆盖不明或空结果时，要求 scout 使用 `read`、`grep`、`find`、`ls` 兜底，不得把 CBM 空结果当成代码不存在。

1. 调用 `scout` 收集相关上下文，并对 CBM 线索做文件级核实。
2. 调用 `planner`，使用 `{previous}` 生成或核验实施计划。
3. 调用 `worker`，使用 `{previous}` 在已确认范围内实施并验证；worker 只能使用确认计划和已核实上下文，不得扩大范围。

若尚未确认，改用 `/plan`：它完成 scout → planner 后必须等待用户确认，再执行 worker。此模板不绕过 Pi 的项目信任、权限确认或操作系统安全授权。
